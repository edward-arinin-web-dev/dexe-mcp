import { z } from "zod";
import { Contract } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import { DEFAULTS, DEFAULT_SUBGRAPH_CHAIN_ID } from "../config.js";
import type { SignerManager } from "../lib/signer.js";
import type { StateStore, KnownDao } from "../lib/stateStore.js";
import { RpcProvider } from "../rpc.js";
import { subgraphChains } from "../lib/subgraph.js";
import { maskUrl } from "../lib/redact.js";
import { resolveToolsets, TOOLSETS } from "./gate.js";
import { getAgentLedger, DAY_MS, type SpendRow } from "../lib/agentLedger.js";

/** One-line "what you're missing" summary per gateable set (U5 discoverability). */
const TOOLSET_UNLOCKS: Record<string, string> = {
  core: "context/doctor/dao_create/tx_send/wc + OTC composites",
  proposals: "dexe_proposal_create + every dexe_proposal_build_* + vote_and_execute",
  read: "subgraph reads (dao members, delegation map, validator list), proposal_forecast, risk_assess, user_inbox",
  vote: "delegate/undelegate to experts, claim_rewards, staking, NFT multiplier, cancel_vote, validator_vote",
  agents: "multi-agent keyring: dexe_agents_list (personas + addresses), dexe_agents_fund (guarded funding), dexe_agents_ledger (who did what, spend per persona)",
  governor: "dexe_gov_* surface for external OpenZeppelin/Compound Governor DAOs (Uniswap, Compound, Optimism…)",
  dev: "dexe_compile + contract introspection (get_abi/get_methods/find_selector), dao_build_deploy, simulate/decode, merkle, safe",
};

/**
 * Report enabled vs hidden toolsets + what each hidden set unlocks, so the
 * model can tell the user exactly which DEXE_TOOLSETS value fixes a missing
 * capability instead of dead-ending on an invisible tool.
 */
function describeToolsets(requested: readonly string[]): {
  enabled: string[];
  hidden: { set: string; unlocks: string }[];
  enableHint?: string;
} {
  const resolved = resolveToolsets(requested);
  const enabled = resolved.full ? Object.keys(TOOLSETS) : resolved.requested;
  const hidden = Object.keys(TOOLSETS)
    .filter((s) => !enabled.includes(s))
    .map((s) => ({ set: s, unlocks: TOOLSET_UNLOCKS[s] ?? "" }));
  return {
    enabled,
    hidden,
    ...(hidden.length
      ? {
          enableHint:
            `Hidden sets need DEXE_TOOLSETS in .env (e.g. DEXE_TOOLSETS=${[...enabled, hidden[0]!.set].join(",")} ` +
            `or DEXE_TOOLSETS=full) + a Claude Code restart.`,
        }
      : {}),
  };
}

/**
 * `dexe_context` (Phase 3 / v0.14.0) — the "who/where am I" call. One read that
 * orients an agent at session start: signer + mode, active/configured chains,
 * env readiness, and the persisted operational state (DAOs deployed and
 * proposals broadcast in prior sessions) so work doesn't start from zero.
 *
 * `context.ts` is taken by the ToolContext type, hence `operationalContext.ts`.
 */

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum mainnet",
  56: "BSC mainnet",
  97: "BSC testnet",
  137: "Polygon mainnet",
  8453: "Base mainnet",
  42161: "Arbitrum One",
};

const GOV_HELPERS_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
];
const USER_KEEPER_ABI = [
  "function tokenBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
];

function signerMode(config: DexeConfig, signer: SignerManager): "readonly" | "eoa" | "safe" | "walletconnect" {
  const safeServiceUrl = process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined;
  return signer.hasSigner()
    ? safeServiceUrl
      ? "safe"
      : "eoa"
    : config.walletConnectProjectId
      ? "walletconnect"
      : "readonly";
}

