import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAllChecks, type CheckResult } from "../../src/diag/checks.js";

/**
 * D8-4 — `dexe_doctor` told the calling model "Read-only: never broadcasts,
 * never writes" while POSTing a real, permanent pin to the user's Pinata
 * account on EVERY call. Since 0.34.0 the probe is opt-in (`--probe-pin` /
 * `probePin:true`), labels the write in its own message, and cleans up after
 * itself. When it is off it emits NO row: a synthetic "not probed" PASS would
 * inflate summary.passed with a verification that never happened, which is the
 * exact F3 pattern the probe was added to kill.
 */

const JWT = "test-jwt-value";
const ENV_KEYS = ["DEXE_PINATA_JWT", "DEXE_IPFS_GATEWAY"] as const;

interface Call {
  url: string;
  method: string;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return handler(url, init ?? {});
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const byId = (rs: CheckResult[], id: string) => rs.find((r) => r.id === id);

describe("pinata pin-capability probe", () => {
  const original: Record<string, string | undefined> = {};
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    delete process.env.DEXE_IPFS_GATEWAY; // keep the suite off the network
    realFetch = globalThis.fetch;
    process.env.DEXE_PINATA_JWT = JWT;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("does not pin by default, and points at the flag from the jwt row", async () => {
    const calls = mockFetch(() => json({ message: "ok" }));
    const rs = await runAllChecks({ timeoutMs: 100 });

    expect(calls.filter((c) => /pinJSONToIPFS/.test(c.url))).toEqual([]);
    expect(byId(rs, "pinata.pinQuota")).toBeUndefined();

    const jwtRow = byId(rs, "pinata.jwt")!;
    expect(jwtRow.status).toBe("pass");
    expect(jwtRow.remediation).toMatch(/--probe-pin/);
    expect(jwtRow.remediation).toMatch(/403/);
  });

  /** The assertion that would have caught the original defect. */
  it("performs no write of any kind against Pinata under the default options", async () => {
    const calls = mockFetch(() => json({ message: "ok" }));
    await runAllChecks({ timeoutMs: 100 });

    const writes = calls.filter(
      (c) => /api\.pinata\.cloud/.test(c.url) && (c.method === "POST" || c.method === "DELETE"),
    );
    expect(writes).toEqual([]);
  });

  it("probePin pins once, unpins it again, and says so", async () => {
    const calls = mockFetch((url) => {
      if (/pinJSONToIPFS/.test(url)) return json({ IpfsHash: "bafyprobe" });
      if (/pinning\/unpin\//.test(url)) return new Response("OK", { status: 200 });
      return json({ message: "ok" });
    });
    const rs = await runAllChecks({ timeoutMs: 100, probePin: true });

    expect(calls.filter((c) => /pinJSONToIPFS/.test(c.url))).toHaveLength(1);
    const unpins = calls.filter((c) => /pinning\/unpin\/bafyprobe/.test(c.url));
    expect(unpins).toHaveLength(1);
    expect(unpins[0]!.method).toBe("DELETE");

    const row = byId(rs, "pinata.pinQuota")!;
    expect(row.status).toBe("pass");
    expect(row.message).toMatch(/wrote one tiny pin/);
    expect(row.message).toMatch(/removed it again/);
  });

  it("a failed cleanup never turns into a check failure", async () => {
    mockFetch((url) => {
      if (/pinJSONToIPFS/.test(url)) return json({ IpfsHash: "bafyprobe" });
      if (/pinning\/unpin\//.test(url)) return json({ error: "forbidden" }, 401);
      return json({ message: "ok" });
    });
    const rs = await runAllChecks({ timeoutMs: 100, probePin: true });

    const row = byId(rs, "pinata.pinQuota")!;
    expect(row.status).toBe("pass");
    expect(row.message).toMatch(/removing it failed/);
  });

  /** F3 preserved verbatim: a plan-usage block is still a hard failure. */
  it("a 403 on the pin is a failure that names the plan-usage block", async () => {
    mockFetch((url) => {
      if (/pinJSONToIPFS/.test(url)) return json({ error: "Account blocked due to plan usage limit" }, 403);
      return json({ message: "ok" });
    });
    const rs = await runAllChecks({ timeoutMs: 100, probePin: true });

    const row = byId(rs, "pinata.pinQuota")!;
    expect(row.status).toBe("fail");
    expect(row.remediation).toMatch(/plan usage/);
  });

  it("no JWT means no pinata row and no Pinata call, even with probePin", async () => {
    delete process.env.DEXE_PINATA_JWT;
    const calls = mockFetch(() => json({ message: "ok" }));
    const rs = await runAllChecks({ timeoutMs: 100, probePin: true });

    expect(rs.filter((r) => r.id.startsWith("pinata."))).toEqual([]);
    expect(calls.filter((c) => /api\.pinata\.cloud/.test(c.url))).toEqual([]);
  });
});
