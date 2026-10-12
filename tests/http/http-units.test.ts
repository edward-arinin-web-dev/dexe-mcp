import { describe, expect, it } from "vitest";
import { HTTP_DEFAULTS, parseHttpOptions, serveHttpUsage } from "../../src/http/options.js";
import {
  TokenBucketLimiter,
  checkOrigin,
  hostAllowed,
  hostnameFromHostHeader,
  makeIpHasher,
  resolveClientIp,
} from "../../src/http/security.js";
import { createRpcReadinessProbe, isWriteSideEnvKey, scrubWriteSideEnv } from "../../src/http/readServer.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * Pure parts of `serve-http`: option parsing, Host/Origin checks, client-IP
 * resolution behind proxies, the token bucket, the readiness probe and the
 * write-side env scrub. No sockets here; tests/http/serve-http.test.ts runs
 * the real server.
 */

describe("parseHttpOptions", () => {
  const ok = (argv: string[], env: Record<string, string> = {}) => {
    const r = parseHttpOptions(argv, env);
    if (r.kind !== "options") throw new Error(`expected options, got ${JSON.stringify(r)}`);
    return r.options;
  };

  it("defaults to loopback with a loopback Host allowlist and no browser origins", () => {
    const o = ok([]);
    expect(o.host).toBe("127.0.0.1");
    expect(o.port).toBe(HTTP_DEFAULTS.port);
    expect(o.allowedHosts).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(o.allowedOrigins).toEqual([]);
    expect(o.trustProxyHops).toBe(0);
    expect(o.accessLog).toBe(true);
  });

  it("flags beat env, both spellings", () => {
    expect(ok(["--port", "9000"], { PORT: "7000" }).port).toBe(9000);
    expect(ok(["--port=9001"]).port).toBe(9001);
    expect(ok([], { PORT: "7000" }).port).toBe(7000);
    expect(ok(["--host=localhost"]).host).toBe("localhost");
  });

  it("refuses a public bind without a Host allowlist instead of accepting any Host", () => {
    const r = parseHttpOptions(["--host", "0.0.0.0"], {});
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.errors.join("\n")).toMatch(/DEXE_HTTP_ALLOWED_HOSTS is required/);
  });

  it("normalises allowlists; * turns a check off", () => {
    const o = ok(["--host", "0.0.0.0"], {
      DEXE_HTTP_ALLOWED_HOSTS: "MCP.Example.com, mcp.example.com:443, https://alt.example.com/mcp",
      DEXE_HTTP_ALLOWED_ORIGINS: "https://App.Example.com/, http://localhost:6274",
    });
    expect(o.allowedHosts).toEqual(["mcp.example.com", "mcp.example.com", "alt.example.com"]);
    expect(o.allowedOrigins).toEqual(["https://app.example.com", "http://localhost:6274"]);
    const open = ok(["--host", "0.0.0.0"], { DEXE_HTTP_ALLOWED_HOSTS: "*", DEXE_HTTP_ALLOWED_ORIGINS: "*" });
    expect(open.allowedHosts).toBeNull();
    expect(open.allowedOrigins).toBeNull();
  });

  it("reads trust-proxy as a hop count", () => {
    expect(ok([], { DEXE_HTTP_TRUST_PROXY: "true" }).trustProxyHops).toBe(1);
    expect(ok([], { DEXE_HTTP_TRUST_PROXY: "2" }).trustProxyHops).toBe(2);
    expect(ok([], { DEXE_HTTP_TRUST_PROXY: "false" }).trustProxyHops).toBe(0);
  });

  it("bad values are errors, never silent defaults", () => {
    const r = parseHttpOptions(["--prot", "1"], {
      DEXE_HTTP_RATE_LIMIT_PER_MIN: "lots",
      DEXE_HTTP_MAX_BODY_BYTES: "10",
      DEXE_HTTP_ALLOWED_ORIGINS: "not an origin",
    });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    const all = r.errors.join("\n");
    expect(all).toMatch(/unknown option '--prot'/);
    expect(all).toMatch(/DEXE_HTTP_RATE_LIMIT_PER_MIN/);
    expect(all).toMatch(/DEXE_HTTP_MAX_BODY_BYTES/);
    expect(all).toMatch(/DEXE_HTTP_ALLOWED_ORIGINS/);
  });

  it("--help is a help request and the text says EXPERIMENTAL", () => {
    expect(parseHttpOptions(["--help"], {})).toEqual({ kind: "help" });
    expect(serveHttpUsage("1.2.3").split("\n")[0]).toMatch(/EXPERIMENTAL/);
  });

  it("0 disables the access log", () => {
    expect(ok([], { DEXE_HTTP_ACCESS_LOG: "0" }).accessLog).toBe(false);
  });
});

