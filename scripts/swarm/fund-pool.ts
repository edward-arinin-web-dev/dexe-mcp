/**
 * Swarm fund-pool — top up the 8 agent wallets from AGENT_FUNDER_PK.
 *
 * Hard invariants enforced before any tx is broadcast:
 *   - Every recipient is one of AGENT_PK_1..8 (derived locally).
 *   - Every token transferred is in SWARM_TOKENS allowlist.
 *   - Funder wallet is not the recipient.
 *
 * Without `--confirm`, runs in dry-run mode (prints planned transfers, no
 * broadcast). Pass `--confirm` only when ready to spend real BNB.
 *
 * Usage:
 *   tsx scripts/swarm/fund-pool.ts            # dry-run
 *   tsx scripts/swarm/fund-pool.ts --confirm  # broadcast
 */

import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, parseUnits } from "ethers";

process.loadEnvFile?.();

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
] as const;

interface RoleSpec {
  envKey: string;
  role: string;
  targetBnb: bigint;
  targetToken: bigint;
}

// Token targets sized for the BSC-testnet fixture DAOs (Glacier 50% quorum,
// Sentinel 5% quorum) — meeting quorum on the small fixtures requires only a
// few thousand tokens, not tens of thousands. Earlier numbers (50K/20K/5K)
// exhausted the funder's GLCR pool in a single sweep with no path to refill
// without re-minting the test token. Per-role thresholds in preflight.ts
// MUST mirror these.
const FIVE_K = 5_000n * 10n ** 18n;
const TWO_K = 2_000n * 10n ** 18n;
const ONE_K = 1_000n * 10n ** 18n;
const ZERO = 0n;

// Match preflight.ts thresholds. BSC mainnet: 0.1 gwei × 200k gas ≈ sub-cent.
const TWO_MILLI_BNB = 2_000_000_000_000_000n;
const FIVE_MILLI_BNB = 5_000_000_000_000_000n;

const POOL: RoleSpec[] = [
  { envKey: "AGENT_PK_1", role: "Proposer", targetBnb: FIVE_MILLI_BNB, targetToken: FIVE_K },
  { envKey: "AGENT_PK_2", role: "Voter1", targetBnb: TWO_MILLI_BNB, targetToken: TWO_K },
  { envKey: "AGENT_PK_3", role: "Voter2", targetBnb: TWO_MILLI_BNB, targetToken: TWO_K },
  { envKey: "AGENT_PK_4", role: "Voter3", targetBnb: TWO_MILLI_BNB, targetToken: TWO_K },
  { envKey: "AGENT_PK_5", role: "Voter4", targetBnb: TWO_MILLI_BNB, targetToken: TWO_K },
  { envKey: "AGENT_PK_6", role: "Validator1", targetBnb: TWO_MILLI_BNB, targetToken: ZERO },
  { envKey: "AGENT_PK_7", role: "Validator2", targetBnb: TWO_MILLI_BNB, targetToken: ZERO },
  { envKey: "AGENT_PK_8", role: "Expert", targetBnb: TWO_MILLI_BNB, targetToken: ONE_K },
];

