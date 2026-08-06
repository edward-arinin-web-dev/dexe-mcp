import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createDegradedServer,
  formatCrashReport,
  installProcessGuards,
  installTransportGuards,
  isTransportGoneError,
} from "../src/index.js";

/**
 * 0.30.4 "nothing hangs". 0.30.1 removed silent death from the *startup* path;
 * it was still there on the *running* path — Node exits on an unhandled
 * rejection and on an uncaught exception, and an MCP host renders that as
 * "server disconnected" with no reason attached. The user loses the tools AND
 * the explanation, which is the worst possible pairing.
 *
 * The unit tests below drive the handlers through injected seams (no real
 * process is touched). The live test at the bottom spawns a real child,
 * because "Node keeps running" is the one claim a fake emitter cannot make.
 */

const KEYED_RPC = "https://bsc-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY_42";

/** Minimal stand-in for `process` that records what was registered. */
function fakeEmitter() {
  const handlers = new Map<string, Array<(...a: never[]) => void>>();
  return {
    on(event: string, listener: (...a: never[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
    },
    events: () => [...handlers.keys()],
  };
}

function harness() {
  const emitter = fakeEmitter();
  const lines: string[] = [];
  const exits: number[] = [];
  installProcessGuards({
    emitter,
    write: (l) => void lines.push(l),
    exit: (c) => void exits.push(c),
  });
  return { emitter, lines, exits, text: () => lines.join("") };
}

describe("isTransportGoneError", () => {
  it("is true only for a dead stdio pipe", () => {
    expect(isTransportGoneError(Object.assign(new Error("write"), { code: "EPIPE" }))).toBe(true);
    expect(
      isTransportGoneError(Object.assign(new Error("gone"), { code: "ERR_STREAM_DESTROYED" })),
    ).toBe(true);
  });

  it("is false for ordinary failures, which the server must survive", () => {
    expect(isTransportGoneError(new Error("CALL_EXCEPTION"))).toBe(false);
    expect(isTransportGoneError(Object.assign(new Error("net"), { code: "ECONNRESET" }))).toBe(false);
    expect(isTransportGoneError(undefined)).toBe(false);
    expect(isTransportGoneError(null)).toBe(false);
    expect(isTransportGoneError("a string throw")).toBe(false);
  });
});

describe("formatCrashReport", () => {
  it("says the server survived, so the user retries instead of restarting", () => {
    const report = formatCrashReport("unhandled promise rejection", new Error("boom"), false);
    expect(report).toContain("STILL RUNNING");
    expect(report).toContain("boom");
  });

  it("says it is shutting down only when the channel is actually gone", () => {
    const report = formatCrashReport("uncaught exception", new Error("pipe"), true);
    expect(report).toContain("shutting down");
    expect(report).not.toContain("STILL RUNNING");
  });

  it("redacts the credentialed RPC URL ethers appends on a 401", () => {
    const report = formatCrashReport("x", new Error(`server response 401 (url=${KEYED_RPC})`), false);
    expect(report).not.toContain("SUPER_SECRET_KEY_42");
    expect(report).toContain("https://bsc-mainnet.g.alchemy.com/***");
  });
});

describe("installProcessGuards", () => {
  it("registers the three process-level channels", () => {
    const { emitter } = harness();
    expect(emitter.events().sort()).toEqual(["uncaughtException", "unhandledRejection", "warning"]);
  });

  it("reports an unhandled rejection and keeps the process alive", () => {
    const h = harness();
    h.emitter.emit("unhandledRejection", new Error("nobody awaited me"));
    expect(h.text()).toContain("unhandled promise rejection");
    expect(h.text()).toContain("nobody awaited me");
    expect(h.exits).toEqual([]); // the whole point
  });

  it("reports a non-Error rejection reason without printing [object Object]", () => {
    const h = harness();
    h.emitter.emit("unhandledRejection", { reason: "subgraph 500" });
    expect(h.text()).not.toContain("[object Object]");
  });

  it("keeps the process alive through an ordinary uncaught exception", () => {
    const h = harness();
    h.emitter.emit("uncaughtException", new Error("a tool threw on a later tick"));
    expect(h.text()).toContain("uncaught exception");
    expect(h.text()).toContain("STILL RUNNING");
    expect(h.exits).toEqual([]);
  });

  it("exits 0 when the stdio pipe is gone — nothing left to serve over", () => {
    const h = harness();
    h.emitter.emit("uncaughtException", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(h.text()).toContain("shutting down");
    // 0, not 1: the host went away, which is a normal end of session.
    expect(h.exits).toEqual([0]);
  });

  it("never leaks a provider key into the crash report", () => {
    const h = harness();
    h.emitter.emit("unhandledRejection", new Error(`could not detect network (url=${KEYED_RPC})`));
    expect(h.text()).not.toContain("SUPER_SECRET_KEY_42");
  });
});

describe("installTransportGuards", () => {
  it("reports a transport error without ending the session", () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const transport: { onerror?: (e: Error) => void; onclose?: () => void } = {};
    installTransportGuards(transport, { write: (l) => void lines.push(l), exit: (c) => void exits.push(c) });

    transport.onerror!(new Error("malformed JSON-RPC frame"));
    expect(lines.join("")).toContain("transport error");
    expect(lines.join("")).toContain("malformed JSON-RPC frame");
    expect(exits).toEqual([]);
  });

  it("shuts down when the host closes stdin, instead of orphaning the process", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const transport: { onerror?: (e: Error) => void; onclose?: () => void } = {};
    installTransportGuards(transport, { write: (l) => void lines.push(l), exit: (c) => void exits.push(c) });

    transport.onclose!();
    expect(lines.join("")).toContain("closed by the host");
    // The exit is deferred one loop turn so the SDK's chained onclose — which
    // rejects the in-flight requests — gets to run first.
    expect(exits).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([0]);
  });

  it("survives Protocol.connect, which takes ownership of the transport", async () => {
    // The SDK's connect() re-assigns onclose/onerror. It chains whatever was
    // already there — but that is a documented-in-passing detail, and if it
    // ever stops chaining, these guards become silently dead code.
    const lines: string[] = [];
    const exits: number[] = [];
    const server = createDegradedServer(new Error("startup boom"));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    installTransportGuards(serverT, {
      write: (l) => void lines.push(l),
      exit: (c) => void exits.push(c),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    await client.close(); // closes both ends of the pair
    await new Promise((r) => setImmediate(r));

    expect(lines.join("")).toContain("closed by the host");
    expect(exits).toEqual([0]);
    await server.close();
  });

  it("redacts a transport error carrying a keyed URL", () => {
    const lines: string[] = [];
    const transport: { onerror?: (e: Error) => void; onclose?: () => void } = {};
    installTransportGuards(transport, { write: (l) => void lines.push(l), exit: () => {} });
    transport.onerror!(new Error(`socket hang up (${KEYED_RPC})`));
    expect(lines.join("")).not.toContain("SUPER_SECRET_KEY_42");
  });
});

/* ─────────────────────────── live child process ──────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(here, "fixtures", "crash-guard-child.ts");

function runChild(script: string, args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { cwd: resolve(here, ".."), windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code ?? 0;
        done({ code: typeof code === "number" ? code : 1, out: stdout, err: stderr });
      },
    );
  });
}

describe("a real process survives what used to kill it", () => {
  it("stays alive through an unhandled rejection AND an uncaught exception", async () => {
    const { code, out, err } = await runChild(CHILD);

    // The marker is printed by a timer that only runs if nothing killed us.
    expect(out).toContain("STILL_ALIVE");
    expect(code).toBe(0);

    expect(err).toContain("unhandled promise rejection");
    expect(err).toContain("uncaught exception");
    expect(err).toContain("STILL RUNNING");
  }, 90_000);

  it("does not double-report when installProcessGuards runs twice", async () => {
    const { err } = await runChild(CHILD);
    const hits = err.match(/unhandled promise rejection/g) ?? [];
    expect(hits).toHaveLength(1);
  }, 90_000);

  it("does not leak the provider key into the host log", async () => {
    const { err } = await runChild(CHILD);
    expect(err).not.toContain("LEAKED_KEY_123");
    expect(err).toContain("https://bsc.example.com/***");
  }, 90_000);
});
