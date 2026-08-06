import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  gqlRequest,
  isShippedDefaultSubgraph,
  SUBGRAPH_TIMEOUT_MS,
} from "../../src/lib/subgraph.js";
import { PinataClient, fetchIpfs, cidForJson } from "../../src/lib/ipfs.js";
import { fetchTallyProposals } from "../../src/governor/tally.js";
import { postSafeTransaction } from "../../src/tools/safe.js";
import { checkAvatarCidBytes } from "../../src/lib/imageSniff.js";
import { DEFAULTS } from "../../src/config.js";

/**
 * 0.30.4 — "nothing hangs".
 *
 * Before this, none of these clients passed an AbortSignal. A blackholing
 * endpoint didn't fail; it froze the MCP tool call until the client gave up
 * minutes later, with no output to explain why. The load-bearing property of
 * every test here is therefore NEGATIVE: `hangingFetch` never settles on its
 * own, so a client that drops the signal doesn't produce a wrong message — it
 * produces a test that times out. That is the regression these guard.
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

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

const CUSTOM_ENDPOINT = "https://subgraph.example.test/my-own-gateway";
const QUERY = "{ daoPools { id } }";

let stubbed: ReturnType<typeof hangingFetch> | undefined;

function stubFetch(fn: unknown): void {
  stubbed = fn as ReturnType<typeof hangingFetch>;
  vi.stubGlobal("fetch", fn);
}

beforeEach(() => {
  // Keep the Bearer-attachment branch out of these tests' way.
  delete process.env.DEXE_GRAPH_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  stubbed = undefined;
});

// ---------------------------------------------------------------- subgraph

describe("gqlRequest — deadline", () => {
  it("aborts at its deadline instead of hanging", async () => {
    stubFetch(hangingFetch());
    const started = Date.now();
    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, {
        timeoutMs: 25,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/timed out after 25ms/);
    // Bounded, not merely "eventually" — the whole point is the freeze is gone.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("labels a timeout as transient and tells the caller to re-run", async () => {
    stubFetch(hangingFetch());
    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, { timeoutMs: 20, retryDelayMs: 0 }),
    ).rejects.toThrow(/transient, re-run the call/);
  });

  it("defaults to 8s, matching the backend client", () => {
    expect(SUBGRAPH_TIMEOUT_MS).toBe(8000);
  });
});

describe("gqlRequest — retry policy", () => {
  it("retries a 429 exactly once and returns the second attempt's data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, statusText: "Too Many Requests" }))
      .mockResolvedValueOnce(jsonResponse({ data: { daoPools: [{ id: "0xabc" }] } }));
    stubFetch(fetchMock);

    const data = await gqlRequest<{ daoPools: { id: string }[] }>(
      CUSTOM_ENDPOINT,
      QUERY,
      undefined,
      undefined,
      { retryDelayMs: 0 },
    );
    expect(data.daoPools[0]!.id).toBe("0xabc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the single retry rather than looping", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    stubFetch(fetchMock);

    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, { retryDelayMs: 0 }),
    ).rejects.toThrow(/retried once; both attempts failed/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 400 — the gateway will reject it identically", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("bad query", { status: 400, statusText: "Bad Request" }));
    stubFetch(fetchMock);

    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, { retryDelayMs: 0 }),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 422])("does NOT retry a non-429 4xx (%i)", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status }));
    stubFetch(fetchMock);

    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, { retryDelayMs: 0 }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 502, statusText: "Bad Gateway" }))
      .mockResolvedValueOnce(jsonResponse({ data: { daoPools: [] } }));
    stubFetch(fetchMock);

    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, { retryDelayMs: 0 }),
    ).resolves.toEqual({ daoPools: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a GraphQL-level error — that is a bad query, not a bad connection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "no such entity: voterInPool" }] }));
    stubFetch(fetchMock);

    await expect(
      gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, { retryDelayMs: 0 }),
    ).rejects.toThrow(/no such entity/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("gqlRequest — status-specific remediation", () => {
  async function messageFor(status: number, endpoint = CUSTOM_ENDPOINT): Promise<string> {
    stubFetch(vi.fn().mockResolvedValue(new Response("", { status })));
    try {
      await gqlRequest(endpoint, QUERY, undefined, undefined, { retryDelayMs: 0 });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    throw new Error(`expected HTTP ${status} to reject`);
  }

  it.each([401, 403])("%i tells the user to set their own gateway key", async (status) => {
    const msg = await messageFor(status);
    expect(msg).toMatch(/rejected the request/);
    expect(msg).toMatch(/DEXE_SUBGRAPH_\*_URL/);
    expect(msg).toMatch(/thegraph\.com\/studio/);
    expect(msg).toMatch(/restart/);
  });

  it("429 says rate-limited and offers both fixes", async () => {
    const msg = await messageFor(429);
    expect(msg).toMatch(/rate-limited/);
    expect(msg).toMatch(/DEXE_SUBGRAPH_\*_URL/);
    expect(msg).toMatch(/retry/);
  });

  it("5xx says transient, re-run", async () => {
    const msg = await messageFor(503);
    expect(msg).toMatch(/transient, re-run/);
  });

  it("an unmapped 4xx says a retry will not help", async () => {
    const msg = await messageFor(418);
    expect(msg).toMatch(/will reject it identically/);
  });
});

describe("gqlRequest — shipped-default endpoint hint", () => {
  it("recognises the baked endpoints and nothing else", () => {
    expect(isShippedDefaultSubgraph(DEFAULTS.subgraphPoolsUrl)).toBe(true);
    expect(isShippedDefaultSubgraph(DEFAULTS.subgraphValidatorsUrl)).toBe(true);
    expect(isShippedDefaultSubgraph(DEFAULTS.subgraphInteractionsUrl)).toBe(true);
    expect(isShippedDefaultSubgraph(CUSTOM_ENDPOINT)).toBe(false);
  });

  it("flags a 429 on the shared default key, mirroring PUBLIC_RPC_HINT", async () => {
    stubFetch(vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const err = await gqlRequest(DEFAULTS.subgraphPoolsUrl, QUERY, undefined, undefined, {
      retryDelayMs: 0,
    }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/\[hint]/);
    expect(err.message).toMatch(/shared DEFAULT Graph endpoint/);
  });

  it("stays quiet when the operator already configured their own endpoint", async () => {
    stubFetch(vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const err = await gqlRequest(CUSTOM_ENDPOINT, QUERY, undefined, undefined, {
      retryDelayMs: 0,
    }).catch((e: unknown) => e as Error);
    expect(err.message).not.toMatch(/\[hint]/);
  });

  it("never echoes the endpoint's embedded Graph API key into the error", async () => {
    // The key rides in the URL path, so an unmasked endpoint in a tool result
    // would put the operator's billable key in the transcript (W36).
    const key = /\/api\/([0-9a-f]{32,})\//i.exec(DEFAULTS.subgraphPoolsUrl)?.[1];
    expect(key).toBeTruthy();
    stubFetch(vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const err = await gqlRequest(DEFAULTS.subgraphPoolsUrl, QUERY, undefined, undefined, {
      retryDelayMs: 0,
    }).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(key!);
    expect(err.message).toContain("gateway.thegraph.com");
  });
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
    expect(err.message).toMatch(/already landed are skipped/);
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

// ------------------------------------------------------------------- Tally

describe("fetchTallyProposals — deadline", () => {
  it("aborts at its deadline instead of hanging", async () => {
    stubFetch(hangingFetch());
    await expect(
      fetchTallyProposals({ apiKey: "k", timeoutMs: 25 }, "eip155:1:0xabc", 10),
    ).rejects.toThrow(/timed out after 25ms/);
  });

  it("explains a rejected API key", async () => {
    stubFetch(vi.fn().mockResolvedValue(new Response("forbidden", { status: 401 })));
    await expect(
      fetchTallyProposals({ apiKey: "k" }, "eip155:1:0xabc", 10),
    ).rejects.toThrow(/TALLY_API_KEY was rejected/);
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

// -------------------------------------------------------------------- IPFS

describe("fetchIpfs — per-gateway deadline", () => {
  it("names the deadline in the aggregated failure instead of 'operation was aborted'", async () => {
    stubFetch(hangingFetch());
    const cid = await cidForJson({ hello: "world" });
    const err = await fetchIpfs(cid, {
      gateways: ["https://gw-a.test", "https://gw-b.test"],
      perRequestTimeoutMs: 25,
    }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/gw-a\.test → timed out after 25ms/);
    expect(err.message).toMatch(/gw-b\.test → timed out after 25ms/);
    expect(err.message).not.toMatch(/operation was aborted/);
  });

  it("moves on to the next gateway rather than failing on the first stall", async () => {
    const cid = await cidForJson({ hello: "world" });
    const good = JSON.stringify({ hello: "world" });
    let call = 0;
    stubFetch(
      vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
        if (call++ === 0) return hangingFetch()(_input, init);
        return Promise.resolve(
          new Response(good, { status: 200, headers: { "content-type": "application/json" } }),
        );
      }),
    );
    const res = await fetchIpfs(cid, {
      gateways: ["https://gw-a.test", "https://gw-b.test"],
      perRequestTimeoutMs: 25,
    });
    expect(res.gateway).toBe("https://gw-b.test");
    expect(res.attempts).toBe(2);
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
