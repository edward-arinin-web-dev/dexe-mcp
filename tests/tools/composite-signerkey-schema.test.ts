import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * ── `signerKey` is a first-class input on every write composite ─────────────
 *
 * The keyring is only real if the CALLER can select a persona. `sendOrCollect`
 * has threaded `signerKey` internally for several releases; what makes a
 * multi-agent run possible is that the parameter appears on the tools an
 * orchestrator actually calls, is optional, and documents that omitting it
 * signs with the primary key.
 *
 * This is a schema guard, not a plumbing test: `agent-persona-signing.test.ts`
 * proves the named key is the one that signs. It exists because the input
 * schema is the entire contract a model sees — a parameter dropped from it
 * silently removes the feature while every internal test keeps passing.
 */

const WRITE_COMPOSITES = [
  "dexe_dao_create",
  "dexe_proposal_create",
  "dexe_proposal_vote_and_execute",
  "dexe_tx_send",
] as const;

interface ToolShape {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}

let tools: Map<string, ToolShape>;

beforeAll(async () => {
  delete process.env.DEXE_TOOLSETS;
  const config = await loadConfig();
  const server = new McpServer({ name: "schema-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.listTools();
  tools = new Map((res.tools as unknown as ToolShape[]).map((t) => [t.name, t]));
  await client.close();
  await server.close();
});

describe("write composites expose the persona selector", () => {
  it.each(WRITE_COMPOSITES)("%s takes an optional signerKey in the DEFAULT profile", (name) => {
    const tool = tools.get(name);
    expect(tool, `${name} must be in the default profile`).toBeDefined();

    const prop = tool!.inputSchema.properties?.signerKey;
    expect(prop, `${name} must expose signerKey`).toBeDefined();
    expect(prop!.type).toBe("string");
    // Optional: the primary key stays the default, so an existing single-signer
    // caller is unaffected.
    expect(tool!.inputSchema.required ?? []).not.toContain("signerKey");
  });

  it.each(WRITE_COMPOSITES)("%s documents that omitting signerKey signs with the primary key", (name) => {
    const text = tools.get(name)!.inputSchema.properties!.signerKey!.description ?? "";
    expect(text.toLowerCase()).toMatch(/omit/);
    expect(text.toLowerCase()).toMatch(/primary/);
    // The persona is named by slot or address — an orchestrator has to know the
    // two accepted forms to use the keyring at all.
    expect(text).toMatch(/agent|address/i);
  });

  it("dexe_tx_send publishes the GovUserKeeper hard block in its description", () => {
    // The refusal is unconditional, so it belongs in the contract, not only in
    // the error a caller discovers after building the calldata.
    expect(tools.get("dexe_tx_send")!.description ?? "").toMatch(/hard block, no override/i);
  });
});
