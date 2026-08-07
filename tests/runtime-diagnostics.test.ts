import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugHint, debugLog, formatDiagnostic, isDebugEnabled } from "../src/runtime.js";

/**
 * 0.30.4 "everything explains itself". A user hitting a field failure had
 * nothing to send the maintainer, so DEXE_DEBUG=1 turns on verbose stderr
 * diagnostics. Two properties are non-negotiable and are what these pin:
 *
 *   1. stdout is the MCP JSON-RPC channel. A single diagnostic byte written
 *      there corrupts the stream and the host drops the connection.
 *   2. The output is redacted. ethers v6 appends the credentialed RPC URL to
 *      err.message on any non-2xx response, and a debug log is exactly the
 *      text a user pastes into a public issue.
 */

const KEYED_RPC = "https://bsc-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY_42";

let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
const prevDebug = process.env.DEXE_DEBUG;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  stdout.mockRestore();
  if (prevDebug === undefined) delete process.env.DEXE_DEBUG;
  else process.env.DEXE_DEBUG = prevDebug;
});

const written = () => stderr.mock.calls.map((c) => String(c[0])).join("");

describe("isDebugEnabled", () => {
  it("is off when DEXE_DEBUG is unset", () => {
    delete process.env.DEXE_DEBUG;
    expect(isDebugEnabled()).toBe(false);
  });

  it("accepts the documented truthy spellings, case- and space-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      process.env.DEXE_DEBUG = v;
      expect(isDebugEnabled(), `DEXE_DEBUG=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("treats an off-ish or unparseable value as off, never as an error", () => {
    for (const v of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.DEXE_DEBUG = v;
      expect(isDebugEnabled(), `DEXE_DEBUG=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("is read live, so .env loaded after import still takes effect", () => {
    delete process.env.DEXE_DEBUG;
    expect(isDebugEnabled()).toBe(false);
    process.env.DEXE_DEBUG = "1";
    expect(isDebugEnabled()).toBe(true);
  });
});

describe("debugLog", () => {
  it("writes nothing at all when debug is off", () => {
    delete process.env.DEXE_DEBUG;
    debugLog("startup", "should not appear");
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes a scoped line to stderr when debug is on", () => {
    process.env.DEXE_DEBUG = "1";
    debugLog("startup", "pid=1 chains=[56,97]");
    expect(written()).toContain("[dexe-mcp:debug] startup: pid=1 chains=[56,97]");
  });

  it("never touches stdout — that is the MCP protocol channel", () => {
    process.env.DEXE_DEBUG = "1";
    debugLog("rpc", `calling ${KEYED_RPC}`, { chainId: 56 });
    expect(stdout).not.toHaveBeenCalled();
  });

  it("redacts a credentialed RPC URL in the message", () => {
    process.env.DEXE_DEBUG = "1";
    debugLog("rpc", `primary endpoint ${KEYED_RPC}`);
    const out = written();
    expect(out).not.toContain("SUPER_SECRET_KEY_42");
    expect(out).toContain("https://bsc-mainnet.g.alchemy.com/***");
  });

  it("renders an object detail as JSON and an Error detail as a diagnostic", () => {
    process.env.DEXE_DEBUG = "1";
    debugLog("state", "persist failed", { path: "/x/state.json" });
    debugLog("rpc", "call failed", new Error("boom"));
    const out = written();
    expect(out).toContain('{"path":"/x/state.json"}');
    expect(out).toContain("boom");
  });

  it("survives a circular detail instead of throwing into the caller", () => {
    process.env.DEXE_DEBUG = "1";
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => debugLog("state", "circular", circular)).not.toThrow();
  });
});

describe("formatDiagnostic", () => {
  it("keeps the stack — the audience is stderr and a maintainer, not the model", () => {
    const out = formatDiagnostic(new Error("kaboom"));
    expect(out).toContain("kaboom");
    expect(out).toMatch(/at .+/); // at least one stack frame
  });

  it("strips the API key ethers appends to the message", () => {
    const out = formatDiagnostic(new Error(`server response 401 (url=${KEYED_RPC})`));
    expect(out).not.toContain("SUPER_SECRET_KEY_42");
    expect(out).toContain("https://bsc-mainnet.g.alchemy.com/***");
  });

  it("walks .cause, where undici/ethers hide the reason behind 'fetch failed'", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8545");
    const out = formatDiagnostic(new Error("fetch failed", { cause }));
    expect(out).toContain("fetch failed");
    expect(out).toContain("caused by:");
    expect(out).toContain("ECONNREFUSED");
  });

  it("stops walking a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(() => formatDiagnostic(err)).not.toThrow();
  });

  it("renders a non-Error throw without printing [object Object]", () => {
    expect(formatDiagnostic("plain string failure")).toContain("plain string failure");
    expect(formatDiagnostic({ message: "shaped like an error" })).toContain("shaped like an error");
  });

  it("truncates a runaway diagnostic instead of flooding the host log", () => {
    const out = formatDiagnostic(new Error("x".repeat(50_000)));
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain("[truncated,");
  });
});

describe("debugHint", () => {
  it("tells the user how to get more when debug is off", () => {
    delete process.env.DEXE_DEBUG;
    expect(debugHint()).toContain("DEXE_DEBUG=1");
  });

  it("says nothing when they already turned it on", () => {
    process.env.DEXE_DEBUG = "1";
    expect(debugHint()).toBe("");
  });
});
