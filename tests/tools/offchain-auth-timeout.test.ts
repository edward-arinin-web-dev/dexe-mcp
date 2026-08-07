import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerProposalBuildOffchainTools,
  authPost,
  AUTH_TIMEOUT_MS,
} from "../../src/tools/proposalBuildOffchain.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * 0.30.4 — "nothing hangs", auth edition.
 *
 * dexe_auth_login is the ONLY tool in proposalBuildOffchain.ts that dispatches
 * HTTP itself, and BOTH of its calls (nonce, then login) used a bare `fetch`
 * with no AbortSignal. `fetch` has no default timeout, so a blackholing backend
 * froze the tool call indefinitely — the release headline was false for exactly
 * this path.
 *
 * The load-bearing property of these tests is NEGATIVE: `hangingFetch` never
 * settles on its own. Code that drops the signal does not produce a wrong
 * message, it produces a test that never finishes. That is the regression.
 */

const BASE = "https://backend.example";
const ADDR = "0x1111111111111111111111111111111111111111";

/** A fetch that resolves only when aborted. No signal wired ⇒ hangs forever. */
function hangingFetch(onCall?: (init?: { signal?: AbortSignal }) => void) {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        onCall?.(init);
        const signal = init?.signal;
        const fail = () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        if (!signal) return; // the pre-0.30.4 behaviour: never settles
        if (signal.aborted) return fail();
        signal.addEventListener("abort", fail, { once: true });
      }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NONCE_OK = jsonResponse.bind(null, {
  data: { attributes: { message: "sign me" } },
});

const signerStub = () =>
  ({
    hasSigner: () => true,
    getAddress: () => ADDR,
    signMessage: async (_m: string) => "0xsig",
  }) as unknown as SignerManager;

const wcStub = () =>
  ({
    isConnected: () => false,
    account: () => undefined,
    signMessage: async (_m: string) => "0xwc",
  }) as unknown as WalletConnectManager;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Start the tool call but do NOT await it — the caller has to drive fake timers
 * past the deadline before the promise can settle.
 */
function startAuthLogin(): { result: Promise<ToolResult>; done: Promise<void> } {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalBuildOffchainTools(
    server,
    { config: {} } as unknown as ToolContext,
    signerStub(),
    wcStub(),
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  let close!: () => Promise<void>;
  const result = (async () => {
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    close = async () => {
      await client.close();
      await server.close();
    };
    return (await client.callTool({ name: "dexe_auth_login", arguments: {} })) as unknown as ToolResult;
  })();
  const done = result.then(
    () => close?.(),
    () => close?.(),
  );
  return { result, done };
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const originalBase = process.env.DEXE_BACKEND_API_URL;

beforeEach(() => {
  process.env.DEXE_BACKEND_API_URL = BASE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalBase === undefined) delete process.env.DEXE_BACKEND_API_URL;
  else process.env.DEXE_BACKEND_API_URL = originalBase;
});

// ------------------------------------------------- the deadline itself

describe("authPost — deadline", () => {
  it("aborts at its deadline instead of hanging", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const started = Date.now();
    await expect(authPost(`${BASE}/nonce`, { a: 1 }, "Nonce request", 25)).rejects.toThrow(
      /Nonce request timed out after 25ms/,
    );
    // Bounded, not merely "eventually" — the freeze is what we removed.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("says you are NOT logged in and that re-running is safe", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const err = await authPost(`${BASE}/login`, { a: 1 }, "Login request", 25).catch(
      (e: unknown) => e as Error,
    );
    // The caller cannot tell a stall from a slow response; the message has to
    // resolve "did I get a token?" and "is a retry safe?" or they invent one.
    expect(err.message).toMatch(/NOT logged in/);
    expect(err.message).toMatch(/no access token was issued/);
    expect(err.message).toMatch(/safe to re-run dexe_auth_login/);
    expect(err.message).toMatch(/DEXE_BACKEND_API_URL/);
    // Never the bare AbortError text, which explains nothing.
    expect(err.message).not.toMatch(/This operation was aborted/);
  });

  it("does not retry — one POST per attempt, so no double nonce/login", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    await authPost(`${BASE}/nonce`, { a: 1 }, "Nonce request", 20).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to 8s, matching the other DeXe backend clients", () => {
    expect(AUTH_TIMEOUT_MS).toBe(8000);
  });

  it("passes the request through untouched on the happy path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await authPost(`${BASE}/nonce`, { data: 1 }, "Nonce request", 5000);
    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ data: 1 }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ----------------------------------------- both legs, through the tool

describe("dexe_auth_login — both fetches are bounded", () => {
  it("step 1 (nonce) aborts at the 8s deadline rather than hanging", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    vi.stubGlobal("fetch", hangingFetch((init) => seen.push(init?.signal)));
    vi.useFakeTimers();

    const { result, done } = startAuthLogin();
    // Let the handler get as far as the first fetch (pure microtasks).
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]).toBeInstanceOf(AbortSignal); // pre-fix: undefined

    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS + 10);
    const res = await result;
    await done;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Nonce request timed out after 8000ms/);
    expect(textOf(res)).toMatch(/safe to re-run dexe_auth_login/);
  });

  it("step 3 (login) aborts at the 8s deadline rather than hanging", async () => {
    // The second fetch is a SEPARATE call site; wiring only the first would
    // leave the login POST unbounded, which is how it shipped.
    const seen: Array<AbortSignal | undefined> = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
        seen.push(init?.signal);
        if (call++ === 0) return Promise.resolve(NONCE_OK());
        return hangingFetch()(input, init);
      }),
    );
    vi.useFakeTimers();

    const { result, done } = startAuthLogin();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeInstanceOf(AbortSignal); // pre-fix: undefined

    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS + 10);
    const res = await result;
    await done;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Login request timed out after 8000ms/);
  });

  it("a stalled backend still produces output — the tool never returns nothing", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    vi.useFakeTimers();

    const { result, done } = startAuthLogin();
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS + 10);
    const res = await result;
    await done;

    // The whole point of the release: a hang becomes an explained failure.
    expect(textOf(res).length).toBeGreaterThan(0);
    expect(textOf(res)).toMatch(/Auth login failed/);
  });
});
