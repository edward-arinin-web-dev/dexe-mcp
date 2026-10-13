import { describe, it, expect, vi, afterEach } from "vitest";
import { PinataClient } from "../../src/lib/ipfsPin.js";
import { postSafeTransaction } from "../../src/tools/safe.js";
import { checkAvatarCidBytes } from "../../src/lib/imageSniff.js";

/**
 * 0.30.4 — "nothing hangs".
 *
 * Before this, none of these clients passed an AbortSignal. A blackholing
 * endpoint didn't fail; it froze the MCP tool call until the client gave up
 * minutes later, with no output to explain why. The load-bearing property of
 * every test here is therefore NEGATIVE: `hangingFetch` never settles on its
 * own, so a client that drops the signal doesn't produce a wrong message — it
 * produces a test that times out. That is the regression these guard.
 *
 * This repo's own clients (Pinata, the Safe transaction service, the avatar
 * CID probe). The read edition's (subgraph, Tally, IPFS gateways) are pinned
 * the same way in @dexe-network/dexe-mcp's copy of this file.
 */

/** A fetch that resolves only when aborted. No signal wired ⇒ hangs forever. */
function hangingFetch() {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        if (!signal) return; // the pre-0.30.4 behaviour: never settles
        if (signal.aborted) return fail();
        signal.addEventListener("abort", fail, { once: true });
      }),
  );
}

let stubbed: ReturnType<typeof hangingFetch> | undefined;

function stubFetch(fn: unknown): void {
  stubbed = fn as ReturnType<typeof hangingFetch>;
  vi.stubGlobal("fetch", fn);
}

afterEach(() => {
  vi.unstubAllGlobals();
  stubbed = undefined;
});

// ------------------------------------------------------------------ Pinata

describe("PinataClient — deadline", () => {
  it("pinJson aborts at its deadline and says nothing was pinned", async () => {
    stubFetch(hangingFetch());
    const client = new PinataClient("jwt-x", { pinJsonMs: 25 });
    const err = await client.pinJson({ a: 1 }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/timed out after 25ms/);
    // The mid-flow guarantee: money may already be spent on earlier steps, so
    // the message has to resolve "did it pin?" and "is re-running safe?".
    expect(err.message).toMatch(/no metadata was pinned/);
    expect(err.message).toMatch(/Re-run the same call/);
    // 0.34.0: the blanket "steps that already landed are skipped" is replaced
    // by the enumeration — execute and the validator round are NOT skipped.
    expect(err.message).toMatch(/already landed are re-derived from chain state and skipped/);
  });

  it("pinFile aborts at its deadline", async () => {
    stubFetch(hangingFetch());
    const client = new PinataClient("jwt-x", { pinFileMs: 25 });
    await expect(client.pinFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /pinFile timed out after 25ms/,
    );
  });

  it("ping aborts at its deadline", async () => {
    stubFetch(hangingFetch());
    const client = new PinataClient("jwt-x", { pingMs: 25 });
    await expect(client.ping()).rejects.toThrow(/auth check timed out after 25ms/);
  });

  it("does not retry a pin — a blind second POST could double-pin mid-flow", async () => {
    const fetchMock = hangingFetch();
    stubFetch(fetchMock);
    await new PinataClient("jwt-x", { pinJsonMs: 20 }).pinJson({ a: 1 }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------------------- Safe

describe("postSafeTransaction — deadline", () => {
  it("aborts at its deadline instead of hanging", async () => {
    stubFetch(hangingFetch());
    await expect(postSafeTransaction("https://safe.test/tx", {}, { a: 1 }, 25)).rejects.toThrow(
      /timed out after 25ms/,
    );
  });

  it("says the outcome is unknown and why a re-POST is not a second tx", async () => {
    stubFetch(hangingFetch());
    const err = await postSafeTransaction("https://safe.test/tx", {}, { a: 1 }, 25).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/unknown whether the transaction was queued/);
    expect(err.message).toMatch(/safeTxHash is deterministic/);
  });

  it("never retries — it is a write with an unknown outcome", async () => {
    const fetchMock = hangingFetch();
    stubFetch(fetchMock);
    await postSafeTransaction("https://safe.test/tx", {}, { a: 1 }, 20).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the body on a non-ok status rather than throwing", async () => {
    stubFetch(vi.fn().mockResolvedValue(new Response("duplicate", { status: 422, statusText: "Unprocessable" })));
    const res = await postSafeTransaction("https://safe.test/tx", {}, { a: 1 });
    expect(res).toMatchObject({ ok: false, status: 422, text: "duplicate" });
  });
});

// -------------------------------------------------------------- avatar CID

describe("checkAvatarCidBytes — explains why validation was skipped", () => {
  it("records the timeout per gateway instead of one opaque warning", async () => {
    stubFetch(hangingFetch());
    const res = await checkAvatarCidBytes("bafyfake", "avatar.jpeg", ["https://gw-a.test"], 25);
    // Still advisory (ok: true) — a fresh pin legitimately may not have
    // propagated — but the warning now says WHICH failure it was.
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/gw-a\.test → timed out after 25ms/);
  });

  it("records a non-ok status rather than swallowing it", async () => {
    stubFetch(vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const res = await checkAvatarCidBytes("bafyfake", "avatar.jpeg", ["https://gw-a.test"], 25);
    expect(res.warning).toMatch(/gw-a\.test → HTTP 403/);
  });
});