describe("Host and Origin checks", () => {
  it("compares hostnames port-agnostically", () => {
    expect(hostnameFromHostHeader("MCP.example.com:8443")).toBe("mcp.example.com");
    expect(hostnameFromHostHeader("[::1]:8080")).toBe("[::1]");
    expect(hostnameFromHostHeader("evil.example/path")).toBeNull();
    expect(hostAllowed("mcp.example.com:443", ["mcp.example.com"])).toBe(true);
    expect(hostAllowed("evil.example", ["mcp.example.com"])).toBe(false);
    expect(hostAllowed(undefined, ["mcp.example.com"])).toBe(false);
    expect(hostAllowed("anything", null)).toBe(true);
  });

  it("allows a missing Origin, rejects a foreign or null one", () => {
    const allow = ["https://app.example.com"];
    expect(checkOrigin(undefined, allow)).toBe("absent");
    expect(checkOrigin("https://app.example.com", allow)).toBe("allowed");
    expect(checkOrigin("https://APP.example.com", allow)).toBe("allowed");
    expect(checkOrigin("https://evil.example", allow)).toBe("rejected");
    expect(checkOrigin("null", allow)).toBe("rejected");
    expect(checkOrigin("https://evil.example", [])).toBe("rejected");
    expect(checkOrigin("https://evil.example", null)).toBe("allowed");
  });
});

describe("resolveClientIp", () => {
  it("ignores X-Forwarded-For unless proxies are trusted", () => {
    expect(resolveClientIp("10.0.0.5", "1.2.3.4", 0)).toBe("10.0.0.5");
  });

  it("takes the address N hops in from the socket", () => {
    // client 1.1.1.1 → spoofed entry it sent itself, then our proxy appended the real peer
    expect(resolveClientIp("10.0.0.5", "6.6.6.6, 1.1.1.1", 1)).toBe("1.1.1.1");
    expect(resolveClientIp("10.0.0.5", "1.1.1.1, 10.0.0.9", 2)).toBe("1.1.1.1");
    // fewer entries than trusted hops: the farthest known address
    expect(resolveClientIp("10.0.0.5", "1.1.1.1", 3)).toBe("1.1.1.1");
  });

  it("stops at garbage and folds IPv4-mapped IPv6", () => {
    expect(resolveClientIp("::ffff:10.0.0.5", undefined, 1)).toBe("10.0.0.5");
    expect(resolveClientIp("10.0.0.5", "1.1.1.1, not-an-ip", 2)).toBe("10.0.0.5");
  });

  it("hashes are stable per process, short, and not the address", () => {
    const h = makeIpHasher(Buffer.from("fixed-salt"));
    expect(h("1.2.3.4")).toMatch(/^[0-9a-f]{12}$/);
    expect(h("1.2.3.4")).toBe(h("1.2.3.4"));
    expect(h("1.2.3.4")).not.toBe(h("1.2.3.5"));
    expect(makeIpHasher()("1.2.3.4")).not.toBe(h("1.2.3.4"));
  });
});

