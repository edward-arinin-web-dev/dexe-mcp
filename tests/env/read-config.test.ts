import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `loadReadConfig()` — the read edition's loader — next to a `.env` that also
 * carries the write edition's secrets (the shared-`.env` case from the split
 * map §5). It must:
 *   - return none of the write fields,
 *   - construct no `Wallet` (no key is ever parsed),
 *   - say nothing about the write vars on stderr — not even when they are malformed,
 *   - record no startup issue for them, and leave them where they are.
 * And `.env` loading with the read surface must not call them typos.
 *
 * `Wallet` is spied through a module mock; the write loader run against the
 * same env is the control that proves the spy sees construction.
 */

const walletCtor = vi.hoisted(() => vi.fn());
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class SpiedWallet extends actual.Wallet {
    constructor(...args: ConstructorParameters<typeof actual.Wallet>) {
      walletCtor(...args);
      super(...args);
    }
  }
  return { ...actual, Wallet: SpiedWallet };
});

// The read loader is the read edition's, from the package. vitest.config.ts
// inlines the package, so the `ethers` mock above reaches its imports too.
const { loadEnvFile, loadReadConfig } = await import("@dexe-network/dexe-mcp/core");
const { loadConfig } = await import("../../src/config.js");
const { FULL_ENV_SURFACE } = await import("../../src/env/schema.js");

// Well-known throwaway keys (Hardhat's default accounts #1–#3) — never funded.
const KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const KEY_3 = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const PINATA_JWT = "eyJhbGciOiJIUzI1NiJ9.pinata-secret-for-test";
const WC_ID = "0123456789abcdef0123456789abcdef";
const SAFE_KEY = "safe-api-key-for-test";

const WRITE_ENV: Record<string, string> = {
  // the one mode that loads hot keys — so the control below really signs
  DEXE_SIGNER_MODE: "unattended",
  DEXE_PRIVATE_KEY: KEY_1,
  DEXE_AGENT_PK_1: KEY_2,
  AGENT_PK_2: KEY_3,
  DEXE_AGENT_FUNDER_PK: KEY_2,
  DEXE_PINATA_JWT: PINATA_JWT,
  DEXE_WALLETCONNECT_PROJECT_ID: WC_ID,
  DEXE_SAFE_API_KEY: SAFE_KEY,
  DEXE_SAFE_TX_SERVICE_URL: "https://safe.example/api/v2",
  DEXE_TREASURY_GUARD: "block",
  DEXE_SIGNER_MAX_VALUE_WEI: "1000",
};

/** Write vars whose values are malformed — the write loader would degrade on each. */
const MALFORMED_WRITE_ENV: Record<string, string> = {
  DEXE_PRIVATE_KEY: "0xshort",
  DEXE_SIGNER_ALLOWLIST: "not-an-address",
  DEXE_SIGNER_MAX_BROADCASTS_PER_MIN: "-1",
  DEXE_WALLETCONNECT_RELAY_URL: "https://not-a-websocket.example",
  DEXE_TREASURY_GUARD: "loud",
  DEXE_FORK_BLOCK: "latest",
  DEXE_TX_WAIT_TIMEOUT_MS: "3m",
};

const SECRETS = [KEY_1, KEY_2, KEY_3, PINATA_JWT, WC_ID, SAFE_KEY];

/** Every field of the read config — and nothing else. */
const READ_FIELDS = [
  "backendApiUrl",
  "chainId",
  "chains",
  "controllingTopN",
  "defaultChainId",
  "minSafeQuorumPct",
  "registryOverride",
  "rpcUrl",
  "startupIssues",
  "statePath",
  "subgraphChainId",
  "subgraphInteractionsUrl",
  "subgraphPoolsUrl",
  "subgraphUrls",
  "subgraphValidatorsUrl",
  "toolsets",
  "usingPublicRpcFallback",
];

let savedEnv: NodeJS.ProcessEnv;
let stderr: string[];

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DEXE_") || k.startsWith("AGENT_")) delete process.env[k];
  }
  // An RPC, so the write loader (the control) actually reaches its key parsing.
  process.env.DEXE_RPC_URL_TESTNET = "https://rpc.example/testnet";
  walletCtor.mockClear();
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

const serialized = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x instanceof Map ? Object.fromEntries(x) : typeof x === "bigint" ? x.toString() : x,
  );

