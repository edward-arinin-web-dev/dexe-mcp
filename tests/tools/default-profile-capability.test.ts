import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLSETS } from "../../src/tools/gate.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { PROPOSAL_CATALOG, type ProposalTypeEntry } from "../../src/lib/proposalCatalog.js";

/**
 * 0.31.0 traded the ~30 single-purpose `dexe_proposal_build_*` tools out of the
 * default profile for the zero-config reporting reads. That trade is only safe
 * while `dexe_proposal_create` really does cover what the demoted builders did,
 * so this file pins both directions:
 *
 *   - CAPABILITY: every on-chain catalog proposal type is still reachable from
 *     the default profile, through the composite's own `proposalType` enum.
 *     Demoting a builder can therefore never silently remove a capability — if
 *     someone drops a type from PROPOSAL_BUILDERS, this fails.
 *   - REACHABILITY: nothing demoted became unreachable. Every demoted builder is
 *     still loadable via DEXE_TOOLSETS and still listed in docs/TOOLS.md.
 *
 * The composite's enum is read from the LIVE `tools/list` inputSchema, not from
 * the source constant — what an agent can actually discover in a default
 * session is the thing under test.
 */

async function listTools(toolsetsEnv: string | undefined) {
  if (toolsetsEnv === undefined) delete process.env.DEXE_TOOLSETS;
  else process.env.DEXE_TOOLSETS = toolsetsEnv;
  const config = await loadConfig();
  const server = new McpServer({ name: "capability-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = await client.listTools();
  await client.close();
  await server.close();
  return res.tools;
}

/**
 * Catalog id → the `proposalType` string `dexe_proposal_create` accepts. The id
 * suffix is the type name for almost every entry; these two are the exceptions,
 * spelled out rather than pattern-matched so a rename can't quietly re-point
 * them at a different builder.
 */
const FLOW_TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  // Raw {target,callData,value}[] — the composite takes these as actionsOnFor.
  "external.manual_calldata": "custom",
  "internal.offchain_proposal": "offchain_internal_proposal",
};

function flowTypeFor(entry: ProposalTypeEntry): string {
  const override = FLOW_TYPE_OVERRIDES[entry.id];
  if (override) return override;
  const suffix = entry.id.slice(entry.id.indexOf(".") + 1);
  // Off-chain ids drop the category prefix the flow types carry explicitly.
  return entry.category === "offchain" ? `offchain_${suffix}` : suffix;
}

const ALL_SET_NAMES = new Set<string>();
for (const names of Object.values(TOOLSETS)) for (const n of names) ALL_SET_NAMES.add(n);

const TOOLS_MD = readFileSync(resolve(process.cwd(), "docs/TOOLS.md"), "utf8");

describe("default profile keeps every proposal capability", () => {
  let defaultNames: string[];
  let proposalTypes: string[];

  beforeAll(async () => {
    const tools = await listTools(undefined);
    defaultNames = tools.map((t) => t.name);
    const create = tools.find((t) => t.name === "dexe_proposal_create");
    expect(create, "dexe_proposal_create must be in the default profile").toBeDefined();
    const schema = create!.inputSchema as {
      properties?: Record<string, { enum?: unknown }>;
    };
    const values = schema.properties?.proposalType?.enum;
    expect(
      Array.isArray(values),
      "dexe_proposal_create must advertise its proposalType values in inputSchema — " +
        "that enum is how an agent discovers the types once the builders are demoted",
    ).toBe(true);
    proposalTypes = values as string[];
  });

  it("every on-chain catalog type is a proposalType the default composite accepts", () => {
    const unreachable: string[] = [];
    for (const entry of PROPOSAL_CATALOG) {
      if (entry.category === "offchain") continue; // backend API — covered below
      const type = flowTypeFor(entry);
      if (!proposalTypes.includes(type)) unreachable.push(`${entry.id} → '${type}'`);
    }
    expect(
      unreachable,
      `catalog types with no proposalType in the default profile: ${unreachable.join(", ")}. ` +
        `Either wire the type into PROPOSAL_BUILDERS or keep its builder in core — ` +
        `the default profile must not lose a capability.`,
    ).toEqual([]);
  });

  it("off-chain catalog types are signposted, never dead ends", () => {
    // These are created on the DeXe backend, not on-chain, so the composite
    // refuses them by design. It must still either name the type (and return
    // the backend flow) or leave the dedicated builder loadable.
    const stranded: string[] = [];
    for (const entry of PROPOSAL_CATALOG) {
      if (entry.category !== "offchain") continue;
      const namedByComposite = proposalTypes.includes(flowTypeFor(entry));
      const builderLoadable = entry.mcpTool ? ALL_SET_NAMES.has(entry.mcpTool) : false;
      if (!namedByComposite && !builderLoadable) stranded.push(entry.id);
    }
    expect(stranded, `off-chain types with no route at all: ${stranded.join(", ")}`).toEqual([]);
  });

  it("every builder demoted out of core is still loadable and documented", () => {
    const demoted = [
      ...new Set(
        PROPOSAL_CATALOG.map((e) => e.mcpTool).filter(
          (t): t is string => !!t && t.startsWith("dexe_proposal_build_") && !defaultNames.includes(t),
        ),
      ),
    ];
    // The demotion is the point of the release — if this is empty the test has
    // stopped testing anything.
    expect(demoted.length, "expected the single-purpose builders to be out of core").toBeGreaterThan(10);

    const notLoadable = demoted.filter((t) => !ALL_SET_NAMES.has(t));
    expect(
      notLoadable,
      `demoted but not in any DEXE_TOOLSETS profile (unreachable): ${notLoadable.join(", ")}`,
    ).toEqual([]);

    const undocumented = demoted.filter((t) => !TOOLS_MD.includes(t));
    expect(
      undocumented,
      `demoted but missing from docs/TOOLS.md: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("the zero-config reporting surface is in core", () => {
    // The promise README and the dexe://graph-schema resource already made.
    // Checked against TOOLSETS.core, not the live list: this asserts the gate's
    // INTENT, so it fails loudly on a demotion even if a register file is
    // temporarily absent (which the live list would silently agree with).
    for (const t of [
      "dexe_dao_report",
      "dexe_graph_query",
      "dexe_read_dao_list",
      "dexe_read_dao_stats",
      "dexe_read_dao_members",
      "dexe_read_token_holders",
      "dexe_read_delegation_map",
      "dexe_ipfs_fetch",
    ]) {
      expect(TOOLSETS.core!.has(t), `${t} must be in the core toolset`).toBe(true);
    }
  });
});
