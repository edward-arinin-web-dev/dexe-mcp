import { z } from "zod";
import { Interface, Wallet, formatEther, formatUnits, isAddress, parseUnits } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SignerManager } from "../lib/signer.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { createChainProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import { waitWithTimeout, txWaitTimeoutMs } from "../lib/txWait.js";
import { toActionableError } from "../lib/errors.js";
import { chainIdParam } from "../lib/params.js";
import { parseAmount } from "../lib/units.js";
import { safeErrorMessage } from "../lib/redact.js";
import {
  BroadcastGuardError,
  assertAllowlistAndValueCap,
  runBroadcastGuards,
} from "../lib/broadcastGuards.js";
import {
  DAY_MS,
  evaluateBudget,
  getAgentLedger,
  ledgerEnabled,
  resolveLedgerPath,
  withActionContext,
  type AgentAction,
  type BudgetStatus,
  type SpendReport,
} from "../lib/agentLedger.js";

/**
 * Agent-keyring tools (0.28.0 keyring, 0.32.0 orchestration hardening).
 *
 * The opt-in `DEXE_AGENT_PK_1..16` keyring gives multi-persona / swarm flows
 * real distinct signers, selectable per call via `signerKey` on `dexe_tx_send`
 * and the composites. Three tools cover the operational side:
 *
 *  - `dexe_agents_list`   — who is in the keyring + native/token balances.
 *  - `dexe_agents_fund`   — top the agents up from the PRIMARY signer.
 *  - `dexe_agents_ledger` — what the fleet actually did, and what it cost.
 *
 * ── Why this file changed in 0.32.0 ────────────────────────────────────────
 *
 * `dexe_agents_fund` is the one tool in the server that exists to MOVE VALUE to
 * a set of autonomous hot keys, and it shipped with:
 *
 *   1. **no broadcast guards at all.** `runBroadcastGuards` appears in
 *      `dexe_tx_send` and the composite flow loop; this file called none of
 *      them, while docs/SECURITY.md published a table saying B6/B7/B9/B10
 *      applied to every broadcast. Every transfer here skipped the destination
 *      allowlist, the value cap, the eth_call preflight, the rate limit and the
 *      chain-coherence probe. Now every transfer goes through
 *      `runBroadcastGuards`, and the stateless half (B6/B7) additionally runs
 *      over the WHOLE plan before anything is previewed, so a plan that cannot
 *      execute is refused instead of displayed.
 *   2. **a decimals-blind cap.** `DEXE_AGENT_FUND_MAX_WEI` (default 0.1 native,
 *      i.e. 1e17) was compared against a raw token amount, so for a 6-decimals
 *      ERC20 the "0.1" cap permitted 1e17 units = 100,000,000,000 tokens. The
 *      cap is now rescaled into the token's own units (`fundCapInUnits`), and a
 *      token whose `decimals()` cannot be read is REFUSED — an unbounded
 *      transfer is never the safe default.
 *   3. **no budget.** `SWARM_DAILY_BNB_BUDGET` was documented in
 *      docs/ENVIRONMENT.md and .env.example as an enforced daily spend guard
 *      and was read by no code in the repo. It is now enforced from the agent
 *      ledger's spend accounting (`dailyBudget` + `evaluateBudget`), rechecked
 *      before EVERY transfer so a batch stops at the boundary instead of
 *      blowing through it.
 *   4. **no confirmation.** It broadcast on the first call. It now previews and
 *      requires `confirm: true`, matching `dexe_dao_create` (preview → confirm)
 *      and `dexe_safe_propose_tx` (dryRun by default).
 *
 * Recipients could only ever be keyring addresses; that guard was already here
 * and is unchanged.
 */

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const DEFAULT_FUND_CAP_WEI = 100_000_000_000_000_000n; // 0.1 native

/** Sanity bound on a token's `decimals()` — beyond this the rescaled cap is nonsense. */
const MAX_TOKEN_DECIMALS = 36;

export function fundCapWei(): bigint {
  const raw = process.env.DEXE_AGENT_FUND_MAX_WEI?.trim();
  if (!raw) return DEFAULT_FUND_CAP_WEI;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : DEFAULT_FUND_CAP_WEI;
  } catch {
    return DEFAULT_FUND_CAP_WEI;
  }
}

