/**
 * Swarm preflight — verify wallet pool is ready to run.
 *
 * Checks:
 *   1. SWARM_RPC_URL reachable, chainId matches.
 *   2. AGENT_PK_1..8 + AGENT_FUNDER_PK present and well-formed.
 *   3. Each pool wallet meets its BNB + token-balance threshold.
 *   4. SWARM_DAOS / SWARM_TOKENS allowlists are non-empty.
 *
 * Exits non-zero on any RED row so CI / orchestrator can abort early.
 *
 * Usage:  tsx scripts/swarm/preflight.ts
 */

import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";

process.loadEnvFile?.();

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

interface RoleSpec {
  envKey: string;
  role: string;
  minBnb: bigint;
  minToken: bigint;
}

// Mirrors fund-pool.ts. Lifecycle scenarios on the testnet fixture DAOs need
// only a few thousand tokens to satisfy quorum; over-sizing exhausts the
// funder's GLCR pool with no path to refill without re-minting the test token.
const FIVE_K = 5_000n * 10n ** 18n;
const TWO_K = 2_000n * 10n ** 18n;
const ONE_K = 1_000n * 10n ** 18n;
const ZERO = 0n;

// BSC gas is cheap (~0.1 gwei, sub-cent per typical tx). Thresholds tuned for
// ~50 full runs of headroom, not per-run cost.
const TWO_MILLI_BNB = 2_000_000_000_000_000n;       // ~$1.20 — covers ~30 normal txs
const FIVE_MILLI_BNB = 5_000_000_000_000_000n;      // ~$3.00 — covers DAO deploy + proposals
const FIFTY_MILLI_BNB = 50_000_000_000_000_000n;    // ~$30   — funder reserve

