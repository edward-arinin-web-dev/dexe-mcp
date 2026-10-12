import { z } from "zod";
import { Contract, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadConfig } from "../configRead.js";
import { DEFAULTS, DEFAULT_SUBGRAPH_CHAIN_ID } from "../configRead.js";
import type { StateStore, KnownDao } from "../lib/stateStore.js";
import { RpcProvider } from "../rpc.js";
import { subgraphChains } from "../lib/subgraph.js";
import { maskUrl } from "../lib/redact.js";
import { resolveToolsetsIn, type ToolsetTable } from "./toolsets.js";

/**
 * `dexe_context` (Phase 3 / v0.14.0) — the "where am I" call. One read that
 * orients an agent at session start: active/configured chains, env readiness,
 * which toolsets are on, and — when the server keeps a local state store — the
 * DAOs and proposals recorded in prior sessions, so work doesn't start from zero.
 *
 * READ edition. The signer, the agent keyring, the Pinata / WalletConnect /
 * Safe posture and an interrupted write journey are the write edition's
 * `dexe_write_context` (./operationalContextWrite.ts). This file names no write
 * tool: the toolset descriptions and any pointer at the write context come in
 * from the composition root.
 *
 * `context.ts` is taken by the ToolContext type, hence `operationalContext.ts`.
 */

/**
 * Report enabled vs hidden toolsets + what each hidden set unlocks, so the
 * model can tell the user exactly which DEXE_TOOLSETS value fixes a missing
 * capability instead of dead-ending on an invisible tool.
 *
 * `table` is the server's own toolset table (src/tools/toolsets.ts): the
 * single server's gated profiles, or the read edition's one ungated set, which
 * reports a single enabled set and nothing hidden.
 */
export function describeToolsets(
  requested: readonly string[],
  table: ToolsetTable,
): {
  enabled: string[];
  hidden: { set: string; newToolCount: number; unlocks: string; note?: string }[];
  enableHint?: string;
} {
  const resolved = resolveToolsetsIn(table, requested);
  const enabled = resolved.full ? Object.keys(table.sets) : resolved.requested;
  const have: ReadonlySet<string> | null = resolved.full ? null : resolved.names;
  const catalog = table.catalog;
  const hidden = Object.keys(table.sets)
    .filter((s) => !enabled.includes(s))
    .map((s) => {
      // How many tools this set would ADD. A set whose every tool is already
      // registered is not "hidden" in any useful sense — listing it is how an
      // agent ends up telling the user to restart for a tool they already have.
      const newToolCount = [...table.sets[s]!].filter((n) => !have || !have.has(n)).length;
      const u = catalog?.unlocks[s];
      return {
        set: s,
        newToolCount,
        unlocks: u?.unlocks ?? "",
        ...(u?.note ? { note: u.note } : {}),
      };
    })
    .filter((r) => r.newToolCount > 0);
  return {
    enabled,
    hidden,
    ...(hidden.length
      ? {
          enableHint:
            `Check the \`enabled\` list first — ${catalog?.defaultCovers ?? "the default profile covers the common reads"}, so a missing capability is usually a wrong ` +
            "tool name, not a gated set. If a tool you actually need is absent: set " +
            `DEXE_TOOLSETS=${enabled.join(",")},<set> (or =full) in .env — NEVER in .claude.json — ` +
            "and restart Claude Code.",
        }
      : {}),
  };
}

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

/**
 * Best-effort deposited voting power for a DAO: getHelperContracts → userKeeper
 * → tokenBalance(user,0).balance − ownedBalance. Returns null on any failure
 * (no RPC, unregistered pool, revert) — this is a convenience readout, never a
 * hard dependency.
 */
