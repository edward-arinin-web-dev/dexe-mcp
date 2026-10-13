import { describe, it, expect } from "vitest";
import { createKnowledge, createToolLocator, READ_CORPUS, READ_GOTCHAS } from "@dexe-network/dexe-mcp/core";
import { READ_GUIDE_TEXT } from "@dexe-network/dexe-mcp/testing";
import { WRITE_CORPUS, WRITE_GOTCHAS, FLOWS } from "../../src/knowledge/write/index.js";
import { SINGLE_SERVER_CORPUS, SINGLE_SERVER_KNOWLEDGE } from "../../src/knowledge/index.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { TOOLSETS } from "../../src/tools/gate.js";
import { toolRefs } from "../helpers/toolTokens.js";

/**
 * The knowledge layer split into a READ corpus (topics + data-read gotchas)
 * and a WRITE corpus (the journeys + every gotcha they cite), with one engine
 * that takes a corpus and a tool locator as parameters (A6).
 *
 * What these pin: read knowledge never routes an agent to a write tool, the
 * write corpus resolves every id it cites, the single server's corpus is
 * exactly the two halves, and a locator can say "provided by the read server".
 */

const WRITE = new Set(WRITE_TOOLS);
const READ = new Set(READ_TOOLS);

/** Every write-edition tool named in `text` (globs like dexe_proposal_build_* included). */
function writeToolsIn(text: string): string[] {
  return toolRefs(text)
    .filter(({ ref, glob }) => (glob ? WRITE_TOOLS.some((n) => n.startsWith(ref)) : WRITE.has(ref)))
    .map(({ raw }) => raw);
}

describe("read corpus", () => {
  it("has no step journeys — every flow is a write journey", () => {
    expect(READ_CORPUS.flows).toEqual([]);
    expect(READ_CORPUS.topics.map((t) => t.id)).toEqual(["read_dao_data", "report_dao_activity"]);
    expect(READ_GOTCHAS.map((g) => g.id)).toEqual([
      "quorum-two-units",
      "graph-bound-first",
      "subgraph-backend-mainnet-only",
      "multicall-signature-form",
    ]);
  });

  it("topics cite only read gotchas and document only read tools", () => {
    const readGotchas = new Set(READ_GOTCHAS.map((g) => g.id));
    for (const t of READ_CORPUS.topics) {
      for (const id of t.gotchaIds ?? []) expect(readGotchas.has(id), `${t.id} cites ${id}`).toBe(true);
      for (const tool of t.tools) expect(READ.has(tool), `${t.id} documents ${tool}`).toBe(true);
    }
  });

  it("no topic or read gotcha text names a write-edition tool", () => {
    const offenders: string[] = [];
    for (const t of READ_CORPUS.topics) {
      const text = [t.title, t.summary, ...t.sections.map((s) => `${s.heading} ${s.text}`)].join("\n");
      for (const w of writeToolsIn(text)) offenders.push(`topic ${t.id}: ${w}`);
    }
    for (const g of READ_GOTCHAS) {
      for (const w of writeToolsIn(g.text)) offenders.push(`gotcha ${g.id}: ${w}`);
      for (const tool of g.applies.tools ?? []) if (WRITE.has(tool)) offenders.push(`gotcha ${g.id} applies to ${tool}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the read guide's own wording names no write-edition tool", () => {
    const text = [READ_GUIDE_TEXT.description, READ_GUIDE_TEXT.intent, READ_GUIDE_TEXT.flow].join("\n");
    expect(writeToolsIn(text)).toEqual([]);
    expect(writeToolsIn(READ_GUIDE_TEXT.multiMatchNote(["read_dao_data", "report_dao_activity"]))).toEqual([]);
  });
});

describe("write corpus", () => {
  it("is the eight journeys", () => {
    expect(WRITE_CORPUS.flows).toBe(FLOWS);
    expect(FLOWS).toHaveLength(8);
    expect(WRITE_CORPUS.topics).toEqual([]);
    expect(WRITE_CORPUS.agentProtocol).toBeTruthy();
  });

  it("its gotchas are exactly its own plus the read ones, each once", () => {
    const ids = WRITE_CORPUS.gotchas.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set([...WRITE_GOTCHAS, ...READ_GOTCHAS].map((g) => g.id)));
    // read gotchas are the read corpus's objects, not copies
    for (const g of READ_GOTCHAS) expect(WRITE_CORPUS.gotchas).toContain(g);
  });

  it("every gotcha id a flow or step cites resolves inside the write corpus", () => {
    const known = new Set(WRITE_CORPUS.gotchas.map((g) => g.id));
    const missing: string[] = [];
    for (const f of FLOWS) {
      for (const id of f.gotchaIds) if (!known.has(id)) missing.push(`${f.id}: ${id}`);
      for (const s of f.steps) for (const id of s.gotchaIds ?? []) if (!known.has(id)) missing.push(`${f.id}.${s.id}: ${id}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("the single server's corpus", () => {
  it("is the write journeys next to the read topics, flows first", () => {
    expect(SINGLE_SERVER_CORPUS.flows).toBe(WRITE_CORPUS.flows);
    expect(SINGLE_SERVER_CORPUS.topics).toBe(READ_CORPUS.topics);
    expect(SINGLE_SERVER_CORPUS.gotchas).toBe(WRITE_CORPUS.gotchas);
    expect(SINGLE_SERVER_KNOWLEDGE.ids).toEqual([
      ...FLOWS.map((f) => f.id),
      ...READ_CORPUS.topics.map((t) => t.id),
    ]);
  });

  it("locates every tool on this server — never 'provided by' another one", () => {
    for (const id of SINGLE_SERVER_KNOWLEDGE.ids) {
      const d = SINGLE_SERVER_KNOWLEDGE.flowDetail(id) ?? SINGLE_SERVER_KNOWLEDGE.topicDetail(id);
      expect(JSON.stringify(d)).not.toContain("providedBy");
    }
  });
});

describe("tool locator", () => {
  // A write edition registers only write tools; the read tools its flows call
  // come from the read server.
  const writeOnlySets: Record<string, ReadonlySet<string>> = Object.fromEntries(
    Object.entries(TOOLSETS).map(([s, names]) => [s, new Set([...names].filter((n) => WRITE.has(n)))]),
  );
  const writeLocator = createToolLocator({
    toolsets: writeOnlySets,
    defaultTools: new Set([...TOOLSETS.core!].filter((n) => WRITE.has(n))),
    elsewhere: { tools: READ, providedBy: "the DeXe read server" },
  });

  it("names the other server for a tool this one does not register", () => {
    expect(writeLocator("dexe_proposal_state")).toEqual({ providedBy: "the DeXe read server" });
    expect(writeLocator("dexe_dao_create")).toEqual({});
    expect(writeLocator("dexe_sim_calldata")).toEqual({ requiresToolset: "dev" });
  });

  it("a write-edition guide reports read steps as provided by the read server", () => {
    const k = createKnowledge(WRITE_CORPUS, writeLocator);
    const vote = k.flowDetail("vote_execute")!;
    const state = vote.steps.find((s) => s.tool === "dexe_proposal_state")!;
    expect(state.providedBy).toBe("the DeXe read server");
    expect(state.requiresToolset).toBeUndefined();
    // and nothing the corpus does not carry
    expect(k.topicDetail("read_dao_data")).toBeNull();
  });

  it("refuses a corpus with flows but no agent protocol", () => {
    expect(() =>
      createKnowledge({ flows: FLOWS, topics: [], gotchas: [] }, () => ({})),
    ).toThrow(/agentProtocol/);
  });
});
