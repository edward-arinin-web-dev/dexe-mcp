import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SubgraphKind } from "../configRead.js";
import { DEFAULTS, SUBGRAPH_KINDS } from "../configRead.js";
import type { ToolContext } from "./context.js";
import { subgraphChains } from "../lib/subgraph.js";
import { maskUrl } from "../lib/redact.js";
import { gatewayHostname, resolveGateways } from "./ipfsRead.js";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum mainnet",
  56: "BSC mainnet",
  97: "BSC testnet",
  137: "Polygon mainnet",
  8453: "Base mainnet",
  42161: "Arbitrum One",
};

/**
 * Read-only diagnostic: the resolved READ config — the chains the MCP knows
 * about and which one tools use when `chainId` is omitted, subgraph coverage
 * per chain and kind, the backend API, and the IPFS read gateways.
 *
 * READ edition (D6). Signer, Safe, WalletConnect and Pinata posture are the
 * write edition's `dexe_write_context` (./operationalContextWrite.ts).
 */
export interface GetConfigOptions {
  /**
   * Served to many callers over HTTP: no endpoint URLs or hostnames (an
   * operator's RPC, backend or gateway host is not public information) — the
   * chain set, subgraph coverage and counts only.
   */
  remote?: boolean;
}

export function registerGetConfigTool(server: McpServer, ctx: ToolContext, opts: GetConfigOptions = {}): void {
  const { config } = ctx;
  const remote = opts.remote === true;
  server.tool(
    "dexe_get_config",
    "Read-only, local. The resolved read config: chain set and default chain, subgraph coverage per chain, " +
      "the backend API and the IPFS read gateways.",
    {
      _placeholder: z.boolean().optional().describe("Unused; tool takes no input."),
    },
    async () => {
      const chains = [...config.chains.values()]
        .sort((a, b) => a.chainId - b.chainId)
        .map(c => ({
          chainId: c.chainId,
          ...(remote ? {} : { rpcUrl: maskUrl(c.rpcUrl) }),
          name: CHAIN_NAMES[c.chainId] ?? `chain ${c.chainId}`,
          isDefault: c.chainId === config.defaultChainId,
          registryOverride: c.registryOverride,
        }));

      // A subgraph endpoint indexes exactly ONE chain (0.30.2), so "is the
      // subgraph configured?" has no chain-free answer. The flat
      // `config.subgraph*Url` fields hold only the slot named by
      // DEXE_SUBGRAPH_CHAIN_ID, so reading them reported "unavailable" for a
      // server whose mainnet endpoints work fine. Report the covered chains
      // instead — that is what the caller has to know anyway, since a read for
      // an uncovered chain refuses rather than answering from a neighbour.
      const subgraphByKind = Object.fromEntries(
        SUBGRAPH_KINDS.map(k => [k, subgraphChains(config, k)]),
      ) as Record<SubgraphKind, number[]>;

      // Hostnames only: a dedicated gateway URL can carry an access token in
      // its path or query.
      const gateways = resolveGateways(ctx)
        .map(gatewayHostname)
        .filter((h): h is string => h !== null);

      const result = {
        defaultChainId: config.defaultChainId,
        defaultChainName: CHAIN_NAMES[config.defaultChainId] ?? `chain ${config.defaultChainId}`,
        chains,
        subgraph: {
          /** Chains with at least one endpoint. Any other chain has no indexer. */
          chainsCovered: subgraphChains(config),
          /** Per subgraph, the chains it can answer for. */
          byKind: subgraphByKind,
          /** Kinds with no endpoint for the chain tools use when `chainId` is omitted. */
          missingForDefaultChain: SUBGRAPH_KINDS.filter(
            k => !subgraphByKind[k].includes(config.defaultChainId),
          ),
          /** Chain the unsuffixed DEXE_SUBGRAPH_*_URL vars are filed under. */
          unsuffixedVarsChainId: config.subgraphChainId,
        },
        backend: {
          /** DeXe backend API base (treasury, holders, stats); null when unset. */
          ...(remote ? {} : { url: config.backendApiUrl ? maskUrl(config.backendApiUrl) : null }),
          /** True while it is the shared public default rather than the operator's own. */
          sharedDefault: config.backendApiUrl === DEFAULTS.backendApiUrl,
        },
        ipfs: {
          /** Read gateways, in the order dexe_ipfs_fetch tries them (hostnames; a count when served remotely). */
          ...(remote ? { readGatewayCount: gateways.length } : { readGateways: gateways }),
          /** False when DEXE_IPFS_DISABLE_PUBLIC_FALLBACK=1 keeps the public gateways out. */
          publicFallback: process.env.DEXE_IPFS_DISABLE_PUBLIC_FALLBACK !== "1",
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
