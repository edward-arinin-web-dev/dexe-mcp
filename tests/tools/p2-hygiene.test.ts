import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGovTools } from "../../src/tools/gov.js";
import type { ToolContext } from "../../src/tools/context.js";

/**
 * P2 hygiene. dexe_list_gov_contract_types hard-coded a nonexistent source path
 * `contracts/core/PoolRegistry.sol`; the real path is `contracts/factory/...`
 * (the MCP's own addresses module has it right). This pins the corrected path.
 */

type ToolCb = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
}>;

function captureGovTools(): Map<string, ToolCb> {
  const tools = new Map<string, ToolCb>();
  const store = (name: string, cb: ToolCb) => tools.set(name, cb);
  const fake = {
    registerTool: (name: string, _cfg: unknown, cb: ToolCb) => store(name, cb),
    tool: (name: string, _desc: unknown, _schema: unknown, cb: ToolCb) => store(name, cb),
  } as unknown as McpServer;
  registerGovTools(fake, { config: {}, artifacts: {}, selectors: {} } as unknown as ToolContext);
  return tools;
}

describe("list_gov_contract_types PoolRegistry path", () => {
  it("points PoolRegistry at contracts/factory, not the nonexistent contracts/core", async () => {
    const tool = captureGovTools().get("dexe_list_gov_contract_types");
    expect(tool).toBeDefined();
    const res = await tool!({});
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("contracts/factory/PoolRegistry.sol");
    expect(text).not.toContain("contracts/core/PoolRegistry.sol");
  });
});
