import { describe, expect, it } from "vitest";
import { HTTP_DEFAULTS, parseHttpOptions, serveHttpUsage } from "../../src/http/options.js";
import {
  TokenBucketLimiter,
  canonicalIp,
  checkOrigin,
  hostAllowed,
  hostnameFromHostHeader,
  makeIpHasher,
  rateLimitKey,
  resolveClientIp,
} from "../../src/http/security.js";
import {
  createRpcReadinessProbe,
  findSharedDefaults,
  isReadServerEnvKey,
  scrubEnvToReadAllowlist,
} from "../../src/http/readServer.js";
import { DEFAULTS, type DexeConfig } from "../../src/config.js";

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

  it("body timeout is tunable; the shared-defaults opt-in is off unless set", () => {
    expect(ok([]).bodyTimeoutMs).toBe(HTTP_DEFAULTS.bodyTimeoutMs);
    expect(ok([], { DEXE_HTTP_BODY_TIMEOUT_MS: "2500" }).bodyTimeoutMs).toBe(2500);
    expect(ok([]).allowSharedDefaults).toBe(false);
    expect(ok([], { DEXE_HTTP_ALLOW_SHARED_DEFAULTS: "1" }).allowSharedDefaults).toBe(true);
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

  it("strips ports, brackets and zone ids from X-Forwarded-For entries", () => {
    expect(canonicalIp("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(canonicalIp("[2001:DB8::1]:443")).toBe("2001:db8::1");
    expect(canonicalIp("[::1]")).toBe("::1");
    expect(canonicalIp("fe80::1%eth0")).toBe("fe80::1");
    expect(resolveClientIp("10.0.0.5", "1.1.1.1:40000", 1)).toBe("1.1.1.1");
    expect(resolveClientIp("10.0.0.5", "[2001:db8::7]:1234", 1)).toBe("2001:db8::7");
  });
});

describe("rateLimitKey", () => {
  it("groups IPv6 by /64 so one subscriber gets one bucket", () => {
    expect(rateLimitKey("2001:db8:aa:bb::1")).toBe("2001:db8:aa:bb::/64");
    expect(rateLimitKey("2001:db8:aa:bb:ffff:1:2:3")).toBe("2001:db8:aa:bb::/64");
    expect(rateLimitKey("[2001:db8:aa:bb::9]:443")).toBe("2001:db8:aa:bb::/64");
    expect(rateLimitKey("2001:db8:aa:bc::1")).not.toBe(rateLimitKey("2001:db8:aa:bb::1"));
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/64");
  });

  it("leaves IPv4 alone (ports stripped)", () => {
    expect(rateLimitKey("1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitKey("1.2.3.4:99")).toBe("1.2.3.4");
    expect(rateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
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

describe("env allowlist", () => {
  it("drops every write-side, unknown DeXe and unrelated secret var", () => {
    for (const k of [
      "DEXE_PRIVATE_KEY",
      "DEXE_AGENT_PK_3",
      "AGENT_PK_12",
      "DEXE_AGENT_FUNDER_PK",
      "DEXE_PINATA_JWT",
      "DEXE_WALLETCONNECT_PROJECT_ID",
      "DEXE_SAFE_API_KEY",
      "DEXE_SAFE_TX_SERVICE_URL",
      "DEXE_SIGNER_ALLOWLIST",
      "DEXE_TREASURY_GUARD",
      "DEXE_ENV_FILE",
      "DEXE_SOMETHING_NEW",
      "FOO_SECRET",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
    ]) {
      expect(isReadServerEnvKey(k), k).toBe(false);
    }
  });

  it("keeps read data-source vars, DEXE_HTTP_* and the runtime basics", () => {
    for (const k of [
      "DEXE_RPC_URL_MAINNET",
      "DEXE_RPC_URL_10",
      "DEXE_SUBGRAPH_POOLS_URL",
      "DEXE_SUBGRAPH_VALIDATORS_URL_97",
      "DEXE_GRAPH_API_KEY",
      "DEXE_BACKEND_API_URL",
      "DEXE_PINATA_GATEWAY_TOKEN",
      "DEXE_IPFS_GATEWAY",
      "DEXE_HTTP_ALLOWED_HOSTS",
      "DEXE_HTTP_ALLOW_SHARED_DEFAULTS",
      "PATH",
      "Path",
      "HOME",
      "TMPDIR",
      "NODE_EXTRA_CA_CERTS",
      "HTTPS_PROXY",
      "LC_ALL",
    ]) {
      expect(isReadServerEnvKey(k), k).toBe(true);
    }
  });

  it("deletes in place and reports a count, not names", () => {
    const env: NodeJS.ProcessEnv = {
      DEXE_SAFE_API_KEY: "safe",
      FOO_SECRET: "foo",
      DEXE_RPC_URL_MAINNET: "https://x",
      PATH: "/bin",
    };
    expect(scrubEnvToReadAllowlist(env)).toBe(2);
    expect(env).toEqual({ DEXE_RPC_URL_MAINNET: "https://x", PATH: "/bin" });
  });
});

describe("findSharedDefaults", () => {
  const bakedPools = DEFAULTS.subgraphPoolsUrl;
  const own = "https://gateway.thegraph.com/api/0123456789abcdef0123456789abcdef/subgraphs/id/X";
  const cfg = (over: Partial<Record<string, unknown>>) =>
    ({
      usingPublicRpcFallback: false,
      subgraphUrls: new Map([[56, { pools: own, validators: own, interactions: own }]]),
      ...over,
    }) as unknown as DexeConfig;

  it("flags the public RPC fallback, the baked Graph key per subgraph kind, and the default backend", () => {
    const found = findSharedDefaults(
      cfg({
        usingPublicRpcFallback: true,
        subgraphUrls: new Map([[56, { pools: bakedPools, validators: own, interactions: DEFAULTS.subgraphInteractionsUrl }]]),
      }),
      {},
    );
    const vars = found.flatMap((f) => f.setVars);
    expect(vars).toEqual([
      "DEXE_RPC_URL_MAINNET",
      "DEXE_RPC_URL_TESTNET",
      "DEXE_SUBGRAPH_INTERACTIONS_URL",
      "DEXE_SUBGRAPH_POOLS_URL",
      "DEXE_BACKEND_API_URL",
    ]);
  });

  it("is empty once the operator set their own endpoints", () => {
    expect(findSharedDefaults(cfg({}), { DEXE_BACKEND_API_URL: "https://api.dexe.io" })).toEqual([]);
  });

  it("a separate DEXE_GRAPH_API_KEY does not help while the URL still carries the baked key", () => {
    const found = findSharedDefaults(
      cfg({ subgraphUrls: new Map([[56, { pools: bakedPools }]]) }),
      { DEXE_GRAPH_API_KEY: "mine", DEXE_BACKEND_API_URL: "https://b" },
    );
    expect(found.flatMap((f) => f.setVars)).toEqual(["DEXE_SUBGRAPH_POOLS_URL"]);
  });
});