/**
 * The per-agent cap expressed in a token's OWN smallest units.
 *
 * `DEXE_AGENT_FUND_MAX_WEI` is a native-scale (18-decimals) number: the default
 * 1e17 means "0.1 of a coin". Comparing that number directly against an ERC20
 * amount — which is what this file used to do — reads it as 1e17 *token units*,
 * so a 6-decimals stablecoin was capped at 100 billion tokens instead of 0.1.
 * Rescaling keeps the operator's intent ("0.1 of a thing") across decimals.
 *
 * Integer division floors, which can only make the cap SMALLER — the safe
 * direction. A cap that floors to zero (e.g. 0.1 of a 0-decimals token cannot
 * be expressed) is reported by the caller rather than silently blocking, since
 * "cap = 0" and "no cap" must never be confusable.
 */
export function fundCapInUnits(decimals: number): bigint {
  const capWei = fundCapWei();
  if (decimals === 18) return capWei;
  if (decimals < 18) return capWei / 10n ** BigInt(18 - decimals);
  return capWei * 10n ** BigInt(decimals - 18);
}

/**
 * Chains whose native coin is free (faucet testnets). The daily spend budget is
 * a MONEY guard, so its default only arms itself where the coin is money —
 * otherwise the documented testnet-first workflow (`SWARM_CHAIN_ID=97`, fund 8
 * agents with 0.1 tBNB each) would be refused by a guard protecting nothing.
 *
 * An explicit `SWARM_DAILY_BNB_BUDGET` is enforced on EVERY chain including
 * these, and an unrecognized chain id is treated as real money (fail closed).
 */
export const FREE_COIN_CHAIN_IDS: ReadonlySet<number> = new Set([
  97, // BSC testnet
  5, // Goerli
  17_000, // Holesky
  11_155_111, // Sepolia
  80_002, // Polygon Amoy
  84_532, // Base Sepolia
  421_614, // Arbitrum Sepolia
  11_155_420, // OP Sepolia
]);

/** Documented default in docs/ENVIRONMENT.md and .env.example: 0.05 BNB / day. */
export const DEFAULT_DAILY_BUDGET_WEI = 50_000_000_000_000_000n;

export type DailyBudget =
  | { mode: "enforced"; budgetWei: bigint; source: "env" | "default" }
  | { mode: "disabled"; reason: string }
  | { mode: "invalid"; message: string };

/**
 * Resolve `SWARM_DAILY_BNB_BUDGET` into a policy.
 *
 *   unset + value-bearing chain → the documented 0.05 default, ENFORCED
 *   unset + faucet testnet      → disabled (see FREE_COIN_CHAIN_IDS)
 *   'off'/'none'/'unlimited'    → disabled, explicitly
 *   a decimal amount            → enforced on every chain
 *   anything else               → INVALID; the caller must refuse to fund
 *
 * The invalid branch is the 0.30.1 posture: a spend guard this server cannot
 * parse disables spending, it does not disable the guard. `0` is honoured as a
 * real zero budget (spend nothing) — the way to mean "no limit" is `off`.
 */
export function dailyBudget(chainId: number, env: NodeJS.ProcessEnv = process.env): DailyBudget {
  const raw = env.SWARM_DAILY_BNB_BUDGET?.trim();
  if (!raw) {
    if (FREE_COIN_CHAIN_IDS.has(chainId)) {
      return {
        mode: "disabled",
        reason:
          `chain ${chainId} is a faucet testnet — its coin has no value, so the default budget is not armed. ` +
          `Set SWARM_DAILY_BNB_BUDGET to enforce a cap here too.`,
      };
    }
    return { mode: "enforced", budgetWei: DEFAULT_DAILY_BUDGET_WEI, source: "default" };
  }
  const lower = raw.toLowerCase();
  if (lower === "off" || lower === "none" || lower === "unlimited" || lower === "false") {
    return { mode: "disabled", reason: "SWARM_DAILY_BNB_BUDGET is explicitly off" };
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return { mode: "invalid", message: invalidBudgetMessage(raw) };
  }
  try {
    return { mode: "enforced", budgetWei: parseUnits(raw, 18), source: "env" };
  } catch {
    return { mode: "invalid", message: invalidBudgetMessage(raw) };
  }
}

function invalidBudgetMessage(raw: string): string {
  return (
    `SWARM_DAILY_BNB_BUDGET is set to '${raw}', which is not a native-coin amount. ` +
    `Refusing to fund: a spend guard this server cannot read must disable spending, not disable itself. ` +
    `Use a decimal amount of the native coin ('0.05'), or 'off' to remove the cap deliberately.`
  );
}

