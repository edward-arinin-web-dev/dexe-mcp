import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcProvider } from "ethers";
import {
  ResilientRpcProvider,
  rpcClientTimeoutCeilingMs,
  rpcTimeoutMs,
  rpcWorstCaseBudgetMs,
} from "../../src/rpc.js";

/**
 * 0.30.4 — the RPC retry loop must finish INSIDE the host's tool-call timeout.
 *
 * The release exists to replace a frozen tool call with an explained failure
 * ("this endpoint never answered, set DEXE_RPC_URL_MAINNET"). That message is
 * only ever delivered if our own loop gives up first: if the client's ~60s
 * timeout fires while we are still retrying, the user sees the client's generic
 * error instead and the failure mode got QUIETER, not louder.
 *
 * The first cut shipped 15s x 4 attempts + 3.9s backoff ≈ 63.9s — measured at
 * 64.0s against a real blackhole socket, i.e. just over the line. The regression
 * is invisible in every unit test that mocks transport, so the budget itself is
 * what gets asserted here.
 */

const BLACKHOLE_URL = "https://blackhole.invalid/rpc";

/** ethers v6 shape for the socket timeout FetchRequest.timeout raises. */
const timeoutError = () => Object.assign(new Error("request timeout"), { code: "TIMEOUT" });

describe("RPC worst-case budget stays under the client timeout (0.30.4)", () => {
  const saved = process.env.DEXE_RPC_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEXE_RPC_TIMEOUT_MS;
    else process.env.DEXE_RPC_TIMEOUT_MS = saved;
  });

  it("lands comfortably under the 60s ceiling on defaults", () => {
    delete process.env.DEXE_RPC_TIMEOUT_MS;

    const budget = rpcWorstCaseBudgetMs();
    const ceiling = rpcClientTimeoutCeilingMs();

    expect(ceiling).toBe(60_000);
    // ~43.9s today. "Comfortably" is the point: a bare `< 60_000` would let the
    // budget creep back to 59s and call itself passing.
    expect(budget).toBeLessThanOrEqual(50_000);
    expect(ceiling - budget).toBeGreaterThanOrEqual(10_000);
  });

  it("pins the arithmetic so neither half can drift unnoticed", () => {
    delete process.env.DEXE_RPC_TIMEOUT_MS;

    // 4 attempts x 10s + (400 + 1000 + 2500) backoff.
    expect(rpcTimeoutMs()).toBe(10_000);
    expect(rpcWorstCaseBudgetMs()).toBe(43_900);
  });

  it("keeps the default budget when DEXE_RPC_TIMEOUT_MS is garbage", () => {
    // 0.30.1 rule: a bad env var never changes behaviour into something worse
    // than the default — including the timing behaviour this test guards.
    for (const bad of ["", "abc", "0", "-1", "NaN"]) {
      process.env.DEXE_RPC_TIMEOUT_MS = bad;
      expect(rpcWorstCaseBudgetMs()).toBe(43_900);
    }
  });

  it("still lets an operator raise the ceiling on purpose (escape hatch intact)", () => {
    process.env.DEXE_RPC_TIMEOUT_MS = "30000";
    // Deliberately ABOVE the client ceiling: slow archive nodes and hosts with
    // longer timeouts are a real case. The default must not need this; opting
    // in must stay possible.
    expect(rpcWorstCaseBudgetMs()).toBe(123_900);
  });
});

describe("the measured loop matches the declared budget (0.30.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.DEXE_RPC_TIMEOUT_MS;
  });

  it("a total blackhole gives up after exactly the worst-case budget", async () => {
    delete process.env.DEXE_RPC_TIMEOUT_MS;
    let attempts = 0;
    // Simulate the real failure the verifier reproduced with a socket that
    // accepts and never answers: every attempt burns its FULL per-request
    // timeout before ethers raises TIMEOUT.
    vi.spyOn(JsonRpcProvider.prototype, "send").mockImplementation(async function (
      this: JsonRpcProvider,
    ) {
      attempts++;
      await new Promise((r) => setTimeout(r, this._getConnection().timeout));
      throw timeoutError();
    });
    const provider = new ResilientRpcProvider([BLACKHOLE_URL], 56, false);

    const started = Date.now();
    // Stamp the mocked clock AT settle time — reading it after the drive loop
    // below would just report how far we advanced, not when the loop gave up.
    const settled = provider.send("eth_call", []).then(
      () => ({ err: null as Error | null, at: Date.now() }),
      (e: unknown) => ({ err: e as Error, at: Date.now() }),
    );
    // Drive past the budget so a loop that got SLOWER fails on the elapsed
    // assertion instead of hanging this test.
    await vi.advanceTimersByTimeAsync(rpcClientTimeoutCeilingMs() * 2);
    const { err, at } = await settled;
    const elapsed = at - started;

    expect(err).toBeInstanceOf(Error);
    expect(attempts).toBe(4); // 1 primary + 3 retries
    expect(elapsed).toBe(rpcWorstCaseBudgetMs()); // the exported number is real
    expect(elapsed).toBeLessThan(rpcClientTimeoutCeilingMs());

    provider.destroy();
  });

  it("bounds the wired connection at the same value the budget assumes", () => {
    delete process.env.DEXE_RPC_TIMEOUT_MS;
    const provider = new ResilientRpcProvider([BLACKHOLE_URL], 56, false);

    // Ties the arithmetic to what ethers actually enforces — a budget computed
    // from a number no FetchRequest carries would prove nothing.
    expect(provider._getConnection().timeout).toBe(rpcTimeoutMs());

    provider.destroy();
  });
});