/**
 * Best-effort deposited voting power for a DAO: getHelperContracts → userKeeper
 * → tokenBalance(user,0).balance − ownedBalance. Returns null on any failure
 * (no RPC, unregistered pool, revert) — this is a convenience readout, never a
 * hard dependency.
 */
async function depositedPowerFor(
  rpc: RpcProvider,
  dao: KnownDao,
  user: string,
): Promise<string | null> {
  try {
    const pr = rpc.tryProvider(dao.chainId);
    if ("error" in pr) return null;
    const provider = pr.ok;
    const keeper =
      dao.userKeeper ??
      ((await new Contract(dao.govPool, GOV_HELPERS_ABI, provider)
        .getFunction("getHelperContracts")
        .staticCall()) as string[])[1];
    if (!keeper) return null;
    const [balance, owned] = (await new Contract(keeper, USER_KEEPER_ABI, provider)
      .getFunction("tokenBalance")
      .staticCall(user, 0)) as [bigint, bigint];
    return (balance - owned).toString();
  } catch {
    return null;
  }
}

/**
 * One persona an orchestrator can act as. Labels and addresses only — key
 * material never appears here, and `SignerManager` is the only object that
 * holds it.
 */
interface KeyringSigner {
  /** Value to pass as `signerKey` ("primary" means: omit the field). */
  signerKey: string;
  address: string;
  role: "primary" | "keyring";
  /** Native balance on `balanceChainId`; null when the probe was skipped or failed. */
  balanceWei: string | null;
  /** balanceWei > 0 — "can this persona pay for its own gas". */
  funded: boolean | null;
  /** Broadcasts attributed to this persona in the last 24h (agent ledger). */
  actions24h: number;
  /** Native value + gas charged to this persona in the last 24h, wei. */
  spentWei24h: string;
}

/**
 * The fleet an orchestrating agent can command: every configured persona, its
 * address, whether it can pay for gas, and what it has already done today.
 *
 * Before 0.32.0 `dexe_context` reported one signer address and nothing else, so
 * an agent asked to "run five personas" had no way to discover that four of them
 * existed — the keyring was configured in `.env`, resolvable by
 * `SignerManager`, threaded through every composite, and invisible. A fleet
 * cannot be planned from a surface that does not admit it exists.
 *
 * Balances are ONE `eth_getBalance` per persona on the default chain, issued in
 * parallel and individually best-effort; `includeAgentBalances: false` skips
 * them entirely. The 24h activity comes from the local agent ledger — a file
 * read, no RPC.
 */
