import { describe, it, expect } from "vitest";
import {
  FLOWS,
  FLOW_BY_ID,
  TOPICS,
  TOPIC_BY_ID,
  GOTCHAS,
  GOTCHA_BY_ID,
  flowIndex,
  flowDetail,
  topicIndex,
  topicDetail,
} from "../../src/knowledge/index.js";
import { TOOLSETS } from "../../src/tools/gate.js";
import { FLOW_PROPOSAL_TYPES } from "../../src/lib/proposalBuilders.js";

/**
 * Integrity of the knowledge corpus — every reference must resolve, or a weak
 * model gets sent to a tool/flow/gotcha that doesn't exist.
 */

const ALL_TOOLS = new Set<string>();
for (const names of Object.values(TOOLSETS)) for (const n of names) ALL_TOOLS.add(n);

describe("knowledge corpus integrity", () => {
  it("gotcha ids are unique", () => {
    expect(GOTCHA_BY_ID.size).toBe(GOTCHAS.length);
  });

  it("flow ids are unique", () => {
    expect(FLOW_BY_ID.size).toBe(FLOWS.length);
  });

  it("every FlowStep.tool exists in the toolset union", () => {
    const orphans: string[] = [];
    for (const f of FLOWS) {
      for (const s of f.steps) {
        if (!ALL_TOOLS.has(s.tool)) orphans.push(`${f.id}.${s.id}: ${s.tool}`);
      }
    }
    expect(orphans, `steps referencing unregistered tools: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every gotchaId referenced by a flow or step resolves", () => {
    const missing: string[] = [];
    for (const f of FLOWS) {
      for (const id of f.gotchaIds) if (!GOTCHA_BY_ID.has(id)) missing.push(`${f.id}: ${id}`);
      for (const s of f.steps) {
        for (const id of s.gotchaIds ?? []) if (!GOTCHA_BY_ID.has(id)) missing.push(`${f.id}.${s.id}: ${id}`);
      }
    }
    expect(missing, `unresolved gotcha ids: ${missing.join(", ")}`).toEqual([]);
  });

  it("every gotcha applies.flows / applies.tools / applies.proposalTypes reference resolves", () => {
    const bad: string[] = [];
    const types = new Set<string>(FLOW_PROPOSAL_TYPES as readonly string[]);
    for (const g of GOTCHAS) {
      for (const f of g.applies.flows ?? []) if (!FLOW_BY_ID.has(f)) bad.push(`${g.id} → flow ${f}`);
      for (const t of g.applies.tools ?? []) if (!ALL_TOOLS.has(t)) bad.push(`${g.id} → tool ${t}`);
      for (const p of g.applies.proposalTypes ?? []) if (!types.has(p)) bad.push(`${g.id} → proposalType ${p}`);
    }
    expect(bad, `unresolved gotcha references: ${bad.join(", ")}`).toEqual([]);
  });

  it("every subFlows id resolves", () => {
    const missing: string[] = [];
    for (const f of FLOWS) for (const id of f.subFlows ?? []) if (!FLOW_BY_ID.has(id)) missing.push(`${f.id}: ${id}`);
    expect(missing).toEqual([]);
  });

  it("every flow has at least one trigger and a summary", () => {
    for (const f of FLOWS) {
      expect(f.triggers.length, f.id).toBeGreaterThan(0);
      expect(f.summary.length, f.id).toBeGreaterThan(10);
    }
  });

  it("every {{placeholder}} in paramsTemplate is declared in the interview or bindsFrom", () => {
    const undeclared: string[] = [];
    for (const f of FLOWS) {
      const declared = new Set(f.interview.map((p) => p.name));
      for (const s of f.steps) {
        const bound = new Set(Object.keys(s.bindsFrom ?? {}));
        // bindsFrom in ANY step of the flow can feed later steps
        for (const other of f.steps) for (const k of Object.keys(other.bindsFrom ?? {})) bound.add(k);
        for (const [, v] of Object.entries(s.paramsTemplate)) {
          for (const m of v.matchAll(/\{\{(\w+)\}\}/g)) {
            const name = m[1]!;
            if (!declared.has(name) && !bound.has(name)) undeclared.push(`${f.id}.${s.id}: {{${name}}}`);
          }
        }
      }
    }
    expect(undeclared, `undeclared placeholders: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("every next entry names exactly one of stepId (real step) or flowRef (real flow)", () => {
    const bad: string[] = [];
    for (const f of FLOWS) {
      const stepIds = new Set(f.steps.map((s) => s.id));
      for (const s of f.steps) {
        for (const n of s.next ?? []) {
          const hasStep = n.stepId !== undefined;
          const hasFlow = n.flowRef !== undefined;
          if (hasStep === hasFlow) bad.push(`${f.id}.${s.id}: needs exactly one of stepId/flowRef`);
          else if (hasStep && !stepIds.has(n.stepId!)) bad.push(`${f.id}.${s.id}: unknown stepId ${n.stepId}`);
          else if (hasFlow && !FLOW_BY_ID.has(n.flowRef!)) bad.push(`${f.id}.${s.id}: unknown flowRef ${n.flowRef}`);
        }
      }
    }
    expect(bad, bad.join(", ")).toEqual([]);
  });

  it("bindsFrom step references resolve to real step ids in the same flow", () => {
    const bad: string[] = [];
    for (const f of FLOWS) {
      const stepIds = new Set(f.steps.map((s) => s.id));
      for (const s of f.steps) {
        for (const [, ref] of Object.entries(s.bindsFrom ?? {})) {
          const stepId = ref.split(".")[0]!;
          if (!stepIds.has(stepId)) bad.push(`${f.id}.${s.id}: bindsFrom ${ref}`);
        }
      }
    }
    expect(bad, `bindsFrom pointing at unknown steps: ${bad.join(", ")}`).toEqual([]);
  });

  it("payload size ceilings: index < 4KB, every flow detail < 10KB serialized", () => {
    const indexBytes = Buffer.byteLength(JSON.stringify(flowIndex()), "utf8");
    expect(indexBytes).toBeLessThan(4096);
    for (const f of FLOWS) {
      const detail = flowDetail(f.id, { chainId: 97 });
      const bytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
      expect(bytes, `${f.id} detail is ${bytes} bytes`).toBeLessThan(10240);
    }
  });

  it("topic ids are unique and disjoint from flow ids (one guide namespace)", () => {
    expect(TOPIC_BY_ID.size).toBe(TOPICS.length);
    for (const t of TOPICS) expect(FLOW_BY_ID.has(t.id), `topic id '${t.id}' collides with a flow`).toBe(false);
  });

  it("every Topic.tools entry exists in the toolset union", () => {
    const orphans: string[] = [];
    for (const t of TOPICS) for (const tool of t.tools) if (!ALL_TOOLS.has(tool)) orphans.push(`${t.id}: ${tool}`);
    expect(orphans, `topics referencing unregistered tools: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every topic gotchaId resolves", () => {
    const missing: string[] = [];
    for (const t of TOPICS) for (const id of t.gotchaIds ?? []) if (!GOTCHA_BY_ID.has(id)) missing.push(`${t.id}: ${id}`);
    expect(missing, `unresolved topic gotcha ids: ${missing.join(", ")}`).toEqual([]);
  });

  it("every topic has triggers, a summary, and at least one section", () => {
    for (const t of TOPICS) {
      expect(t.triggers.length, t.id).toBeGreaterThan(0);
      expect(t.summary.length, t.id).toBeGreaterThan(10);
      expect(t.sections.length, t.id).toBeGreaterThan(0);
    }
  });

  it("topic payload ceilings: combined index < 6KB, every topic detail < 10KB serialized", () => {
    const combined = Buffer.byteLength(JSON.stringify({ flows: flowIndex(), topics: topicIndex() }), "utf8");
    expect(combined).toBeLessThan(6144);
    for (const t of TOPICS) {
      const bytes = Buffer.byteLength(JSON.stringify(topicDetail(t.id)), "utf8");
      expect(bytes, `${t.id} detail is ${bytes} bytes`).toBeLessThan(10240);
    }
  });

  it("topic details resolve gotchas danger-first and annotate non-default toolsets", () => {
    const d = topicDetail("read_dao_data")!;
    expect(d).not.toBeNull();
    const rank = { danger: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < d.gotchas.length; i++) {
      expect(rank[d.gotchas[i - 1]!.severity]).toBeLessThanOrEqual(rank[d.gotchas[i]!.severity]);
    }
    const graphQuery = d.tools.find((t) => t.tool === "dexe_graph_query")!;
    expect(graphQuery.requiresToolset).toContain("read");
  });

  it("chain-gated gotchas only surface on their chains", () => {
    const staking97 = flowDetail("staking_setup", { chainId: 97 })!;
    expect(staking97.gotchas.some((g) => g.id === "staking-not-on-testnet")).toBe(true);
    const staking56 = flowDetail("staking_setup", { chainId: 56 })!;
    expect(staking56.gotchas.some((g) => g.id === "staking-not-on-testnet")).toBe(false);
  });

  it("chainNotes surface for the active chain", () => {
    expect(flowDetail("staking_setup", { chainId: 97 })!.chainNote?.note).toMatch(/DOES NOT EXIST/i);
    expect(flowDetail("staking_setup", { chainId: 56 })!.chainNote).toBeUndefined();
    expect(flowDetail("launch_token_economy", { chainId: 97 })!.chainNote?.note).toMatch(/staking/i);
  });
});
