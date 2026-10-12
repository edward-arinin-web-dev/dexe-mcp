import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadConfig } from "../configRead.js";
import { RpcProvider } from "../rpc.js";
import { registerGovernorReadTools } from "./tools/read.js";
import { registerGovernorSimulateTools } from "./tools/simulate.js";
import { registerGovernorExtraTools } from "./tools/extras.js";

/**
 * External Governor MCP surface (research/06-execution-plan.md).
 *
 * Independent from DeXe Protocol tools — no dependency on DeXe contracts being
 * deployed on the target chain (AC #11). Tools live under the `dexe_gov_*`
 * namespace.
 *
 * This is the read half: lookups, the vote-impact projection, state and
 * has-voted. The builders, the execute dry-run and the calldata/hash helpers
 * are the write half (./write.ts), which a server that carries write tools
 * passes in so they register at the positions the single server has always
 * listed them; a read-only server passes nothing.
 */
export interface GovernorWriteTools {
  /** Registered right after the five lookups (today: builders + simulate_proposal). */
  afterLookups(server: McpServer, rpc: RpcProvider): void;
  /** Registered last, after the read analysis tools (today: cancel / decode / hash). */
  afterAnalysis(server: McpServer, rpc: RpcProvider): void;
}

export function registerGovernorTools(
  server: McpServer,
  config: ReadConfig,
  write?: GovernorWriteTools,
): void {
  const rpc = new RpcProvider(config);
  registerGovernorReadTools(server, rpc);
  write?.afterLookups(server, rpc);
  registerGovernorSimulateTools(server, rpc);
  registerGovernorExtraTools(server, rpc);
  write?.afterAnalysis(server, rpc);
}
