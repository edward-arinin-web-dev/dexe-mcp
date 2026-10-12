import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadReadConfig } from "../../src/configRead.js";
import { Artifacts } from "../../src/artifacts.js";
import { SelectorIndex } from "../../src/lib/selectors.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerOperationalContextTools } from "../../src/tools/operationalContext.js";
import { registerGetConfigTool } from "../../src/tools/getConfig.js";
import { registerGuideTool } from "../../src/tools/guide.js";
import { createKnowledge, createToolLocator } from "../../src/knowledge/engine.js";
import { READ_CORPUS } from "../../src/knowledge/read/index.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { toolRefs } from "../helpers/toolTokens.js";

/**
 * The three orientation tools wired the way a READ edition wires them (A6):
 * read config, NO state store, the read corpus, a toolset catalog that names
 * no write tool. Nothing they publish or answer may name a write-edition tool,
 * and none of them may need the write config or a signer to run.
 *
 * The A9 entrypoint test ("no read text names a write tool") generalizes this
 * to every read tool; this pins the three A6 split.
 */

const WRITE = new Set(WRITE_TOOLS);
const READ = new Set(READ_TOOLS);
const writeToolsIn = (text: string) =>
  toolRefs(text)
    .filter(({ ref, glob }) => (glob ? WRITE_TOOLS.some((n) => n.startsWith(ref)) : WRITE.has(ref)))
    .map(({ raw }) => raw);

afterEach(() => {
  delete process.env.DEXE_TOOLSETS;
});

async function readServer() {
  process.env.DEXE_TOOLSETS = "full";
  const config = await loadReadConfig();
  // None of the three reads artifacts; the read edition will not have a protocol checkout.
  const artifacts = new Artifacts({ protocolPath: join(tmpdir(), "dexe-no-protocol") });
  const ctx: ToolContext = { config, artifacts, selectors: new SelectorIndex(artifacts) };
  const server = new McpServer({ name: "read-orientation", version: "0.0.0" }, {});
  registerOperationalContextTools(server, config, null, {
    toolsets: { unlocks: {}, defaultCovers: "the default profile already includes the reporting reads" },
  });
  registerGetConfigTool(server, ctx);
  registerGuideTool(server, config, null, {
    knowledge: createKnowledge(
      READ_CORPUS,
      createToolLocator({ toolsets: { read: READ }, defaultTools: READ }),
    ),
  });
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

describe("read orientation tools, wired as the read edition", () => {
  it("publish and answer without naming a write-edition tool", async () => {
    const { client, server } = await readServer();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(["dexe_context", "dexe_get_config", "dexe_guide"]);
      const published = JSON.stringify(listed.tools);
      expect(writeToolsIn(published)).toEqual([]);

      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
        return r.content[0]!.text;
      };
      const answers = [
        await call("dexe_context", {}),
        await call("dexe_get_config", {}),
        await call("dexe_guide", {}),
        await call("dexe_guide", { flow: "read_dao_data" }),
        await call("dexe_guide", { flow: "report_dao_activity", chainId: 97 }),
        await call("dexe_guide", { intent: "weekly report on my dao" }),
      ];
      for (const a of answers) expect(writeToolsIn(a)).toEqual([]);

      // No state store: no recorded-DAO fields, and the hint says why.
      const ctx = JSON.parse(answers[0]!);
      expect(ctx).not.toHaveProperty("knownDaos");
      expect(ctx.chain.lastUsedChainId).toBeNull();
      expect(ctx.hint).toMatch(/keeps no local state/);
      for (const k of ["signer", "keyring", "activeFlow"]) expect(ctx).not.toHaveProperty(k);

      // dexe_get_config carries the read config only (D6).
      const cfg = JSON.parse(answers[1]!);
      expect(Object.keys(cfg)).toEqual(["defaultChainId", "defaultChainName", "chains", "subgraph", "backend", "ipfs"]);
      expect(cfg.ipfs.readGateways.length).toBeGreaterThan(0);
      for (const h of cfg.ipfs.readGateways) expect(h).not.toMatch(/\//);

      // The read guide serves topics only; a write journey is not an id it knows.
      const menu = JSON.parse(answers[2]!);
      expect(menu.flows).toEqual([]);
      expect(menu.topics.map((t: { topic: string }) => t.topic)).toEqual(["read_dao_data", "report_dao_activity"]);
      expect(menu.context).not.toHaveProperty("knownDao");
      expect(menu.context).not.toHaveProperty("activeFlow");
      expect(JSON.parse(answers[5]!).topic).toBe("report_dao_activity");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
