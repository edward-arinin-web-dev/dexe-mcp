import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadReadConfig } from "../../src/configRead.js";
import { Artifacts } from "../../src/artifacts.js";
import { SelectorIndex } from "../../src/lib/selectors.js";
import type { ToolContext } from "../../src/tools/context.js";
import { applyToolsetGate, READ_EDITION_TOOLSETS } from "../../src/tools/toolsets.js";
import { applyToolAnnotations, READ_ANNOTATIONS } from "../../src/tools/annotations.js";
import { applyReadResultGuard } from "../../src/tools/readGuard.js";
import { installListToolsNormalizer } from "../../src/tools/schemaNormalize.js";
import { readInstructions } from "../../src/instructions.js";
import { registerDaoTools } from "../../src/tools/dao.js";
import { registerGovTools } from "../../src/tools/gov.js";
import { registerProposalTools } from "../../src/tools/proposal.js";
import { registerVoteTools } from "../../src/tools/vote.js";
import { registerReadTools } from "../../src/tools/read.js";
import { registerIpfsReadTools } from "../../src/tools/ipfsRead.js";
import { registerSubgraphTools } from "../../src/tools/subgraph.js";
import { registerReportTools } from "../../src/tools/report.js";
import { registerInboxTools } from "../../src/tools/inbox.js";
import { registerPredictTools } from "../../src/tools/predict.js";
import { registerRiskTools } from "../../src/tools/risk.js";
import { registerTokenSaleReadTools } from "../../src/tools/tokenSaleRead.js";
import { registerGetConfigTool } from "../../src/tools/getConfig.js";
import { registerDoctorTool } from "../../src/tools/doctor.js";
import { registerOperationalContextTools } from "../../src/tools/operationalContext.js";
import { registerGuideTool } from "../../src/tools/guide.js";
import { registerGovernorTools } from "../../src/governor/index.js";
import { createKnowledge, createToolLocator } from "../../src/knowledge/engine.js";
import { READ_CORPUS } from "../../src/knowledge/read/index.js";

/**
 * The READ edition's tool surface, wired from read modules only, the way the
 * read server will wire it (A9 turns this into its entrypoint): read config,
 * the read edition's ungated toolset table and annotation table, the read-tool
 * result guard, NO state store, NO report snapshot store, the read corpus and
 * guide wording, the read doctor checks, and no governor write half.
 *
 * Every import here is a read-side module (tests/boundary/modules.ts), so the
 * import-boundary walk already proves none of this can reach write code.
 */
export interface ReadEditionListing {
  names: string[];
  tools: Tool[];
  instructions: string | undefined;
}

export function registerReadEdition(server: McpServer, config: Awaited<ReturnType<typeof loadReadConfig>>): void {
  // The read edition has no protocol checkout: the decoders fall back to the
  // bundled ABI snapshot.
  const artifacts = new Artifacts({ protocolPath: join(tmpdir(), "dexe-read-edition-no-protocol") });
  const ctx: ToolContext = { config, artifacts, selectors: new SelectorIndex(artifacts) };

  installListToolsNormalizer(server);
  const s = applyReadResultGuard(
    applyToolAnnotations(applyToolsetGate(server, config, READ_EDITION_TOOLSETS), READ_ANNOTATIONS),
    config,
  );

  registerDaoTools(s, ctx);
  registerGovTools(s, ctx);
  registerProposalTools(s, ctx);
  registerVoteTools(s, ctx);
  registerReadTools(s, ctx);
  registerIpfsReadTools(s, ctx);
  registerSubgraphTools(s, ctx);
  registerReportTools(s, ctx, { toolsets: READ_EDITION_TOOLSETS });
  registerInboxTools(s, ctx);
  registerPredictTools(s, ctx);
  registerRiskTools(s, ctx);
  registerTokenSaleReadTools(s, ctx);
  registerGetConfigTool(s, ctx);
  registerDoctorTool(s, config, undefined, { toolsets: READ_EDITION_TOOLSETS });
  registerOperationalContextTools(s, config, null, { toolsets: READ_EDITION_TOOLSETS });
  registerGuideTool(s, config, null, {
    knowledge: createKnowledge(
      READ_CORPUS,
      createToolLocator({ toolsets: READ_EDITION_TOOLSETS.sets, defaultTools: READ_EDITION_TOOLSETS.sets.read! }),
    ),
  });
  registerGovernorTools(s, config);
}

/** Boot the read edition over an in-memory transport and return what a host sees. */
export async function listReadEdition(): Promise<ReadEditionListing> {
  const config = await loadReadConfig();
  const server = new McpServer(
    { name: "dexe-mcp-read", version: "0.0.0" },
    { instructions: readInstructions() },
  );
  registerReadEdition(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return { names: res.tools.map((t) => t.name).sort(), tools: res.tools, instructions };
}