describe("TokenBucketLimiter", () => {
  it("allows a burst, then refills at the configured rate", () => {
    let t = 0;
    const lim = new TokenBucketLimiter(60, 3, () => t); // 1 token / second
    expect([1, 2, 3].map(() => lim.take("a").allowed)).toEqual([true, true, true]);
    const refused = lim.take("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
    expect(lim.take("b").allowed).toBe(true); // separate bucket
    t += 1000;
    expect(lim.take("a").allowed).toBe(true);
    expect(lim.take("a").allowed).toBe(false);
  });

  it("0 per minute disables it", () => {
    const lim = new TokenBucketLimiter(0, 1);
    for (let i = 0; i < 100; i++) expect(lim.take("a").allowed).toBe(true);
  });

  it("memory is bounded: oldest key evicted, idle full buckets swept", () => {
    let t = 0;
    const lim = new TokenBucketLimiter(60, 2, () => t, 3);
    for (const k of ["a", "b", "c", "d"]) lim.take(k);
    expect(lim.size).toBe(3);
    t += 120_000;
    lim.take("e");
    expect(lim.size).toBe(1);
  });
});

describe("createRpcReadinessProbe", () => {
  const config = (urls: string[]) =>
    ({
      defaultChainId: 56,
      chains: new Map([[56, { chainId: 56, rpcUrl: urls[0] ?? "", rpcUrls: urls }]]),
    }) as unknown as DexeConfig;
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("ready with the block number; never echoes the RPC URL", async () => {
    const probe = createRpcReadinessProbe(config(["https://rpc.example/secret-key"]), 1000, {
      fetchImpl: (async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x10" })) as typeof fetch,
    });
    const r = await probe();
    expect(r).toEqual({ ready: true, detail: { chainId: 56, blockNumber: 16 } });
    expect(JSON.stringify(r)).not.toContain("secret-key");
  });

  it("falls through to the next endpoint, reports a fixed reason when all fail", async () => {
    const seen: string[] = [];
    const probe = createRpcReadinessProbe(config(["https://a.example/k1", "https://b.example/k2"]), 1000, {
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return jsonResponse({}, 502);
      }) as unknown as typeof fetch,
    });
    const r = await probe();
    expect(seen).toHaveLength(2);
    expect(r.ready).toBe(false);
    expect(r.detail).toEqual({ chainId: 56, reason: "rpc http 502" });
  });

  it("caches the answer so health polling is not RPC load", async () => {
    let calls = 0;
    let t = 0;
    const probe = createRpcReadinessProbe(config(["https://a.example"]), 1000, {
      now: () => t,
      cacheMs: 5000,
      fetchImpl: (async () => {
        calls++;
        return jsonResponse({ result: "0x1" });
      }) as typeof fetch,
    });
    await Promise.all([probe(), probe(), probe()]);
    await probe();
    expect(calls).toBe(1);
    t += 5001;
    await probe();
    expect(calls).toBe(2);
  });

  it("not ready when no chain is configured", async () => {
    const probe = createRpcReadinessProbe({ defaultChainId: 56, chains: new Map() } as unknown as DexeConfig, 100);
    expect((await probe()).ready).toBe(false);
  });
});

describe("write-side env scrub", () => {
  it("recognises signing, keyring, upload, WalletConnect and Safe keys", () => {
    for (const k of [
      "DEXE_PRIVATE_KEY",
      "DEXE_AGENT_PK_3",
      "AGENT_PK_12",
      "DEXE_AGENT_FUNDER_PK",
      "AGENT_FUNDER_PK",
      "DEXE_PINATA_JWT",
      "DEXE_WALLETCONNECT_PROJECT_ID",
      "DEXE_SAFE_TX_SERVICE_API_KEY",
      "DEXE_SIGNER_ALLOWLIST",
    ]) {
      expect(isWriteSideEnvKey(k), k).toBe(true);
    }
    for (const k of ["DEXE_RPC_URL_MAINNET", "DEXE_GRAPH_API_KEY", "DEXE_PINATA_GATEWAY_TOKEN", "DEXE_IPFS_GATEWAY"]) {
      expect(isWriteSideEnvKey(k), k).toBe(false);
    }
  });

  it("deletes them and returns names only", () => {
    const env: NodeJS.ProcessEnv = { DEXE_PRIVATE_KEY: "0xabc", DEXE_RPC_URL_MAINNET: "https://x", AGENT_PK_1: "0xdef" };
    expect(scrubWriteSideEnv(env)).toEqual(["AGENT_PK_1", "DEXE_PRIVATE_KEY"]);
    expect(env).toEqual({ DEXE_RPC_URL_MAINNET: "https://x" });
  });
});