interface Transfer {
  recipient: string;
  recipientRole: string;
  asset: "BNB" | string;
  tokenAddr?: string;
  decimals: number;
  amount: bigint;
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

function fail(msg: string): never {
  console.error(`${RED}fund-pool: ${msg}${RESET}`);
  process.exit(1);
}

async function main() {
  const confirm = process.argv.includes("--confirm");

  const expectedChainId = Number(
    (process.env.SWARM_CHAIN_ID ?? process.env.DEXE_CHAIN_ID ?? "56").trim(),
  );
  const chainTag = expectedChainId === 56 ? "MAINNET" : expectedChainId === 97 ? "TESTNET" : null;
  if (!chainTag) fail(`Unsupported SWARM_CHAIN_ID=${expectedChainId} (only 56 mainnet / 97 testnet).`);

  const rpcUrl =
    (process.env[`SWARM_RPC_URL_${chainTag}`] ??
      process.env.SWARM_RPC_URL ??
      process.env.DEXE_RPC_URL ??
      "").trim();
  if (!rpcUrl) fail(`Set SWARM_RPC_URL_${chainTag} or SWARM_RPC_URL or DEXE_RPC_URL.`);

  const funderPk = process.env.AGENT_FUNDER_PK?.trim();
  if (!funderPk || !/^0x[0-9a-fA-F]{64}$/.test(funderPk)) {
    fail("AGENT_FUNDER_PK missing or malformed.");
  }

  const tokenAllowlist = parseList(`SWARM_TOKENS_${chainTag}`).map((a) => a.toLowerCase());
  if (tokenAllowlist.length === 0) fail(`SWARM_TOKENS_${chainTag} empty — refuse to run.`);
  for (const t of tokenAllowlist) {
    if (!isHexAddress(t)) fail(`Bad token addr in SWARM_TOKENS_${chainTag}: ${t}`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const funder = new Wallet(funderPk, provider);

  const recipientAddrs = new Set<string>();
  const recipients: { spec: RoleSpec; addr: string }[] = [];
  for (const spec of POOL) {
    const pk = process.env[spec.envKey]?.trim();
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      fail(`${spec.envKey} missing or malformed — fund-pool refuses partial pool.`);
    }
    const addr = new Wallet(pk).address;
    if (addr.toLowerCase() === funder.address.toLowerCase()) {
      fail(`${spec.envKey} resolves to funder address — refuse to self-fund.`);
    }
    recipientAddrs.add(addr.toLowerCase());
    recipients.push({ spec, addr });
  }

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== expectedChainId) {
    fail(`RPC chainId ${net.chainId} != expected ${expectedChainId}`);
  }
  console.log(`Chain:  ${net.chainId} (${chainTag})`);
  console.log(`Funder: ${funder.address}`);
  console.log(`Pool:   ${recipients.length} wallets`);
  console.log(`Tokens: ${tokenAllowlist.join(", ")}`);
  console.log(`Mode:   ${confirm ? "BROADCAST" : "dry-run"}`);

  const tokenMeta = await Promise.all(
    tokenAllowlist.map(async (addr) => {
      const c = new Contract(addr, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([
        c.symbol().catch(() => "?"),
        c.decimals().catch(() => 18),
      ]);
      return { addr, symbol: String(symbol), decimals: Number(decimals) };
    }),
  );

  const transfers: Transfer[] = [];

  for (const { spec, addr } of recipients) {
    const bnb = await provider.getBalance(addr);
    if (bnb < spec.targetBnb) {
      transfers.push({
        recipient: addr,
        recipientRole: `${spec.envKey}/${spec.role}`,
        asset: "BNB",
        decimals: 18,
        amount: spec.targetBnb - bnb,
      });
    }
    if (spec.targetToken > 0n && tokenMeta.length > 0) {
      const primary = tokenMeta[0]!;
      const c = new Contract(primary.addr, ERC20_ABI, provider);
      const bal: bigint = await c.balanceOf(addr);
      if (bal < spec.targetToken) {
        transfers.push({
          recipient: addr,
          recipientRole: `${spec.envKey}/${spec.role}`,
          asset: primary.symbol,
          tokenAddr: primary.addr,
          decimals: primary.decimals,
          amount: spec.targetToken - bal,
        });
      }
    }
  }

  if (transfers.length === 0) {
    console.log(`${GREEN}Pool already at target levels — nothing to do.${RESET}`);
    return;
  }

  console.log("");
  console.log(`${YELLOW}Planned transfers:${RESET}`);
  for (const t of transfers) {
    if (t.asset === "BNB") {
      console.log(`  → ${t.recipientRole}  ${formatEther(t.amount)} BNB  (${t.recipient})`);
    } else {
      console.log(
        `  → ${t.recipientRole}  ${formatUnits(t.amount, t.decimals)} ${t.asset}  (${t.recipient})`,
      );
    }
  }

  for (const t of transfers) {
    if (t.asset !== "BNB") {
      if (!t.tokenAddr) fail("Internal: missing tokenAddr on token transfer.");
      if (!tokenAllowlist.includes(t.tokenAddr.toLowerCase())) {
        fail(`Token ${t.tokenAddr} not in SWARM_TOKENS allowlist — abort.`);
      }
    }
    if (!recipientAddrs.has(t.recipient.toLowerCase())) {
      fail(`Recipient ${t.recipient} not in derived pool — abort.`);
    }
  }

  const totalBnbOut = transfers
    .filter((t) => t.asset === "BNB")
    .reduce((acc, t) => acc + t.amount, 0n);
  console.log(`Total BNB to send: ${formatEther(totalBnbOut)}`);

  if (!confirm) {
    console.log(`${YELLOW}Dry-run only. Re-run with --confirm to broadcast.${RESET}`);
    return;
  }

  let nonce = await provider.getTransactionCount(funder.address, "pending");
  for (const t of transfers) {
    if (t.asset === "BNB") {
      console.log(`Sending ${formatEther(t.amount)} BNB → ${t.recipient} (nonce ${nonce})`);
      const tx = await funder.sendTransaction({ to: t.recipient, value: t.amount, nonce });
      const r = await tx.wait();
      console.log(`  ✓ ${tx.hash}  block ${r?.blockNumber}`);
    } else {
      const c = new Contract(t.tokenAddr!, ERC20_ABI, funder);
      console.log(
        `Sending ${formatUnits(t.amount, t.decimals)} ${t.asset} → ${t.recipient} (nonce ${nonce})`,
      );
      const tx = await c.transfer(t.recipient, t.amount, { nonce });
      const r = await tx.wait();
      console.log(`  ✓ ${tx.hash}  block ${r?.blockNumber}`);
    }
    nonce += 1;
  }
  console.log(`${GREEN}Done — ${transfers.length} transfer(s) broadcast.${RESET}`);
}

main().catch((err) => {
  console.error(`${RED}fund-pool crashed:${RESET}`, err);
  process.exit(2);
});
