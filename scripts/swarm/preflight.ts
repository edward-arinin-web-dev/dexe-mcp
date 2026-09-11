/**
 * Swarm preflight — verify the harness is ready to run.
 *
 * Checks:
 *   1. dist/index.js exists and is not older than src/ (the orchestrator spawns
 *      the BUILT server; a stale dist certifies the wrong code).
 *   2. SWARM_RPC_URL reachable, chainId matches.
 *   3. SWARM_DAOS / SWARM_TOKENS allowlists are non-empty, index-parallel, and
 *      every DAO is a registered GovPool (else every composite refuses it).
 *   4. AGENT_PK_1..8 + AGENT_FUNDER_PK present and well-formed.
 *   5. Each pool wallet meets its BNB + token-balance threshold.
 *
 * Exits non-zero on any RED row so CI / orchestrator can abort early — BEFORE
 * the orchestrator's prefund block moves any value.
 *
 * Usage:  tsx scripts/swarm/preflight.ts
 */

import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { resolve } from "node:path";
import {
  assertIndexParallel,
  checkDaosRegistered,
  checkTokenPairing,
  makeGovTokenReader,
  makeIsGovPool,
  tokenPairingMessage,
  unregisteredFixtureMessage,
} from "./allowlist-guard.js";
import { assertDistFresh, fileMtime, newestMtime } from "./dist-freshness.mjs";

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

  // ---- dist/ freshness -------------------------------------------------
  // First row on purpose: the orchestrator runs `node dist/index.js`, so a
  // stale or missing build means the whole sweep grades the previously-built
  // server. Fail here, before any gas is spent.
  {
    const verdict = assertDistFresh(fileMtime(resolve("dist/index.js")), newestMtime(resolve("src")));
    if (!verdict.ok) {
      if (verdict.level === "missing" || process.env.SWARM_SKIP_DIST_CHECK !== "1") {
        fail(verdict.message);
      }
      console.log(`${YELLOW}~${RESET} ${verdict.message}`);
    } else {
      console.log(`${GREEN}✓${RESET} dist/index.js is newer than src/`);
    }
  }

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

  // Predicted per-DAO helpers ({{dao.tokenSale}} / {{dao.distributionProposal}}).
  // Optional — scenarios that need them fail loudly on an empty template — but
  // when present they are WRITE TARGETS (proposal executors), so they get the
  // same allowlist treatment as tokens and DAOs: shape-checked and index-parallel.
  for (const [key, label] of [
    [`SWARM_TOKENSALE_${chainTag}`, "token-sale"],
    [`SWARM_DISTRIBUTION_${chainTag}`, "distribution-proposal"],
  ] as const) {
    const list = parseList(key);
    if (list.length === 0) continue;
    for (const a of list) {
      if (!isHexAddress(a)) {
        fail(`Bad ${label} addr in ${key}: ${a} — one address per DAO in SWARM_DAOS_${chainTag}, same order.`);
      }
    }
    if (list.length !== daos.length) {
      fail(
        `${key} has ${list.length} entr${list.length === 1 ? "y" : "ies"} but SWARM_DAOS_${chainTag} has ` +
          `${daos.length}. The lists are index-parallel: entry i must be DAO i's ${label} helper.`,
      );
    }
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== expectedChainId) {
    fail(`RPC chainId ${net.chainId} != expected ${expectedChainId}`);
  }
  console.log(`${GREEN}✓${RESET} RPC ${rpcUrl} → chain ${net.chainId} (${chainTag})`);
  console.log(`${GREEN}✓${RESET} Allowlist: ${daos.length} DAOs, ${tokens.length} tokens`);

  // ---- allowlist coherence ---------------------------------------------
  // Runs after `provider` exists and the chain id is asserted — an RPC call
  // cannot happen before either.
  const parityErr = assertIndexParallel(daos, tokens, chainTag);
  if (parityErr) fail(parityErr);

  try {
    const isGovPool = await makeIsGovPool(provider, expectedChainId);
    const { unregistered, verified } = await checkDaosRegistered(daos, isGovPool);
    if (verified && unregistered.length > 0) {
      fail(unregisteredFixtureMessage(unregistered[0]!, daos.indexOf(unregistered[0]!), chainTag, expectedChainId));
    }
    console.log(
      verified
        ? `${GREEN}✓${RESET} All ${daos.length} fixture DAO(s) registered in PoolRegistry`
        : `${YELLOW}~${RESET} Could not verify fixture registration (registry unresolvable) — continuing`,
    );
  } catch {
    console.log(`${YELLOW}~${RESET} Fixture registration check skipped (RPC/registry unavailable).`);
  }

  try {
    const pairing = await checkTokenPairing(daos, tokens, makeGovTokenReader(provider));
    if (pairing.mismatches.length > 0) fail(tokenPairingMessage(pairing.mismatches[0]!, chainTag));
    console.log(
      pairing.verified
        ? `${GREEN}✓${RESET} SWARM_TOKENS_${chainTag} is index-parallel to SWARM_DAOS_${chainTag}`
        : `${YELLOW}~${RESET} Could not verify every DAO↔token pairing — continuing`,
    );
  } catch {
    console.log(`${YELLOW}~${RESET} DAO↔token pairing check skipped (RPC unavailable).`);
  }

  // Signer guards apply to any `serverSign` step (the MCP, not this process,
  // broadcasts those) — surface them so a B6/B7/B10 refusal is not blamed on
  // the server.
  const signerGuards = [
    "DEXE_SIGNER_ALLOWLIST",
    "DEXE_SIGNER_MAX_VALUE_WEI",
    "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
    "DEXE_AGENT_FUND_MAX_WEI",
    "SWARM_DAILY_BNB_BUDGET",
  ].filter((k) => (process.env[k]?.trim() ?? "") !== "");
  if (signerGuards.length > 0) {
    console.log(
      `${YELLOW}~${RESET} Signer guards armed for serverSign steps: ${signerGuards.join(", ")}`,
    );
  }

  const tokenMeta = await Promise.all(
    tokens.map(async (addr, i) => {
      const c = new Contract(addr, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([
        c.symbol().catch(() => "?"),
        c.decimals().catch(() => 18),
      ]);
      // Resolve the parallel DAO's userKeeper so we can count deposited power
      // alongside wallet balance — a wallet with funds locked behind in-flight
      // proposals still has governance power and should not block preflight.
      let userKeeper: string | null = null;
      const daoAddr = daos[i];
      if (daoAddr) {
        try {
          const gp = new Contract(
            daoAddr,
            ["function getHelperContracts() view returns (address,address,address,address,address)"],
            provider,
          );
          const helpers = await gp.getHelperContracts();
          userKeeper = helpers[1] as string;
        } catch {
          /* leave userKeeper null — falls back to wallet-only check */
        }
      }
      return { addr, symbol: String(symbol), decimals: Number(decimals), userKeeper };
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
        const walletBal: bigint = await c.balanceOf(w.address);
        let deposited: bigint = 0n;
        if (tm.userKeeper) {
          try {
            const uk = new Contract(
              tm.userKeeper,
              ["function tokenBalance(address,uint8) view returns (uint256[2])"],
              provider,
            );
            // VoteType.Personal = 0. The returned `balance` includes wallet
            // ERC20.balanceOf — userKeeper.tokenBalance(Personal).balance =
            // ERC20.balanceOf(user) + UserKeeper-side deposited. We avoid
            // double-counting by reading deposited as the difference.
            const [personalBalance] = (await uk.tokenBalance(w.address, 0)) as [bigint, bigint];
            deposited = personalBalance > walletBal ? personalBalance - walletBal : 0n;
          } catch {
            /* keep deposited at 0 — wallet-only check */
          }
        }
        const effective = walletBal + deposited;
        const ok = spec.minToken === 0n || effective >= spec.minToken;
        return { symbol: tm.symbol, balance: walletBal, deposited, decimals: tm.decimals, ok };
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
