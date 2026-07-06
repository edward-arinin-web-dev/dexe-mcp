import { z } from "zod";
import { Contract } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import { DEFAULTS } from "../config.js";
import type { SignerManager } from "../lib/signer.js";
import type { StateStore, KnownDao } from "../lib/stateStore.js";
import { RpcProvider } from "../rpc.js";
import { maskUrl } from "../lib/redact.js";

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

export function registerOperationalContextTools(
  server: McpServer,
  config: DexeConfig,
  signer: SignerManager,
  state: StateStore,
): void {
  const rpc = new RpcProvider(config);

  server.tool(
    "dexe_context",
    "Operational context for the current session — CALL THIS FIRST. Returns the signer address + mode, " +
      "the active/configured chains, env-readiness (RPC/IPFS/subgraph/signer), and the persisted state: DAOs you " +
      "deployed and proposals you broadcast in prior sessions (via dexe_dao_create / dexe_proposal_create), plus your " +
      "deposited voting power in the most recent DAO. Read-only; never writes.",
    {
      includeDepositedPower: z
        .boolean()
        .default(true)
        .describe("Read deposited voting power for the most recent DAO (one extra RPC call). Set false to skip."),
    },
    async ({ includeDepositedPower = true }) => {
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

      const result = {
        signer: { mode, address },
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
          subgraphReads: !!config.subgraphPoolsUrl,
          backendOffchain: !!config.backendApiUrl,
          walletConnectAvailable: !!config.walletConnectProjectId,
          // Surfaces running on the shared PUBLIC defaults (not the user's own
          // keys/endpoints). Fine for light use; heavy users should set their
          // own — dexe_doctor advises this. Empty = everything is user-configured.
          usingSharedDefaults: [
            config.usingPublicRpcFallback ? "rpc" : null,
            config.subgraphPoolsUrl === DEFAULTS.subgraphPoolsUrl ? "subgraph" : null,
            config.backendApiUrl === DEFAULTS.backendApiUrl ? "backend" : null,
            config.walletConnectProjectId === DEFAULTS.walletConnectProjectId ? "walletconnect" : null,
          ].filter(Boolean),
          toolsets: config.toolsets,
        },
        knownDaos: st.knownDaos,
        recentProposals: st.recentProposals,
        walletLabels: st.walletLabels,
        lastDaoPower,
        hint:
          st.knownDaos.length === 0
            ? "No DAOs recorded yet. Deploy one with dexe_dao_create (testnet chain 97) or pass a govPool explicitly."
            : `Most recent DAO: ${st.knownDaos[0]!.name} (${st.knownDaos[0]!.govPool}) on chain ${st.knownDaos[0]!.chainId}.`,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