const POOL: RoleSpec[] = [
  { envKey: "AGENT_PK_1", role: "Proposer", minBnb: FIVE_MILLI_BNB, minToken: FIVE_K },
  { envKey: "AGENT_PK_2", role: "Voter1/Delegator", minBnb: TWO_MILLI_BNB, minToken: TWO_K },
  { envKey: "AGENT_PK_3", role: "Voter2/Delegator", minBnb: TWO_MILLI_BNB, minToken: TWO_K },
  { envKey: "AGENT_PK_4", role: "Voter3/Delegator", minBnb: TWO_MILLI_BNB, minToken: TWO_K },
  { envKey: "AGENT_PK_5", role: "Voter4/Delegator", minBnb: TWO_MILLI_BNB, minToken: TWO_K },
  { envKey: "AGENT_PK_6", role: "Validator1", minBnb: TWO_MILLI_BNB, minToken: ZERO },
  { envKey: "AGENT_PK_7", role: "Validator2", minBnb: TWO_MILLI_BNB, minToken: ZERO },
  { envKey: "AGENT_PK_8", role: "Expert/Applicant", minBnb: TWO_MILLI_BNB, minToken: ONE_K },
  { envKey: "AGENT_FUNDER_PK", role: "Funder", minBnb: FIFTY_MILLI_BNB, minToken: ZERO },
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

function requireEnv(key: string, fallback?: string): string {
  const v = process.env[key]?.trim();
  if (!v) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env: ${key}`);
  }
  return v;
}

function parseList(key: string): string[] {
  return (process.env[key]?.trim() ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

function fmtBnb(wei: bigint): string {
  return Number(formatEther(wei)).toFixed(4);
}

interface WalletRow {
  envKey: string;
  role: string;
  address: string;
  bnb: bigint;
  bnbOk: boolean;
  tokens: { symbol: string; balance: bigint; decimals: number; ok: boolean }[];
  rowOk: boolean;
}

async function main() {
  const expectedChainId = Number(
    requireEnv("SWARM_CHAIN_ID", process.env.DEXE_CHAIN_ID?.trim() ?? "56"),
  );
  const chainTag = expectedChainId === 56 ? "MAINNET" : expectedChainId === 97 ? "TESTNET" : null;
  if (!chainTag) fail(`Unsupported SWARM_CHAIN_ID=${expectedChainId} (only 56 mainnet / 97 testnet).`);

  const rpcUrl =
    process.env[`SWARM_RPC_URL_${chainTag}`]?.trim() ||
    process.env.SWARM_RPC_URL?.trim() ||
    process.env.DEXE_RPC_URL?.trim() ||
    "";
  if (!rpcUrl) throw new Error(`Set SWARM_RPC_URL_${chainTag} or SWARM_RPC_URL or DEXE_RPC_URL.`);

  const tokens = parseList(`SWARM_TOKENS_${chainTag}`);
  const daos = parseList(`SWARM_DAOS_${chainTag}`);
  if (tokens.length === 0) {
    fail(`SWARM_TOKENS_${chainTag} allowlist is empty — refuse to run.`);
  }
  if (daos.length === 0) {
    fail(`SWARM_DAOS_${chainTag} allowlist is empty — refuse to run.`);
  }
  for (const t of tokens) {
    if (!isHexAddress(t)) fail(`Bad token addr in SWARM_TOKENS_${chainTag}: ${t}`);
  }
  for (const d of daos) {
    if (!isHexAddress(d)) fail(`Bad DAO addr in SWARM_DAOS_${chainTag}: ${d}`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== expectedChainId) {
    fail(`RPC chainId ${net.chainId} != expected ${expectedChainId}`);
  }
  console.log(`${GREEN}✓${RESET} RPC ${rpcUrl} → chain ${net.chainId} (${chainTag})`);
  console.log(`${GREEN}✓${RESET} Allowlist: ${daos.length} DAOs, ${tokens.length} tokens`);

  const tokenMeta = await Promise.all(
    tokens.map(async (addr) => {
      const c = new Contract(addr, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([
        c.symbol().catch(() => "?"),
        c.decimals().catch(() => 18),
      ]);
      return { addr, symbol: String(symbol), decimals: Number(decimals) };
    }),
  );

  const rows: WalletRow[] = [];
  for (const spec of POOL) {
    const pk = process.env[spec.envKey]?.trim();
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      rows.push({
        envKey: spec.envKey,
        role: spec.role,
        address: "<missing or bad PK>",
        bnb: 0n,
        bnbOk: false,
        tokens: [],
        rowOk: false,
      });
      continue;
    }
    const w = new Wallet(pk);
    const bnb = await provider.getBalance(w.address);
    const bnbOk = bnb >= spec.minBnb;

    const tokenRows = await Promise.all(
      tokenMeta.map(async (tm) => {
        const c = new Contract(tm.addr, ERC20_ABI, provider);
        const bal: bigint = await c.balanceOf(w.address);
        const ok = spec.minToken === 0n || bal >= spec.minToken;
        return { symbol: tm.symbol, balance: bal, decimals: tm.decimals, ok };
      }),
    );
    const allTokensOk = spec.minToken === 0n || tokenRows.some((t) => t.ok);
    rows.push({
      envKey: spec.envKey,
      role: spec.role,
      address: w.address,
      bnb,
      bnbOk,
      tokens: tokenRows,
      rowOk: bnbOk && allTokensOk,
    });
  }

  console.log("");
  console.log("Wallet pool:");
  console.log("─".repeat(120));
  console.log(
    "  " +
      pad("Env", 18) +
      pad("Role", 18) +
      pad("Address", 44) +
      pad("BNB", 12) +
      "Tokens",
  );
  console.log("─".repeat(120));
  for (const r of rows) {
    const colour = r.rowOk ? GREEN : RED;
    const tokenStr = r.tokens
      .map((t) => `${t.symbol}=${Number(formatUnits(t.balance, t.decimals)).toFixed(0)}${t.ok ? "" : "!"}`)
      .join(" ");
    console.log(
      `${colour}${r.rowOk ? "✓" : "✗"}${RESET} ` +
        pad(r.envKey, 18) +
        pad(r.role, 18) +
        pad(r.address, 44) +
        pad(`${fmtBnb(r.bnb)}${r.bnbOk ? "" : "!"}`, 12) +
        tokenStr,
    );
  }
  console.log("─".repeat(120));

  const failedRows = rows.filter((r) => !r.rowOk);
  if (failedRows.length > 0) {
    console.log(
      `${RED}${failedRows.length}/${rows.length} wallet(s) under threshold.${RESET}`,
    );
    console.log(`${YELLOW}Hint: run 'npm run swarm:fund -- --confirm' to top up.${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}All ${rows.length} wallets ready.${RESET}`);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length);
}

function fail(msg: string): never {
  console.error(`${RED}preflight: ${msg}${RESET}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`${RED}preflight crashed:${RESET}`, err);
  process.exit(2);
});