describe("loadReadConfig next to the write edition's secrets", () => {
  it("returns only read fields, constructs no Wallet and prints nothing about signing", async () => {
    Object.assign(process.env, WRITE_ENV);

    const config = await loadReadConfig();

    expect(Object.keys(config).sort()).toEqual(READ_FIELDS);
    for (const field of [
      "privateKey",
      "agentKeys",
      "pinataJwt",
      "walletConnectProjectId",
      "walletConnectRelayUrl",
      "walletConnectApprovalTimeoutMs",
      "signerAllowlist",
      "signerMaxValueWei",
      "signerMaxBroadcastsPerMin",
      "treasuryGuard",
      "protocolPath",
      "forkBlock",
    ]) {
      expect(config, field).not.toHaveProperty(field);
    }
    const dump = serialized(config);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);

    expect(walletCtor).not.toHaveBeenCalled();
    expect(config.startupIssues).toEqual([]);

    const out = stderr.join("");
    expect(out).toContain("chains: [97*]");
    expect(out).not.toMatch(/signing|keyring|WalletConnect|DeXe-Protocol checkout|dexe_wc_connect/i);
    for (const k of Object.keys(WRITE_ENV)) expect(out).not.toContain(k);
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });

  it("control: the write loader on the same env DOES construct Wallets and announce the signer", async () => {
    Object.assign(process.env, WRITE_ENV);

    const config = await loadConfig();

    expect(walletCtor).toHaveBeenCalled();
    expect(config.privateKey).toBe(KEY_1);
    expect(Object.keys(config.agentKeys).sort()).toEqual(["agent1", "agent2", "funder"]);
    expect(stderr.join("")).toMatch(/signing enabled for 0x/);
  });

  it("ignores malformed write values: no issue, no warning, and the values stay put", async () => {
    Object.assign(process.env, MALFORMED_WRITE_ENV);

    const config = await loadReadConfig();

    expect(config.startupIssues).toEqual([]);
    const out = stderr.join("");
    expect(out).not.toMatch(/env error|config issue/);
    for (const k of Object.keys(MALFORMED_WRITE_ENV)) expect(out).not.toContain(k);
    // Not the read loader's to delete: a write edition in another process may own them.
    for (const [k, v] of Object.entries(MALFORMED_WRITE_ENV)) expect(process.env[k]).toBe(v);
    expect(walletCtor).not.toHaveBeenCalled();
  });

  it("still validates and degrades its own (read) vars", async () => {
    process.env.DEXE_MIN_SAFE_QUORUM_PCT = "half";
    process.env.DEXE_BACKEND_API_URL = "not a url";

    const config = await loadReadConfig();

    expect(config.startupIssues.map((i) => i.key).sort()).toEqual([
      "DEXE_BACKEND_API_URL",
      "DEXE_MIN_SAFE_QUORUM_PCT",
    ]);
    expect(config.minSafeQuorumPct).toBe(50);
    expect(config.backendApiUrl).toBe("https://api.dexe.io");
    expect(stderr.join("")).toContain("value ignored, using the built-in default");
  });

  it("agrees with the write loader on every read field", async () => {
    Object.assign(process.env, WRITE_ENV, {
      DEXE_RPC_URL_MAINNET: "https://rpc.example/mainnet,https://rpc2.example/mainnet",
      DEXE_DEFAULT_CHAIN_ID: "56",
      DEXE_SUBGRAPH_POOLS_URL_97: "https://graph.example/pools-97",
      DEXE_CONTROLLING_TOPN: "7",
      DEXE_TOOLSETS: "core,read",
    });

    const read = await loadReadConfig();
    const write = await loadConfig();

    const pick = (c: object) =>
      serialized(Object.fromEntries(READ_FIELDS.map((f) => [f, (c as Record<string, unknown>)[f]])));
    expect(pick(write)).toBe(pick(read));
  });
});

describe(".env loading with the read surface", () => {
  // loadEnvFile's process-wide load record is not reset here (that hook is not
  // part of the read edition's API); nothing below reads it, and the inlined
  // package gives every test file its own copy.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dexe-read-env-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not call the write edition's vars typos — but still catches real ones", () => {
    const p = join(dir, ".env");
    writeFileSync(
      p,
      [
        `DEXE_PRIVATE_KEY=${KEY_1}`,
        `DEXE_AGENT_PK_3=${KEY_2}`,
        `DEXE_PINATA_JWT=${PINATA_JWT}`,
        `DEXE_WALLETCONNECT_PROJECT_ID=${WC_ID}`,
        `DEXE_SAFE_API_KEY=${SAFE_KEY}`,
        "DEXE_PROTOCOL_REF=main",
        "DEXE_RPC_URL_MAINET=https://typo.example",
        "",
      ].join("\n"),
    );

    const read = loadEnvFile(p, new Set());
    expect(read.unknownDexeVars).toEqual(["DEXE_RPC_URL_MAINET"]);
    // Nothing of the write edition is offered as a flow to unlock.
    for (const { key } of read.missingButEnablesFlows) {
      expect(["DEXE_PRIVATE_KEY", "DEXE_PINATA_JWT", "DEXE_WALLETCONNECT_PROJECT_ID", "DEXE_SAFE_TX_SERVICE_URL"]).not.toContain(key);
    }

    // The single server's surface knows them all, so the same typo is the only unknown.
    const full = loadEnvFile(p, new Set(), FULL_ENV_SURFACE);
    expect(full.unknownDexeVars).toEqual(["DEXE_RPC_URL_MAINET"]);
  });
});
