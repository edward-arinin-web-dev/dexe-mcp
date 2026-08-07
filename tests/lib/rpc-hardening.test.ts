import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcProvider } from "ethers";
import { ResilientRpcProvider, isTransportError, rpcTimeoutMs } from "../../src/rpc.js";
import { redactErrorInPlace, redactUrlCredentials } from "../../src/lib/redact.js";

/**
 * 0.30.4 — "nothing hangs, everything explains itself".
 *
 * Two invariants for the RPC layer, plus one that had zero coverage:
 *
 * 1. NO error leaves src/rpc.ts with the operator's endpoint in it. ethers v6
 *    appends the full request URL to `err.message` on any non-2xx response
 *    (401/429/5xx are routine under load) and ~90 catch blocks across src/tools
 *    echo `err.message` verbatim. The pre-0.30.4 `#finalize` returned the RAW
 *    error whenever a PRIVATE (keyed) endpoint was configured — exactly the
 *    case the redaction exists for — and the non-transport arm rethrew raw
 *    before `#finalize` even ran.
 * 2. Every request is bounded. ethers' FetchRequest default is 300_000 ms with
 *    internal retries, so a blackholing endpoint parked a read for ~20 minutes
 *    behind a frozen tool call.
 * 3. `eth_sendRawTransaction` is never retried or rotated. That has been the
 *    documented contract since the retry layer shipped and was never asserted;
 *    a regression would silently double-broadcast on a flaky endpoint.
 */

const SECRET = "abcd1234SECRETKEYxyz";
const PRIMARY_URL = `https://bsc-mainnet.g.alchemy.com/v2/${SECRET}`;
const FALLBACK_URL = `https://bsc-backup.quiknode.pro/${SECRET}beef/`;

/** Comfortably past the retry loop's 400+1000+2500ms backoff budget. */
const RETRY_BUDGET_MS = 10_000;

/** ethers v6 shape for a 401/429/5xx: the FULL request URL rides in `message`. */
const serverError = (status: number) =>
  Object.assign(
    new Error(
      `server response ${status} (request=<FetchRequest method="POST" url="${PRIMARY_URL}">, ` +
        `code=SERVER_ERROR, version=6.16.0)`,
    ),
    { code: "SERVER_ERROR" },
  );

/** ethers v6 shape for a socket timeout (what the new FetchRequest.timeout raises). */
const timeoutError = () =>
  Object.assign(new Error("request timeout"), { code: "TIMEOUT" });

/** ethers v6 shape for a genuine contract revert — a RESULT, not a failure. */
const revertError = () =>
  Object.assign(
    new Error(
      `execution reverted: "Gov: low creating power" (action="call", ` +
        `requestUrl=${PRIMARY_URL}, code=CALL_EXCEPTION, version=6.16.0)`,
    ),
    {
      code: "CALL_EXCEPTION",
      data: "0x08c379a0deadbeef",
      shortMessage: 'execution reverted: "Gov: low creating power"',
    },
  );

/**
 * Await a rejection while driving the retry loop's backoff sleeps under fake
 * timers (the real loop waits ~3.9s, which would sit on vitest's 5s budget).
 * Harmless for the single-attempt paths — there are simply no timers to run.
 */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  const captured = p.then(
    (v) => {
      throw new Error(`expected a rejection, resolved with ${String(v)}`);
    },
    (e: unknown) => e as Error,
  );
  await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS);
  return captured;
}

describe("ResilientRpcProvider never leaks the operator's RPC key (0.30.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("redacts a transport error on the PRIVATE-endpoint path (no public hint)", async () => {
    vi.spyOn(JsonRpcProvider.prototype, "send").mockRejectedValue(serverError(401));
    const provider = new ResilientRpcProvider([PRIMARY_URL], 56, false);

    const err = await rejectionOf(provider.send("eth_call", []));

    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("bsc-mainnet.g.alchemy.com"); // host kept: still diagnosable
    expect(err.message).not.toContain("[hint]"); // private endpoint — no nudge
    // `code` must survive: simulate.ts branches on it to tell a revert from a
    // network blip before it lets a broadcast through.
    expect((err as { code?: string }).code).toBe("SERVER_ERROR");

    provider.destroy();
  });

  it("redacts on the PUBLIC-fallback path and still appends the configure-your-own-RPC hint", async () => {
    vi.spyOn(JsonRpcProvider.prototype, "send").mockRejectedValue(serverError(429));
    const provider = new ResilientRpcProvider([PRIMARY_URL], 56, true);

    const err = await rejectionOf(provider.send("eth_call", []));

    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("[hint]");
    expect(err.message).toContain("DEXE_RPC_URL_MAINNET");

    provider.destroy();
  });

  it("redacts a revert without stripping code/data — and without retrying it", async () => {
    const spy = vi.spyOn(JsonRpcProvider.prototype, "send").mockRejectedValue(revertError());
    const provider = new ResilientRpcProvider([PRIMARY_URL, FALLBACK_URL], 56, true);

    const err = await rejectionOf(provider.send("eth_call", []));

    expect(spy).toHaveBeenCalledTimes(1); // a revert is a result — never retried
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("low creating power"); // the useful part survives
    expect((err as { code?: string }).code).toBe("CALL_EXCEPTION");
    expect((err as { data?: string }).data).toBe("0x08c379a0deadbeef");

    provider.destroy();
  });

  it("redacts a non-Error throwable", async () => {
    vi.spyOn(JsonRpcProvider.prototype, "send").mockImplementation(async () => {
      throw `exploded while dialing ${PRIMARY_URL}`;
    });
    const provider = new ResilientRpcProvider([PRIMARY_URL], 56, false);

    const err = await rejectionOf(provider.send("eth_call", []));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(SECRET);

    provider.destroy();
  });
});

