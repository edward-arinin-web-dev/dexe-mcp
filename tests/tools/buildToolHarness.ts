/**
 * Shared in-memory harness for the build-tool suites: registers the four
 * builder modules against a real McpServer and calls them through a real
 * client, so every assertion goes through the SAME path an agent does
 * (schema parse, handler, outputSchema) rather than through an exported
 * function the tool may or may not still use.
 *
 * Not a `.test.ts` file on purpose — importing one test file from another
 * re-runs its suites.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";
import { registerProposalBuildTools } from "../../src/tools/proposalBuild.js";
import { registerProposalBuildMoreTools } from "../../src/tools/proposalBuildMore.js";
import { registerProposalBuildComplexTools } from "../../src/tools/proposalBuildComplex.js";
import { registerVoteBuildTools } from "../../src/tools/voteBuild.js";
import type { BuildWarning } from "../../src/lib/buildWarning.js";

/** No `chains` map ⇒ every RpcProvider lookup fails ⇒ these suites are offline. */
export function ctx(defaultChainId = 97): ToolContext {
  return {
    config: {
      rpcUrl: undefined,
      defaultChainId,
      chainId: defaultChainId,
      treasuryGuard: "warn",
      minSafeQuorumPct: 50,
      chains: new Map(),
    } as unknown as DexeConfig,
  } as unknown as ToolContext;
}

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  toolCtx: ToolContext = ctx(),
): Promise<ToolResult> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalBuildTools(server, toolCtx);
  registerProposalBuildMoreTools(server, toolCtx);
  registerProposalBuildComplexTools(server, toolCtx);
  registerVoteBuildTools(server, toolCtx);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

export function warningsOf(r: ToolResult): BuildWarning[] {
  return (r.structuredContent?.warnings as BuildWarning[] | undefined) ?? [];
}

export const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("\n");