/** Human refusal text for a transfer that would break the rolling-window budget. */
export function budgetRefusal(
  chainId: number,
  before: BudgetStatus,
  after: BudgetStatus,
  costWei: bigint,
): string {
  return (
    `Daily spend budget exceeded on chain ${chainId}. The last 24h already cost ` +
    `${formatEther(before.usedWei)} of the ${formatEther(before.budgetWei)} allowed by SWARM_DAILY_BNB_BUDGET; ` +
    `this transfer adds ${formatEther(costWei)}, taking the total to ${formatEther(after.usedWei)}. ` +
    `Refusing to broadcast. Raise SWARM_DAILY_BNB_BUDGET, set it to 'off' to remove the cap deliberately, ` +
    `or wait for the rolling window to clear. Spend so far is itemized by dexe_agents_ledger.`
  );
}

/**
 * Resolve the set of keyring slots to fund, ALWAYS excluding the funding source.
 * The source is filtered on BOTH the default (whole-keyring) and the explicit-
 * `agents` branch — an explicit list that names the source would otherwise
 * self-transfer (nets to zero minus gas, never reaches a target, and an upfront
 * insufficient-funds check on the self-send would block the rest of the batch).
 * Throws for a requested slot that is not in the keyring.
 */
export function resolveFundTargets<T extends { signerKey: string; address: string }>(
  keyring: T[],
  requested: string[],
  sourceKey?: string,
): T[] {
  const base =
    requested.length === 0
      ? keyring
      : requested.map((r) => {
          const hit = keyring.find(
            (a) => a.signerKey === r.trim().toLowerCase() || a.address.toLowerCase() === r.trim().toLowerCase(),
          );
          if (!hit) throw new Error(`'${r}' is not in the keyring (${keyring.map((a) => a.signerKey).join(", ")})`);
          return hit;
        });
  return base.filter((a) => a.signerKey !== sourceKey);
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer, 2) }],
  };
}

/** Structured refusal — a partially-executed batch must report what landed. */
function errJson(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer, 2) }],
    isError: true,
  };
}

/** The exact transaction a funding leg broadcasts — also what the guards inspect. */
export function fundTransferTx(
  recipient: string,
  amount: bigint,
  token?: string,
): { to: string; data: string; value: string } {
  return token
    ? { to: token, data: ERC20_ABI.encodeFunctionData("transfer", [recipient, amount]), value: "0" }
    : { to: recipient, data: "0x", value: amount.toString() };
}

/** Wei + human rendering side by side, so neither the model nor the operator has to convert. */
function amountView(raw: bigint, decimals: number, symbol: string) {
  return { raw: raw.toString(), amount: formatUnits(raw, decimals), symbol };
}

function budgetView(
  budget: DailyBudget,
  status: BudgetStatus | null,
): Record<string, unknown> {
  if (budget.mode !== "enforced" || !status) {
    return {
      enforced: false,
      env: "SWARM_DAILY_BNB_BUDGET",
      reason:
        budget.mode === "disabled"
          ? budget.reason
          : budget.mode === "invalid"
            ? budget.message
            : "no budget status for this call",
    };
  }
  return {
    enforced: true,
    env: "SWARM_DAILY_BNB_BUDGET",
    source: budget.source,
    windowHours: 24,
    budget: formatEther(status.budgetWei),
    budgetWei: status.budgetWei,
    used: formatEther(status.usedWei),
    usedWei: status.usedWei,
    remaining: formatEther(status.remainingWei),
    remainingWei: status.remainingWei,
    utilization: status.utilization,
    exceeded: status.exceeded,
  };
}

function spendView(report: SpendReport): Record<string, unknown> {
  const render = (r: SpendReport["total"]) => ({
    signerKey: r.signerKey,
    ...(r.address ? { address: r.address } : {}),
    actions: r.actions,
    valueWei: r.valueWei,
    gasWei: r.gasWei,
    totalWei: r.totalWei,
    total: formatEther(r.totalWei),
  });
  return { since: report.since, windowMs: report.windowMs, total: render(report.total), byAgent: report.byAgent.map(render) };
}

function recentView(entries: AgentAction[]): Array<Record<string, unknown>> {
  return entries.map((e) => ({
    at: e.at,
    signerKey: e.signerKey,
    address: e.address,
    chainId: e.chainId,
    tool: e.tool,
    action: e.action,
    outcome: e.outcome,
    ...(e.txHash ? { txHash: e.txHash } : {}),
    valueWei: e.valueWei,
    gasWei: e.gasWei,
    ...(e.note ? { note: e.note } : {}),
  }));
}

