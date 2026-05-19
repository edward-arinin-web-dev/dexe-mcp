import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import { RpcProvider } from "../rpc.js";
import { registerGovernorReadTools } from "./tools/read.js";

/**
 * External Governor MCP surface (research/06-execution-plan.md).
 *
 * Independent from DeXe Protocol tools — no dependency on DeXe contracts being
 * deployed on the target chain (AC #11). Tools live under the `dexe_gov_*`
 * namespace.
 */
export function registerGovernorTools(server: McpServer, config: DexeConfig): void {
  const rpc = new RpcProvider(config);
  registerGovernorReadTools(server, rpc);
}