export async function keyringReport(
  config: DexeConfig,
  signer: SignerManager,
  rpc: RpcProvider,
  includeBalances: boolean,
): Promise<{
  configured: number;
  balanceChainId: number | null;
  fundedCount: number | null;
  signers: KeyringSigner[];
  spend24h: { actions: number; totalWei: string };
  hint: string;
}> {
  const rows: Array<{ signerKey: string; address: string; role: "primary" | "keyring" }> = [];
  if (signer.hasSigner()) {
    rows.push({ ...signer.describeSigner(), role: "primary" });
  }
  for (const a of signer.listAgents()) {
    // A slot whose key IS the primary key would otherwise be listed twice under
    // two labels; keep both labels only when the addresses differ.
    if (rows.some((r) => r.address.toLowerCase() === a.address.toLowerCase())) continue;
    rows.push({ ...a, role: "keyring" });
  }

  // Per-persona 24h spend — the same ledger a budget guard reads, so the plan
  // and the enforcement agree on the numbers.
  const spend = getAgentLedger().spendSince({ windowMs: DAY_MS });
  const byAgent = new Map<string, SpendRow>(spend.byAgent.map((r) => [r.signerKey, r]));

  const wantBalances = includeBalances && rows.length > 0;
  const pr = wantBalances ? rpc.tryProvider(config.defaultChainId) : null;
  const provider = pr && !("error" in pr) ? pr.ok : null;

  const balances = await Promise.all(
    rows.map(async (r) => {
      if (!provider) return null;
      try {
        return (await provider.getBalance(r.address)).toString();
      } catch {
        // A rate-limited public endpoint must not fail the orientation call.
        return null;
      }
    }),
  );

  const signers: KeyringSigner[] = rows.map((r, i) => {
    const row = byAgent.get(r.signerKey);
    const balanceWei = balances[i] ?? null;
    return {
      signerKey: r.signerKey,
      address: r.address,
      role: r.role,
      balanceWei,
      funded: balanceWei === null ? null : BigInt(balanceWei) > 0n,
      actions24h: row?.actions ?? 0,
      spentWei24h: row?.totalWei ?? "0",
    };
  });

  // null = "not known", never an optimistic 0/allFunded: an orchestrator that
  // reads a skipped probe as "0 funded" would fund a fleet that is already funded.
  const fundedCount =
    signers.length === 0 || signers.some((s) => s.funded === null)
      ? null
      : signers.filter((s) => s.funded).length;
  const agents = signers.filter((s) => s.role === "keyring").length;

  const hint =
    agents === 0
      ? "No agent keyring configured — every write signs with the primary key. Set DEXE_AGENT_PK_1..16 " +
        "(and DEXE_AGENT_FUNDER_PK for a gas funder) to run multiple personas, then pass signerKey on " +
        "dexe_dao_create / dexe_proposal_create / dexe_proposal_vote_and_execute / dexe_tx_send."
      : `${agents} agent persona(s) available. Pass signerKey:'<slot>' on any write tool to act as one; ` +
        "omitting signerKey always signs with the primary key — a persona is never chosen implicitly. " +
        (fundedCount === 0
          ? "NONE of them holds native gas yet: fund them before they can broadcast."
          : "Unfunded personas can build calldata but cannot broadcast.");

  return {
    configured: signers.length,
    balanceChainId: provider ? config.defaultChainId : null,
    fundedCount,
    signers,
    spend24h: { actions: spend.total.actions, totalWei: spend.total.totalWei },
    hint,
  };
}