export async function depositedPowerFor(
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
 * Response window for the persisted lists.
 *
 * The STORE keeps 50 DAOs / 25 proposals — that is DISK RETENTION. This is the
 * ORIENTATION budget: a model calling dexe_context wants "which DAO am I
 * working on", not a full deploy history. The whole history measured ~18.6k
 * chars (~4.6k tokens) on a machine with 31 recorded DAOs, and it is paid at
 * the start of most sessions because the tool's own description says to call it
 * first.
 *
 * Both lists are already most-recent-first in the store, so a head slice is the
 * right window; the totals and the hint make the truncation impossible to
 * mistake for "that is everything".
 */
const DEFAULT_DAO_WINDOW = 8;
const DEFAULT_PROPOSAL_WINDOW = 5;
const MAX_WINDOW = 50;

/** Truncation sentence for the hint, naming only the list(s) actually trimmed. */
function windowNote(
  daos: number,
  daoLimit: number,
  proposals: number,
  proposalLimit: number,
): string {
  const trimmed: string[] = [];
  if (daos > daoLimit) trimmed.push(`the ${daoLimit} most recent DAO(s) of ${daos}`);
  if (proposals > proposalLimit) {
    trimmed.push(`the ${proposalLimit} most recent proposal(s) of ${proposals}`);
  }
  if (trimmed.length === 0) return "";
  return ` Showing ${trimmed.join(" and ")} — call dexe_context {"daoLimit":50,"proposalLimit":50} to see the rest.`;
}

export interface ContextOptions {
  /** The server's own toolset table, for `env.toolsets`: which sets exist and what each unlocks. */
  toolsets: ToolsetTable;
  /**
   * Appended to `hint`: where the rest of the session posture lives. The single
   * server names its write context tool here; a read-only server passes nothing.
   */
  hintSuffix?: string;
  /**
   * Served to many callers over HTTP: the chain list carries no RPC hostnames
   * (an operator's endpoint is not public information).
   */
  remote?: boolean;
}

/** Without a state store there is nothing recorded to window or to look a wallet up in. */
const STATELESS_DESCRIPTION =
  "Read-only. Session orientation — configured chains and the default, env readiness (RPC/IPFS/subgraph/backend) " +
  "and the tool set this server serves. Not needed once the DAO and chain are known.";

export function registerOperationalContextTools(
  server: McpServer,
  config: ReadConfig,
  state: StateStore | null,
  opts: ContextOptions,
): void {
  const rpc = new RpcProvider(config);

  const recordedInputs = {
      user: z
        .string()
        .optional()
        .describe("Wallet address: adds its deposited voting power in the newest recorded DAO (one extra RPC call)."),
      daoLimit: z
        .number()
        .int()
        .min(0)
        .max(MAX_WINDOW)
        .default(DEFAULT_DAO_WINDOW)
        .describe("Recorded DAOs to return, newest first."),
      proposalLimit: z
        .number()
        .int()
        .min(0)
        .max(MAX_WINDOW)
        .default(DEFAULT_PROPOSAL_WINDOW)
        .describe("Recorded proposals to return, newest first."),
  };

  server.tool(
    "dexe_context",
    state
      ? "Read-only. Session orientation — configured chains and the default, env readiness (RPC/IPFS/subgraph/backend), " +
          "which toolsets are on or hidden and what the hidden ones unlock, and the DAOs/proposals recorded in this " +
          "install's local state. Pass `user` to add that wallet's deposited power in the newest recorded DAO. Not " +
          "needed once the DAO and chain are known. Persisted DAOs/proposals are WINDOWED; the *Total fields " +
          "carry real counts."
      : STATELESS_DESCRIPTION,
    // No state, no inputs: every one of them is about recorded DAOs/proposals.
    (state ? recordedInputs : {}) as typeof recordedInputs,
    async ({ user, daoLimit = DEFAULT_DAO_WINDOW, proposalLimit = DEFAULT_PROPOSAL_WINDOW }) => {
      if (user !== undefined && !isAddress(user)) {
        return {
          content: [{ type: "text" as const, text: `Invalid user: ${user} — pass a 0x-prefixed 20-byte address.` }],
          isError: true,
        };
      }
      const st = state ? state.getState() : null;

      const chains = [...config.chains.values()]
        .sort((a, b) => a.chainId - b.chainId)
        .map((c) => ({
          chainId: c.chainId,
          name: CHAIN_NAMES[c.chainId] ?? `chain ${c.chainId}`,
          ...(opts.remote ? {} : { rpcUrl: maskUrl(c.rpcUrl) }),
          isDefault: c.chainId === config.defaultChainId,
        }));

      // Deposited power of the caller-named wallet in the last DAO (best-effort).
      let lastDaoPower: { govPool: string; chainId: number; user: string; depositedPower: string | null } | null =
        null;
      const last = st?.knownDaos[0];
      if (user && last) {
        lastDaoPower = {
          govPool: last.govPool,
          chainId: last.chainId,
          user,
          depositedPower: await depositedPowerFor(rpc, last, user),
        };
      }

      // Subgraph readiness is a set of chains, not a flag: one endpoint indexes
      // one chain (0.30.2), and a read for an unindexed chain refuses rather
      // than answering from another chain's rows. The flat `subgraphPoolsUrl`
      // this used to test holds only the DEXE_SUBGRAPH_CHAIN_ID slot, so it
      // reported "no subgraph reads" for a server whose mainnet endpoints work.
      const subgraphCovered = subgraphChains(config);

      const env = {
        rpcConfigured: config.chains.size > 0,
        usingPublicRpcFallback: config.usingPublicRpcFallback,
        ipfsReads:
          process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK === "1"
            ? !!(process.env.DEXE_IPFS_GATEWAY?.trim() || process.env.DEXE_IPFS_GATEWAYS_FALLBACK?.trim())
            : true,
        subgraphReads: subgraphCovered.length > 0,
        /** Chains a subgraph-backed read can answer for; any other chain refuses. */
        subgraphChains: subgraphCovered,
        subgraphDefaultChainCovered: subgraphCovered.includes(config.defaultChainId),
        backendOffchain: !!config.backendApiUrl,
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
        ].filter(Boolean),
        toolsets: describeToolsets(config.toolsets, opts.toolsets),
      };

      const chain = {
        defaultChainId: config.defaultChainId,
        defaultChainName: CHAIN_NAMES[config.defaultChainId] ?? `chain ${config.defaultChainId}`,
        configured: chains,
        lastUsedChainId: st?.lastChainId ?? null,
      };
      const suffix = opts.hintSuffix ? ` ${opts.hintSuffix}` : "";

      if (!st) {
        const result = {
          chain,
          env,
          hint:
            "This server keeps no local state, so there are no recorded DAOs — name the DAO (govPool + chainId) " +
            "in each call, or find one with dexe_read_dao_list." + suffix,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      const result = {
        chain,
        env,
        knownDaos: st.knownDaos.slice(0, daoLimit),
        knownDaosTotal: st.knownDaos.length,
        ...(st.knownDaos.length > daoLimit ? { knownDaosTruncated: true } : {}),
        recentProposals: st.recentProposals.slice(0, proposalLimit),
        recentProposalsTotal: st.recentProposals.length,
        ...(st.recentProposals.length > proposalLimit ? { recentProposalsTruncated: true } : {}),
        // Belt and braces: the store caps this at 100 now, but a state.json
        // written by an older build has no cap at all.
        walletLabels: Object.fromEntries(Object.entries(st.walletLabels).slice(0, MAX_WINDOW)),
        lastDaoPower,
        hint:
          (st.knownDaos.length === 0
            ? "No DAOs recorded yet — pass a govPool explicitly, or find one with dexe_read_dao_list."
            : `Most recent DAO: ${st.knownDaos[0]!.name} (${st.knownDaos[0]!.govPool}) on chain ${st.knownDaos[0]!.chainId}.`) +
          // Name only the list(s) actually trimmed: recordProposal does not
          // require a recorded DAO, so "the 8 most recent DAO(s) of 0" is a
          // reachable state and would read as nonsense next to "No DAOs yet".
          windowNote(st.knownDaos.length, daoLimit, st.recentProposals.length, proposalLimit) +
          suffix,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