export function registerAgentTools(server: McpServer, config: DexeConfig, signer: SignerManager): void {
  server.registerTool(
    "dexe_agents_list",
    {
      title: "List the agent keyring (addresses + balances)",
      description:
        "Shows every configured keyring signer (DEXE_AGENT_PK_* or the AGENT_PK_* alias, plus the 'funder' slot " +
        "from AGENT_FUNDER_PK) — its signerKey ('agent1'…, 'funder'), address, native balance, and " +
        "optionally an ERC20 balance. Use the signerKey values with dexe_tx_send / dexe_dao_create / " +
        "dexe_proposal_create / dexe_proposal_vote_and_execute / OTC buyer composites to act from that wallet. " +
        "Keys never leave the server; this tool returns addresses only.",
      inputSchema: {
        chainId: chainIdParam,
        token: z.string().optional().describe("Optional ERC20 address — include each agent's balance of this token"),
      },
    },
    async ({ chainId, token }) => {
      const agents = signer.listAgents();
      if (agents.length === 0) {
        return err(
          "Agent keyring is empty. Set DEXE_AGENT_PK_1..16 (or the swarm naming AGENT_PK_1..16 / AGENT_FUNDER_PK) " +
            "in .env — one hot key per agent persona — and restart. " +
            "The primary DEXE_PRIVATE_KEY stays the default signer; keyring keys are selected per call via signerKey.",
        );
      }
      if (token && !isAddress(token)) return err(`Invalid token: ${token}`);
      const chain = resolveChain(config, chainId);
      const provider = createChainProvider(chain, config);
      try {
        const primary = signer.hasSigner() ? signer.getAddress() : null;
        const natives = await Promise.all(agents.map((a) => provider.getBalance(a.address)));
        let tokenBalances: bigint[] | undefined;
        let tokenSymbol: string | undefined;
        let tokenDecimals: number | undefined;
        if (token) {
          const res = await multicall(provider, [
            ...agents.map((a) => ({
              target: token,
              iface: ERC20_ABI,
              method: "balanceOf",
              args: [a.address],
              allowFailure: true,
            })),
            { target: token, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true },
            { target: token, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true },
          ]);
          tokenBalances = agents.map((_a, i) => (res[i]?.success ? (res[i]!.value as bigint) : 0n));
          tokenSymbol = res[agents.length]?.success ? String(res[agents.length]!.value) : undefined;
          tokenDecimals = res[agents.length + 1]?.success ? Number(res[agents.length + 1]!.value) : undefined;
        }
        const rows = agents.map((a, i) => ({
          signerKey: a.signerKey,
          address: a.address,
          nativeWei: natives[i]!.toString(),
          native: formatEther(natives[i]!),
          ...(tokenBalances ? { tokenBalance: tokenBalances[i]!.toString() } : {}),
        }));
        return ok({
          chainId: chain.chainId,
          primarySigner: primary,
          count: rows.length,
          ...(token ? { token, tokenSymbol, tokenDecimals } : {}),
          agents: rows,
        });
      } catch (e) {
        return err(`agents_list failed: ${toActionableError(e, "read agent balances").message}`);
      }
    },
  );

  server.registerTool(
    "dexe_agents_fund",
    {
      title: "Fund agent keyring wallets from the primary signer (preview, then confirm)",
      description:
        "Tops up keyring wallets — native coin by default, or an ERC20 via `token`. Funds FROM the primary " +
        "DEXE_PRIVATE_KEY signer by default; pass source:'funder' to send from the AGENT_FUNDER_PK wallet instead. " +
        "PREVIEWS FIRST: without confirm:true it returns who would be funded, how much each, the resolved " +
        "addresses, the total, and the remaining daily budget — nothing is broadcast. " +
        "Enforced guards: recipients can ONLY be keyring addresses; the per-agent amount is capped by " +
        "DEXE_AGENT_FUND_MAX_WEI (default 0.1 native, rescaled into an ERC20's own decimals — a token whose " +
        "decimals() cannot be read is refused); the rolling-24h spend budget SWARM_DAILY_BNB_BUDGET is checked " +
        "before every transfer; and every transfer runs the standard broadcast guards (B6 destination allowlist, " +
        "B7 value cap, B9 eth_call preflight, B10 rate limit, B11 chain coherence). Agents whose balance already " +
        "meets `amount` are skipped. Every transfer is recorded per-agent — read it back with dexe_agents_ledger.",
      inputSchema: {
        amount: z
          .string()
          .describe("Per-agent target amount: raw wei (digits-only) or human units with a decimal point ('0.05')"),
        agents: z
          .array(z.string())
          .default([])
          .describe("signerKeys to fund (e.g. ['agent1','agent3']); empty = every keyring entry"),
        token: z.string().optional().describe("Optional ERC20 to send instead of the native coin"),
        source: z
          .string()
          .optional()
          .describe("Funding wallet: omit = primary signer; 'funder' = the AGENT_FUNDER_PK keyring slot (or any keyring signerKey)"),
        chainId: chainIdParam,
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set true to actually broadcast. Without it this call is a review-only preview — funding moves real value. " +
              "When the user has already approved the amounts, pass confirm:true on the FIRST call.",
          ),
        dryRun: z.boolean().default(false).describe("Preview the transfers without broadcasting (never broadcasts, even with confirm)"),
      },
    },
    async ({ amount, agents: requested = [], token, source, chainId, confirm = false, dryRun = false }) => {
      const keyring = signer.listAgents();
      if (keyring.length === 0) {
        return err("Agent keyring is empty — set DEXE_AGENT_PK_1..16 (or AGENT_PK_1..16 / AGENT_FUNDER_PK) first.");
      }
      if (!source && !signer.hasSigner()) {
        return err(
          "Funding requires a source wallet: set the primary DEXE_PRIVATE_KEY, or pass source:'funder' to send " +
            "from the AGENT_FUNDER_PK keyring slot.",
        );
      }
      if (source && !keyring.some((a) => a.signerKey === source.trim().toLowerCase())) {
        return err(`source '${source}' is not in the keyring (${keyring.map((a) => a.signerKey).join(", ")}).`);
      }
      if (token && !isAddress(token)) return err(`Invalid token: ${token}`);

      const sourceKey = source?.trim().toLowerCase();
      let targets: Array<{ signerKey: string; address: string }>;
      try {
        targets = resolveFundTargets(keyring, requested, sourceKey);
      } catch (e) {
        return err(safeErrorMessage(e));
      }
      if (targets.length === 0) {
        return err(
          requested.length === 0
            ? "The keyring only contains the funding source — add agent slots to fund."
            : `Every requested agent resolves to the funding source '${sourceKey}' — nothing to fund.`,
        );
      }

      const chain = resolveChain(config, chainId);
      const provider = createChainProvider(chain, config);

      // ---- token decimals: FAIL CLOSED --------------------------------------
      // The per-agent cap is denominated in the token's own units. Guessing 18
      // (what this tool used to do) turns a 0.1 cap into 100,000,000,000 units
      // of a 6-decimals token, so an unreadable decimals() must refuse rather
      // than fund an effectively unbounded amount.
      let decimals = 18;
      let symbol = "native";
      if (token) {
        const refuseDecimals = (why: string) =>
          err(
            `Refusing to fund: could not establish decimals() for token ${token} on chain ${chain.chainId} (${why}). ` +
              `The per-agent cap DEXE_AGENT_FUND_MAX_WEI is denominated in the token's own units, so without ` +
              `decimals() the cap cannot be enforced and the transfer would be unbounded. ` +
              `Check the token address and the chain, then re-run.`,
          );
        let dRes;
        try {
          dRes = await multicall(provider, [
            { target: token, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true },
            { target: token, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true },
          ]);
        } catch (e) {
          return refuseDecimals(toActionableError(e, "read token decimals").message);
        }
        if (!dRes[0]?.success) return refuseDecimals("the decimals() call reverted or returned nothing");
        const d = Number(dRes[0]!.value);
        if (!Number.isInteger(d) || d < 0 || d > MAX_TOKEN_DECIMALS) {
          return refuseDecimals(`decimals() returned ${String(dRes[0]!.value)}, which is not a usable token scale`);
        }
        decimals = d;
        symbol = dRes[1]?.success ? String(dRes[1]!.value) : token;
      }

      let amountWei: bigint;
      try {
        amountWei = parseAmount(amount, decimals);
      } catch (e) {
        return err(`Invalid amount: ${safeErrorMessage(e)}`);
      }

      const cap = fundCapInUnits(decimals);
      if (cap <= 0n) {
        return err(
          `Refusing to fund: the per-agent cap DEXE_AGENT_FUND_MAX_WEI (${fundCapWei()} wei = ` +
            `${formatEther(fundCapWei())} native) rescales to 0 units for a ${decimals}-decimals token, so no ` +
            `amount is fundable. Raise DEXE_AGENT_FUND_MAX_WEI to a value that is representable in this token.`,
        );
      }
      if (amountWei > cap) {
        return err(
          `Per-agent amount ${formatUnits(amountWei, decimals)} ${symbol} (raw ${amountWei}) exceeds the funding cap ` +
            `${formatUnits(cap, decimals)} ${symbol} (raw ${cap}) — DEXE_AGENT_FUND_MAX_WEI=${fundCapWei()} wei ` +
            `rescaled to this token's ${decimals} decimals. Raise DEXE_AGENT_FUND_MAX_WEI explicitly if you really mean it.`,
        );
      }

      // ---- daily spend budget: an unparseable guard disables spending -------
      const budget = dailyBudget(chain.chainId);
      if (budget.mode === "invalid") return err(budget.message);

      // Top-up semantics: send only the shortfall vs the current balance.
      let balances: bigint[];
      try {
        balances = token
          ? (
              await multicall(
                provider,
                targets.map((t) => ({
                  target: token,
                  iface: ERC20_ABI,
                  method: "balanceOf",
                  args: [t.address],
                  allowFailure: true,
                })),
              )
            ).map((r) => (r?.success ? (r.value as bigint) : 0n))
          : await Promise.all(targets.map((t) => provider.getBalance(t.address)));
      } catch (e) {
        return err(`Could not read agent balances: ${toActionableError(e, "read agent balances").message}`);
      }

      const plan = targets
        .map((t, i) => ({ ...t, current: balances[i]!, send: amountWei > balances[i]! ? amountWei - balances[i]! : 0n }))
        .filter((t) => t.send > 0n);

      if (plan.length === 0) {
        return ok({ chainId: chain.chainId, funded: [], note: "Every requested agent already meets the target amount." });
      }

      // ---- B6/B7 over the WHOLE plan, before it is even shown --------------
      // These two are stateless, so running them up front costs nothing and
      // stops the tool from previewing a batch every leg of which would be
      // refused at broadcast time.
      for (const p of plan) {
        const tx = fundTransferTx(p.address, p.send, token);
        try {
          assertAllowlistAndValueCap(tx, config);
        } catch (e) {
          if (e instanceof BroadcastGuardError) {
            return errJson({
              status: "rejected",
              guard: e.guard,
              reason: e.message,
              chainId: chain.chainId,
              blockedTransfer: { signerKey: p.signerKey, to: tx.to, ...amountView(p.send, decimals, symbol) },
              remediation:
                e.guard === "B6"
                  ? "DEXE_SIGNER_ALLOWLIST is active and does not cover this destination. Funding sends to keyring " +
                    "addresses (native) or to the token contract (ERC20) — add them to the allowlist, or unset it."
                  : "Lower `amount`, or raise DEXE_SIGNER_MAX_VALUE_WEI deliberately.",
            });
          }
          throw e;
        }
      }

      const ledger = getAgentLedger();
      const plannedNativeWei = token ? 0n : plan.reduce((a, p) => a + p.send, 0n);
      const spendNow = ledger.spendSince({ windowMs: DAY_MS, chainId: chain.chainId });
      // Two views, deliberately separate: `nowStatus` is what the window has
      // ALREADY cost (so `remaining` means what it says), `planStatus` is the
      // same window with this plan added (so the preview can warn before the
      // confirm instead of failing halfway through a batch).
      const nowStatus = budget.mode === "enforced" ? evaluateBudget(spendNow, budget.budgetWei) : null;
      const planStatus =
        budget.mode === "enforced" ? evaluateBudget(spendNow, budget.budgetWei, plannedNativeWei) : null;

      const fromIdentity = signer.hasSigner(sourceKey) ? signer.describeSigner(sourceKey) : null;
      const transfers = plan.map((p) => ({
        signerKey: p.signerKey,
        to: p.address,
        currentBalance: formatUnits(p.current, decimals),
        ...amountView(p.send, decimals, symbol),
      }));
      const totalSend = plan.reduce((a, p) => a + p.send, 0n);

      if (dryRun || !confirm) {
        const warnings: string[] = [];
        if (planStatus?.exceeded) {
          warnings.push(
            `⚠️ This plan would exceed SWARM_DAILY_BNB_BUDGET — the transfer that crosses the line will be refused. ` +
              `Fund fewer agents, lower the amount, or raise the budget.`,
          );
        }
        // Gas is real even when the transfer is an ERC20, so the warning is
        // keyed on the chain, not on whether native value moves.
        if (!FREE_COIN_CHAIN_IDS.has(chain.chainId)) {
          warnings.push(`⚠️ chain ${chain.chainId} is not a faucet testnet — this spends real coin.`);
        }
        return ok({
          mode: dryRun ? "dryRun" : "preview",
          action: dryRun ? "dry-run" : "review-then-confirm",
          chainId: chain.chainId,
          ...(dryRun ? { dryRun: true } : {}),
          from: fromIdentity ?? { signerKey: sourceKey ?? "primary", address: null },
          ...(token ? { token, tokenSymbol: symbol, tokenDecimals: decimals } : {}),
          perAgentTarget: amountView(amountWei, decimals, symbol),
          perAgentCap: amountView(cap, decimals, symbol),
          transfers,
          total: amountView(totalSend, decimals, symbol),
          budget: {
            ...budgetView(budget, nowStatus),
            ...(planStatus
              ? {
                  planCost: formatEther(plannedNativeWei),
                  planCostWei: plannedNativeWei.toString(),
                  remainingAfterPlan: formatEther(planStatus.remainingWei),
                  wouldExceed: planStatus.exceeded,
                }
              : {}),
          },
          ...(warnings.length ? { warnings } : {}),
          next: dryRun
            ? "dryRun never broadcasts. Re-run without dryRun and with confirm:true to fund."
            : "Re-call dexe_agents_fund with the SAME arguments plus confirm:true to broadcast these transfers.",
        });
      }

      const sg = signer.trySigner(chain.chainId, sourceKey);
      if ("error" in sg) return err(`${sg.error}\n${sg.remediation}`);
      const wallet = sg.ok;
      const funded: Array<Record<string, unknown>> = [];

      for (const p of plan) {
        const tx = fundTransferTx(p.address, p.send, token);
        const cost = BigInt(tx.value);

        // ---- daily budget, rechecked per transfer -------------------------
        // Re-read the ledger each time: the legs already landed in THIS batch
        // have settled with their real fee, so the batch stops exactly at the
        // boundary instead of measuring itself once and blowing past it.
        if (budget.mode === "enforced") {
          const soFar = ledger.spendSince({ windowMs: DAY_MS, chainId: chain.chainId });
          const before = evaluateBudget(soFar, budget.budgetWei);
          const after = evaluateBudget(soFar, budget.budgetWei, cost);
          if (after.exceeded) {
            return errJson({
              status: "rejected",
              guard: "SWARM_DAILY_BNB_BUDGET",
              reason: budgetRefusal(chain.chainId, before, after, cost),
              chainId: chain.chainId,
              blockedTransfer: { signerKey: p.signerKey, to: p.address, ...amountView(p.send, decimals, symbol) },
              budget: budgetView(budget, after),
              funded,
            });
          }
        }

        // ---- B6/B7/B9/B10/B11 -------------------------------------------
        try {
          await runBroadcastGuards(
            { to: tx.to, data: tx.data, value: tx.value, chainId: chain.chainId, from: wallet.address },
            config,
          );
        } catch (e) {
          if (e instanceof BroadcastGuardError) {
            return errJson({
              status: "rejected",
              guard: e.guard,
              reason: e.message,
              chainId: chain.chainId,
              blockedTransfer: { signerKey: p.signerKey, to: tx.to, ...amountView(p.send, decimals, symbol) },
              funded,
            });
          }
          throw e;
        }

        try {
          // The attribution context names the RECIPIENT, so the ledger entry the
          // signer hook writes reads "funder → agent3" rather than just "the
          // funder sent something somewhere".
          const sent = await withActionContext(
            {
              tool: "dexe_agents_fund",
              action: `fund ${p.signerKey} (${p.address}) with ${formatUnits(p.send, decimals)} ${symbol}`,
            },
            () =>
              signer.withBroadcastLock(
                chain.chainId,
                () =>
                  token
                    ? wallet.sendTransaction({ to: tx.to, data: tx.data, chainId: BigInt(chain.chainId) })
                    : wallet.sendTransaction({ to: tx.to, value: p.send, chainId: BigInt(chain.chainId) }),
                wallet.address,
              ),
          );
          const receipt = await waitWithTimeout(sent, { timeoutMs: txWaitTimeoutMs() });
          if (receipt?.status === 0) throw new Error("transfer reverted (status 0)");
          funded.push({
            signerKey: p.signerKey,
            to: p.address,
            ...amountView(p.send, decimals, symbol),
            txHash: receipt?.hash ?? sent.hash,
          });
        } catch (e) {
          return errJson({
            status: "rejected",
            reason:
              `Funding ${p.signerKey} failed: ${toActionableError(e, "fund agent").message}. ` +
              `${funded.length} transfer(s) already landed — re-run to top up the rest (already-funded agents are skipped).`,
            chainId: chain.chainId,
            funded,
          });
        }
      }

      const finalSpend = ledger.spendSince({ windowMs: DAY_MS, chainId: chain.chainId });
      return ok({
        chainId: chain.chainId,
        from: fromIdentity ?? { signerKey: sourceKey ?? "primary", address: wallet.address },
        ...(token ? { token, tokenSymbol: symbol } : {}),
        funded,
        budget: budgetView(budget, budget.mode === "enforced" ? evaluateBudget(finalSpend, budget.budgetWei) : null),
      });
    },
  );

  server.registerTool(
    "dexe_agents_ledger",
    {
      title: "Read the agent action ledger (per-agent history + spend)",
      description:
        "Reconcile what the keyring fleet actually did. Returns, for a rolling window: every broadcast attributed " +
        "to the signer that made it (agent1…, funder, primary) with tool, action, tx hash and outcome " +
        "(broadcast / confirmed / reverted / failed); per-agent and total spend (native value + gas); and the " +
        "remaining SWARM_DAILY_BNB_BUDGET for the chain. Read-only and local — the ledger lives beside the " +
        "session state file (override DEXE_AGENT_LEDGER_PATH, disable with DEXE_AGENT_LEDGER=off). " +
        "Records addresses and slot labels only; private keys are never stored. " +
        "Use it after a dexe_agents_fund batch or an orchestrated run to answer 'who spent what'.",
      inputSchema: {
        signerKey: z
          .string()
          .optional()
          .describe("Only this signer's actions ('agent1', 'funder', 'primary'). Omit for the whole fleet."),
        chainId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Chain to report on (56 mainnet, 97 testnet). Defaults to the MCP's default chain."),
        tool: z.string().optional().describe("Only actions initiated by this tool, e.g. 'dexe_agents_fund'"),
        windowHours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .default(24)
          .describe("Rolling window for the spend totals and the history. Default 24h (the budget window)."),
        limit: z.number().int().min(0).max(200).default(20).describe("How many recent actions to return. Default 20."),
      },
    },
    async ({ signerKey, chainId, tool, windowHours = 24, limit = 20 }) => {
      // A ledger read needs no RPC — resolve the chain id without requiring one
      // to be configured, so reconciliation works on a chain you can no longer
      // reach.
      const scopeChainId = chainId ?? config.defaultChainId;
      const windowMs = windowHours * 60 * 60 * 1000;
      const ledger = getAgentLedger();

      const spend = ledger.spendSince({ windowMs, chainId: scopeChainId });
      const recent = ledger.list({
        ...(signerKey ? { signerKey } : {}),
        chainId: scopeChainId,
        ...(tool ? { tool } : {}),
        since: spend.since,
        limit,
      });

      const budget = dailyBudget(scopeChainId);
      const daily = ledger.spendSince({ windowMs: DAY_MS, chainId: scopeChainId });
      const status = budget.mode === "enforced" ? evaluateBudget(daily, budget.budgetWei) : null;

      return ok({
        chainId: scopeChainId,
        ledger: {
          path: resolveLedgerPath(),
          enabled: ledgerEnabled(),
          ...(ledgerEnabled()
            ? {}
            : { note: "DEXE_AGENT_LEDGER is off — nothing is being recorded, so spend and history read empty." }),
        },
        window: { hours: windowHours, since: spend.since },
        ...(signerKey ? { signerKey } : {}),
        ...(tool ? { tool } : {}),
        budget: budgetView(budget, status),
        spend: spendView(spend),
        recent: recentView(recent),
        ...(budget.mode === "invalid" ? { warning: budget.message } : {}),
      });
    },
  );
}

/** Test hook: derive addresses for a raw keyring map without a SignerManager. */
export function deriveKeyringAddresses(agentKeys: Record<string, string>): Array<{ signerKey: string; address: string }> {
  return Object.entries(agentKeys).map(([signerKey, pk]) => ({ signerKey, address: new Wallet(pk).address }));
}