export function registerOperationalContextTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
  state: StateStore,
): void {
  const rpc = new RpcProvider(config);

  server.tool(
    "dexe_context",
    "Operational context for the current session — call this first when you need orientation (skip it when the " +
      "user already gave you the target DAO and chain). Returns the signer address + mode, the active/configured " +
      "chains, env-readiness (RPC/IPFS/subgraph/signer), which toolsets are enabled/hidden and what the hidden ones " +
      "unlock, and the persisted state: DAOs you deployed and proposals you broadcast in prior sessions (via " +
      "dexe_dao_create / dexe_proposal_create), plus your deposited voting power in the most recent DAO. " +
      "Also returns the agent KEYRING — every persona you can sign as (signerKey + address + whether it holds " +
      "gas + what it broadcast in the last 24h) — which is how a multi-agent run discovers the fleet it commands. " +
      "Read-only; never writes.",
    {
      includeDepositedPower: z
        .boolean()
        .default(true)
        .describe("Read deposited voting power for the most recent DAO (one extra RPC call). Set false to skip."),
      includeAgentBalances: z
        .boolean()
        .default(true)
        .describe(
          "Probe each keyring persona's native balance (one parallel eth_getBalance per configured signer on the " +
            "default chain). Set false to list the keyring without any RPC.",
        ),
    },
    async ({ includeDepositedPower = true, includeAgentBalances = true }) => {
      const st = state.getState();

      const chains = [...config.chains.values()]
        .sort((a, b) => a.chainId - b.chainId)
        .map((c) => ({
          chainId: c.chainId,
          name: CHAIN_NAMES[c.chainId] ?? `chain ${c.chainId}`,
          rpcUrl: maskUrl(c.rpcUrl),
          isDefault: c.chainId === config.defaultChainId,
        }));

      const mode = signerMode(config, signer);
      const address = signer.hasSigner() ? signer.getAddress() : null;

      // Deposited power for the last DAO (best-effort, opt-out).
      let lastDaoPower: { govPool: string; chainId: number; depositedPower: string | null } | null = null;
      const last = st.knownDaos[0];
      if (includeDepositedPower && last && address) {
        lastDaoPower = {
          govPool: last.govPool,
          chainId: last.chainId,
          depositedPower: await depositedPowerFor(rpc, last, address),
        };
      }

      // Subgraph readiness is a set of chains, not a flag: one endpoint indexes
      // one chain (0.30.2), and a read for an unindexed chain refuses rather
      // than answering from another chain's rows. The flat `subgraphPoolsUrl`
      // this used to test holds only the DEXE_SUBGRAPH_CHAIN_ID slot, so it
      // reported "no subgraph reads" for a server whose mainnet endpoints work.
      const subgraphCovered = subgraphChains(config);

      // The fleet. Never key material — labels, addresses, balances, counts.
      const keyring = await keyringReport(config, signer, rpc, includeAgentBalances);

      const result = {
        signer: { mode, address },
        keyring,
        chain: {
          defaultChainId: config.defaultChainId,
          defaultChainName: CHAIN_NAMES[config.defaultChainId] ?? `chain ${config.defaultChainId}`,
          configured: chains,
          lastUsedChainId: st.lastChainId ?? null,
        },
        env: {
          rpcConfigured: config.chains.size > 0,
          usingPublicRpcFallback: config.usingPublicRpcFallback,
          ipfsUploads: !!config.pinataJwt,
          ipfsReads:
            process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK === "1"
              ? !!(process.env.DEXE_IPFS_GATEWAY?.trim() || process.env.DEXE_IPFS_GATEWAYS_FALLBACK?.trim())
              : true,
          subgraphReads: subgraphCovered.length > 0,
          /** Chains a subgraph-backed read can answer for; any other chain refuses. */
          subgraphChains: subgraphCovered,
          subgraphDefaultChainCovered: subgraphCovered.includes(config.defaultChainId),
          backendOffchain: !!config.backendApiUrl,
          walletConnectAvailable: !!config.walletConnectProjectId,
          // Surfaces running on the shared PUBLIC defaults (not the user's own
          // keys/endpoints). Fine for light use; heavy users should set their
          // own — dexe_doctor advises this. Empty = everything is user-configured.
          usingSharedDefaults: [
            config.usingPublicRpcFallback ? "rpc" : null,
            // Every baked endpoint indexes BSC mainnet, so the shared Graph key
            // only ever occupies chain 56's slot. Testing the flat alias instead
            // made the warning vanish whenever DEXE_SUBGRAPH_CHAIN_ID pointed
            // the unsuffixed vars at another chain — while chain 56 was still
            // being read on the shared key.
            config.subgraphUrls.get(DEFAULT_SUBGRAPH_CHAIN_ID)?.pools === DEFAULTS.subgraphPoolsUrl
              ? "subgraph"
              : null,
            config.backendApiUrl === DEFAULTS.backendApiUrl ? "backend" : null,
            config.walletConnectProjectId === DEFAULTS.walletConnectProjectId ? "walletconnect" : null,
          ].filter(Boolean),
          toolsets: describeToolsets(config.toolsets),
        },
        knownDaos: st.knownDaos,
        recentProposals: st.recentProposals,
        walletLabels: st.walletLabels,
        ...(st.activeFlow ? { activeFlow: st.activeFlow } : {}),
        lastDaoPower,
        hint:
          (st.activeFlow
            ? `Mid-journey: flow '${st.activeFlow.flow}' last completed step '${st.activeFlow.step}' on chain ${st.activeFlow.chainId} — call dexe_guide {flow:"${st.activeFlow.flow}"} to resume. `
            : "") +
          (st.knownDaos.length === 0
            ? "No DAOs recorded yet. Deploy one with dexe_dao_create (testnet chain 97) or pass a govPool explicitly."
            : `Most recent DAO: ${st.knownDaos[0]!.name} (${st.knownDaos[0]!.govPool}) on chain ${st.knownDaos[0]!.chainId}.`),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
