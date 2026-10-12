import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyCapped, readBodyHead } from "../../src/lib/boundedBody.js";
import {
  DEFAULT_IPFS_MAX_BYTES,
  fetchIpfs,
  IpfsTooLargeError,
  resolveIpfsMaxBytes,
} from "../../src/lib/ipfs.js";
import { RequestCancelledError, runWithRequestSignal } from "../../src/lib/requestScope.js";

/**
 * Security review of #93, finding 1: `fetchIpfs` buffered the whole body with
 * `res.arrayBuffer()`, and a dag-pb CID (`Qm…`) is not hash-checked, so any
 * size passed — three parallel 600 MB fetches took the server to 3.2 GB RSS.
 *
 * These run against a real local HTTP server that streams an endless body, so
 * "the read stopped at the cap" is measured on the wire (bytes the server got
 * to write before the client hung up), not inferred from a mock.
 */

// A dag-pb CIDv0: not hash-verifiable here, so only the byte cap stands between
// a gateway and memory.
const DAG_PB_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

interface Upstream {
  url: string;
  hits: string[];
  /** Bytes written to each response before it finished or the client went away. */
  written: number[];
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, record: (n: number) => void) => void;

async function upstream(handler: Handler): Promise<Upstream> {
  const hits: string[] = [];
  const written: number[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const slot = written.push(0) - 1;
    handler(req, res, (n) => {
      written[slot] = (written[slot] ?? 0) + n;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    written,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Stream 64 KB chunks until the client disconnects (or `limit` bytes). */
function endless(contentLength?: number, limit = 1024 * 1024 * 1024): Handler {
  return (_req, res, record) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      ...(contentLength !== undefined ? { "content-length": String(contentLength) } : {}),
    });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < limit) {
        if (res.destroyed || res.writableEnded) return;
        sent += chunk.length;
        record(chunk.length);
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    res.on("close", () => undefined);
    pump();
  };
}

const servers: Upstream[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  delete process.env.DEXE_IPFS_MAX_BYTES;
});

describe("readBodyCapped", () => {
  it("stops reading a chunked body at the cap and releases the connection", async () => {
    const up = await upstream(endless());
    servers.push(up);
    const res = await fetch(`${up.url}/big`);
    await expect(readBodyCapped(res, 256 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    // Give the server a beat to notice the disconnect.
    await new Promise((r) => setTimeout(r, 100));
    // The socket buffers a little past the cap; nowhere near the gigabyte on offer.
    expect(up.written[0]!).toBeLessThan(16 * 1024 * 1024);
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const up = await upstream(endless(600 * 1024 * 1024));
    servers.push(up);
    const res = await fetch(`${up.url}/declared`);
    const err = await readBodyCapped(res, 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect((err as BodyTooLargeError).declared).toBe(600 * 1024 * 1024);
  });

  it("returns a body under the cap byte for byte", async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "Glacier", n: 1 }));
    });
    servers.push(up);
    const bytes = await readBodyCapped(await fetch(`${up.url}/small`), 1024);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ name: "Glacier", n: 1 });
  });

  it("readBodyHead takes only the head of a body whose server ignores Range", async () => {
    const up = await upstream(endless());
    servers.push(up);
    const head = await readBodyHead(await fetch(`${up.url}/img`), 1024);
    expect(head.byteLength).toBe(1024);
  });
});

describe("fetchIpfs byte cap", () => {
  it("defaults to 2 MB and honours DEXE_IPFS_MAX_BYTES (clamped)", () => {
    expect(resolveIpfsMaxBytes({})).toBe(DEFAULT_IPFS_MAX_BYTES);
    expect(DEFAULT_IPFS_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(resolveIpfsMaxBytes({ DEXE_IPFS_MAX_BYTES: "4096" })).toBe(4096);
    expect(resolveIpfsMaxBytes({ DEXE_IPFS_MAX_BYTES: "1" })).toBe(1024);
    expect(resolveIpfsMaxBytes({ DEXE_IPFS_MAX_BYTES: "lots" })).toBe(DEFAULT_IPFS_MAX_BYTES);
  });

  it("an endless dag-pb body stops at the cap, and no other gateway is asked for the same CID", async () => {
    const big = await upstream(endless());
    const second = await upstream((_req, res) => res.end("{}"));
    servers.push(big, second);
    const err = await fetchIpfs(DAG_PB_CID, { gateways: [big.url, second.url], maxBytes: 512 * 1024 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IpfsTooLargeError);
    const msg = (err as Error).message;
    expect(msg).toContain("IPFS content too large");
    expect(msg).toContain("DEXE_IPFS_MAX_BYTES");
    expect(second.hits).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(big.written[0]!).toBeLessThan(16 * 1024 * 1024);
  });

  it("a declared 600 MB body is refused from its headers", async () => {
    const up = await upstream(endless(600 * 1024 * 1024));
    servers.push(up);
    process.env.DEXE_IPFS_MAX_BYTES = "65536";
    const err = await fetchIpfs(DAG_PB_CID, { gateways: [up.url] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpfsTooLargeError);
    expect((err as Error).message).toContain("600 MB");
  });

  it("a cancelled request tries no further gateway", async () => {
    // The first gateway never answers; the caller cancels while it hangs.
    const hang = await upstream(() => undefined);
    const second = await upstream((_req, res) => res.end("{}"));
    servers.push(hang, second);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const err = await runWithRequestSignal(ctrl.signal, () =>
      fetchIpfs(DAG_PB_CID, { gateways: [hang.url, second.url], perRequestTimeoutMs: 5_000 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestCancelledError);
    expect(hang.hits.length).toBe(1);
    expect(second.hits).toEqual([]);
  });

  it("names gateways by host only in the failure list", async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(500);
      res.end("down");
    });
    servers.push(up);
    const gw = `${up.url}/tenant/sk_live_0123456789abcdefghij`;
    const err = await fetchIpfs(DAG_PB_CID, { gateways: [gw] }).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toContain(`${new URL(up.url).host} → HTTP 500`);
    expect(msg).not.toContain("sk_live_0123456789abcdefghij");
    expect(msg).not.toContain("/tenant");
  });
});
