import { z } from "zod";
import { Interface, Wallet, formatEther, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SignerManager } from "../lib/signer.js";
import { resolveChain, type DexeConfig } from "../config.js";
import { createChainProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import { waitWithTimeout, txWaitTimeoutMs } from "../lib/txWait.js";
import { toActionableError } from "../lib/errors.js";
import { chainIdParam } from "../lib/params.js";
import { parseAmount } from "../lib/units.js";

/**
 * Agent-keyring tools (0.28.0, use-cases campaign Phase C).
 *
 * The opt-in `DEXE_AGENT_PK_1..16` keyring gives multi-persona / swarm flows
 * real distinct signers, selectable per call via `signerKey` on `dexe_tx_send`
 * and the composites. These two tools cover the operational side:
 *
 *  - `dexe_agents_list`  — who is in the keyring + native/token balances.
 *  - `dexe_agents_fund`  — top the agents up from the PRIMARY signer, with the
 *    same safety posture as the dev fund-pool script: recipients can ONLY be
 *    keyring addresses, and per-agent amounts are capped
 *    (`DEXE_AGENT_FUND_MAX_WEI`, default 0.1 native).
 */

const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const DEFAULT_FUND_CAP_WEI = 100_000_000_000_000_000n; // 0.1 native

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

function ok(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
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
      title: "Fund agent keyring wallets from the primary signer",
      description:
        "Tops up keyring wallets — native coin by default, or an ERC20 via `token`. Funds FROM the primary " +
        "DEXE_PRIVATE_KEY signer by default; pass source:'funder' to send from the AGENT_FUNDER_PK wallet instead. " +
        "Hard guards: recipients can ONLY be keyring addresses (never arbitrary destinations), and the per-agent " +
        "amount is capped by DEXE_AGENT_FUND_MAX_WEI (default 0.1 native / 0.1 token units in wei-scale). " +
        "Agents whose balance already meets `amount` are skipped. Use dexe_agents_list first to see who needs gas.",
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
        dryRun: z.boolean().default(false).describe("Preview the transfers without broadcasting"),
      },
    },
    async ({ amount, agents: requested = [], token, source, chainId, dryRun = false }) => {
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
      const targets = resolveFundTargets(keyring, requested, sourceKey);
      if (targets.length === 0) {
        return err(
          requested.length === 0
            ? "The keyring only contains the funding source — add agent slots to fund."
            : `Every requested agent resolves to the funding source '${sourceKey}' — nothing to fund.`,
        );
      }

      const chain = resolveChain(config, chainId);
      const provider = createChainProvider(chain, config);

      let decimals = 18;
      if (token) {
        const dRes = await multicall(provider, [
          { target: token, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true },
        ]);
        decimals = dRes[0]?.success ? Number(dRes[0]!.value) : 18;
      }
      let amountWei: bigint;
      try {
        amountWei = parseAmount(amount, decimals);
      } catch (e) {
        return err(`Invalid amount: ${e instanceof Error ? e.message : String(e)}`);
      }
      const cap = fundCapWei();
      if (amountWei > cap) {
        return err(
          `Per-agent amount ${amountWei} exceeds the funding cap ${cap} wei. ` +
            `Raise DEXE_AGENT_FUND_MAX_WEI explicitly if you really mean it.`,
        );
      }

      // Top-up semantics: send only the shortfall vs the current balance.
      const balances = token
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

      const plan = targets
        .map((t, i) => ({ ...t, current: balances[i]!, send: amountWei > balances[i]! ? amountWei - balances[i]! : 0n }))
        .filter((t) => t.send > 0n);

      if (plan.length === 0) {
        return ok({ chainId: chain.chainId, funded: [], note: "Every requested agent already meets the target amount." });
      }
      if (dryRun) {
        return ok({
          chainId: chain.chainId,
          dryRun: true,
          transfers: plan.map((p) => ({ signerKey: p.signerKey, to: p.address, sendWei: p.send.toString() })),
        });
      }

      const sg = signer.trySigner(chain.chainId, sourceKey);
      if ("error" in sg) return err(`${sg.error}\n${sg.remediation}`);
      const wallet = sg.ok;
      const funded: Array<Record<string, unknown>> = [];
      for (const p of plan) {
        try {
          const tx = await signer.withBroadcastLock(
            chain.chainId,
            () =>
              token
                ? wallet.sendTransaction({
                    to: token,
                    data: ERC20_ABI.encodeFunctionData("transfer", [p.address, p.send]),
                    chainId: BigInt(chain.chainId),
                  })
                : wallet.sendTransaction({ to: p.address, value: p.send, chainId: BigInt(chain.chainId) }),
            wallet.address,
          );
          const receipt = await waitWithTimeout(tx, { timeoutMs: txWaitTimeoutMs() });
          if (receipt?.status === 0) throw new Error("transfer reverted (status 0)");
          funded.push({ signerKey: p.signerKey, to: p.address, sentWei: p.send.toString(), txHash: receipt?.hash ?? tx.hash });
        } catch (e) {
          return {
            ...err(
              `Funding ${p.signerKey} failed: ${toActionableError(e, "fund agent").message}. ` +
                `${funded.length} transfer(s) already landed — re-run to top up the rest (already-funded agents are skipped).`,
            ),
          };
        }
      }
      return ok({ chainId: chain.chainId, ...(token ? { token } : {}), funded });
    },
  );
}

/** Test hook: derive addresses for a raw keyring map without a SignerManager. */
export function deriveKeyringAddresses(agentKeys: Record<string, string>): Array<{ signerKey: string; address: string }> {
  return Object.entries(agentKeys).map(([signerKey, pk]) => ({ signerKey, address: new Wallet(pk).address }));
}

