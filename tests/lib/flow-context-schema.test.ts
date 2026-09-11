import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { flowContextSchema, flowChainFields } from "../../src/lib/flowChain.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";

/**
 * D15-6 — `dexe_guide` handed the agent a flowContext the composites rejected.
 *
 * The guide's paramsTemplates are meant to be copied literally; an older build
 * emitted `flowContext` as a JSON STRING while every composite's schema
 * required an object, so a literal-copying agent got `-32602 Invalid arguments`
 * on a value the server itself had just given it — a dead end it cannot debug.
 *
 * The fix is a server-side net, not a widened contract: the ADVERTISED JSON
 * Schema must stay a plain object. `z.union([object, string])` would publish an
 * `anyOf` on four composite schemas and teach every future caller a shape
 * nobody should send.
 */

describe("flowContextSchema accepts what dexe_guide hands out", () => {
  it("takes the object form", () => {
    expect(flowContextSchema.parse({ flow: "otc_sale", step: "open" })).toEqual({
      flow: "otc_sale",
      step: "open",
    });
  });

  it("takes the JSON-string form an older/cached guide emitted", () => {
    expect(flowContextSchema.parse('{"flow":"vote_execute","step":"vote_execute"}')).toEqual({
      flow: "vote_execute",
      step: "vote_execute",
    });
  });

  it("still rejects a string that is not a flowContext", () => {
    expect(() => flowContextSchema.parse("open")).toThrow();
    expect(() => flowContextSchema.parse('"just a json string"')).toThrow();
    expect(() => flowContextSchema.parse('{"flow":"otc_sale"}')).toThrow();
  });

  it("stays optional", () => {
    expect(flowContextSchema.parse(undefined)).toBeUndefined();
  });
});

describe("the advertised schema is unchanged — no anyOf leaked onto the wire", () => {
  const COMPOSITES = [
    "dexe_dao_create",
    "dexe_proposal_create",
    "dexe_proposal_vote_and_execute",
    "dexe_otc_dao_open_sale",
  ];

  it("every composite still publishes flowContext as a plain object", async () => {
    const prior = process.env.DEXE_TOOLSETS;
    process.env.DEXE_TOOLSETS = "full";
    try {
      const server = new McpServer({ name: "t", version: "0.0.0" }, {});
      registerAll(server, await loadConfig());
      const client = new Client({ name: "c", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      for (const name of COMPOSITES) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, `${name} is not registered`).toBeDefined();
        const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        const fc = props.flowContext as Record<string, unknown> | undefined;
        expect(fc, `${name}.flowContext missing`).toBeDefined();
        expect(fc!.type, `${name}.flowContext is not a plain object`).toBe("object");
        expect(fc!, `${name}.flowContext published an anyOf`).not.toHaveProperty("anyOf");
        expect(Object.keys(fc!.properties as object).sort()).toEqual(["flow", "step"]);
      }
      await client.close();
      await server.close();
    } finally {
      if (prior === undefined) delete process.env.DEXE_TOOLSETS;
      else process.env.DEXE_TOOLSETS = prior;
    }
  });
});

describe("a preview gets the pointers without advancing the journey", () => {
  const CTX = { flow: "create_proposal", step: "create" };

  it("a landed step persists the position", () => {
    const writes: unknown[] = [];
    const state = {
      setActiveFlow: (a: unknown) => writes.push(a),
      clearActiveFlow: () => writes.push("clear"),
    } as never;
    const out = flowChainFields(CTX, state, { chainId: 97 }, { landed: true });
    expect(writes.length).toBe(1);
    expect(out.flowProgress).toBeDefined();
    expect(Array.isArray(out.next)).toBe(true);
  });

  it("a preview returns the SAME pointers and writes NOTHING", () => {
    // setActiveFlow is rendered back to the agent as COMPLETED work
    // (dexe_context's "last completed step", dexe_guide's "progress N of M"),
    // so a dryRun that advanced it would make the next session resume past a
    // step that never happened.
    const writes: unknown[] = [];
    const state = {
      setActiveFlow: (a: unknown) => writes.push(a),
      clearActiveFlow: () => writes.push("clear"),
    } as never;
    const out = flowChainFields(CTX, state, { chainId: 97 }, { landed: false });
    expect(writes).toEqual([]);
    expect(out.flowProgress).toBeDefined();
    expect(Array.isArray(out.next)).toBe(true);
    for (const n of out.next!) {
      expect(n.when).toMatch(/^after you broadcast this step: /);
    }
    expect(out.flowDone).toBeUndefined();
  });

  it("`next` is still the chaining ARRAY, never a string", () => {
    // The one shape a composite must not clobber: a `next: string` of its own
    // would silently replace this in every guide-driven journey.
    const out = flowChainFields(CTX, undefined, { chainId: 97 });
    expect(Array.isArray(out.next)).toBe(true);
    for (const n of out.next!) {
      expect(typeof n.tool).toBe("string");
      expect(typeof n.when).toBe("string");
      expect(typeof n.why).toBe("string");
    }
  });
});