describe("per-request RPC timeout (0.30.4)", () => {
  const saved = process.env.DEXE_RPC_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEXE_RPC_TIMEOUT_MS;
    else process.env.DEXE_RPC_TIMEOUT_MS = saved;
    vi.restoreAllMocks();
  });

  // 10s, not 15s: 4 attempts x 15s + backoff was ~64s worst case, past the ~60s
  // tool-call timeout most MCP clients enforce. See tests/lib/rpc-budget.test.ts.
  it("defaults to 10s and honours DEXE_RPC_TIMEOUT_MS", () => {
    delete process.env.DEXE_RPC_TIMEOUT_MS;
    expect(rpcTimeoutMs()).toBe(10_000);
    process.env.DEXE_RPC_TIMEOUT_MS = "3000";
    expect(rpcTimeoutMs()).toBe(3000);
  });

  it("falls back to the default on a value that would break the provider", () => {
    for (const bad of ["", "abc", "0", "-1", "NaN"]) {
      process.env.DEXE_RPC_TIMEOUT_MS = bad;
      // ethers rejects a negative timeout outright and 0 would expire every
      // request instantly — neither may take the server down (0.30.1 rule).
      expect(rpcTimeoutMs()).toBe(10_000);
    }
  });

  it("bounds the PRIMARY connection instead of inheriting ethers' 5-minute default", () => {
    process.env.DEXE_RPC_TIMEOUT_MS = "2500";
    const provider = new ResilientRpcProvider([PRIMARY_URL], 56, false);

    expect(provider._getConnection().timeout).toBe(2500);
    expect(provider._getConnection().timeout).not.toBe(300_000);

    provider.destroy();
  });
});

describe("transport classification + rotation (0.30.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.DEXE_RPC_TIMEOUT_MS;
  });

  it("classifies an ethers TIMEOUT as a transport error", () => {
    expect(isTransportError(timeoutError())).toBe(true);
    expect(isTransportError(new Error("request timeout"))).toBe(true);
    expect(isTransportError(revertError())).toBe(false);
  });

  it("rotates a timing-out primary onto the fallback URL, which is bounded too", async () => {
    process.env.DEXE_RPC_TIMEOUT_MS = "1234";
    const seen: { url: string; timeout: number }[] = [];
    vi.spyOn(JsonRpcProvider.prototype, "send").mockImplementation(async function (
      this: JsonRpcProvider,
    ) {
      const conn = this._getConnection();
      seen.push({ url: conn.url, timeout: conn.timeout });
      if (seen.length < 3) throw timeoutError();
      return "0xok";
    });
    const provider = new ResilientRpcProvider([PRIMARY_URL, FALLBACK_URL], 56, false);

    const call = provider.send("eth_call", []);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS);

    await expect(call).resolves.toBe("0xok");
    expect(seen).toHaveLength(3);
    expect(seen[0]!.url).toBe(PRIMARY_URL); // attempt 0 = primary
    expect(seen[1]!.url).toBe(FALLBACK_URL); // TIMEOUT rotated us over
    expect(seen[1]!.timeout).toBe(1234); // fallback is not unbounded

    provider.destroy();
  });
});

describe("eth_sendRawTransaction is never retried (0.30.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("attempts a failing broadcast exactly once, on the primary URL only", async () => {
    // A transport failure — the one shape the read path WOULD retry. Resending
    // a broadcast risks a duplicate tx / "already known", so the composite
    // layer owns re-run semantics, not this provider.
    const spy = vi.spyOn(JsonRpcProvider.prototype, "send").mockRejectedValue(serverError(503));
    const provider = new ResilientRpcProvider([PRIMARY_URL, FALLBACK_URL], 56, false);

    const err = await rejectionOf(provider.send("eth_sendRawTransaction", ["0xdeadbeef"]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain(SECRET); // the broadcast arm redacts too

    provider.destroy();
  });

  it("passes a successful broadcast through with a single send", async () => {
    const spy = vi.spyOn(JsonRpcProvider.prototype, "send").mockResolvedValue("0xtxhash");
    const provider = new ResilientRpcProvider([PRIMARY_URL, FALLBACK_URL], 56, false);

    await expect(provider.send("eth_sendRawTransaction", ["0xdeadbeef"])).resolves.toBe("0xtxhash");
    expect(spy).toHaveBeenCalledTimes(1);

    provider.destroy();
  });
});

describe("redactErrorInPlace (0.30.4)", () => {
  it("keeps the error object (and its ethers fields) while rewriting the message", () => {
    const err = revertError();
    const out = redactErrorInPlace(err);

    expect(out).toBe(err); // same object — rethrowable without losing identity
    expect(out.message).not.toContain(SECRET);
    expect((out as { data?: string }).data).toBe("0x08c379a0deadbeef");
  });

  it("never throws on a frozen error object", () => {
    const frozen = Object.freeze(
      Object.assign(new Error(`boom at ${PRIMARY_URL}`), { code: "SERVER_ERROR" }),
    );

    const out = redactErrorInPlace(frozen);

    expect(out.message).not.toContain(SECRET);
    expect((out as { code?: string }).code).toBe("SERVER_ERROR"); // copy keeps the classifier
  });

  it("masks a keyed wss:// endpoint (an RPC key sits in the same position)", () => {
    expect(redactUrlCredentials(`wss://bsc.g.alchemy.com/v2/${SECRET}`)).not.toContain(SECRET);
    expect(redactUrlCredentials(`ws://user:pass@node.internal:8546/rpc`)).not.toContain("pass");
  });
});
