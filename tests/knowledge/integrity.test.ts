import { describe, it, expect } from "vitest";
import { FLOWS, FLOW_BY_ID, GOTCHAS, GOTCHA_BY_ID, flowIndex, flowDetail } from "../../src/knowledge/index.js";
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
