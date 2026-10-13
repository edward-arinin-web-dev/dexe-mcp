import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateStore } from "@dexe-network/dexe-mcp/core";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { instructionsFor } from "../../src/instructionsWrite.js";
import { READ_TOOLS } from "../../src/editions.js";
import { FLOWS } from "../../src/knowledge/write/flows.js";
import { nextAfter } from "../../src/knowledge/write/nextSteps.js";
import { writeKnownFailures } from "../../src/lib/writeErrors.js";
import { readServerMarkAfter, toolRefs } from "../helpers/toolTokens.js";
import { registerWriteDocResources } from "../../src/tools/resourcesWrite.js";
import { DEPRECATED_ALIASES } from "../../src/tools/aliases.js";
import { resolve } from "node:path";

/**
 * ── No write text claims a tool this server does not have (1.0.0) ──────────
 *
 * The write-only server (the default) registers WRITE_TOOLS; the DeXe read
 * server beside it registers READ_TOOLS. Every `dexe_*` name the write server
 * hands the model must therefore be either
 *
 *   a) registered by THIS server in this mode, or
 *   b) a READ tool explicitly marked as the read server's — `(read server)`
 *      after the name in prose, or `providedBy` on a structured step/pointer.
 *
 * Walked over everything the model reads from this server, in both modes:
 * the handshake, every published description and schema description, the
 * `dexe_write_guide` index and every flow plan on both chains, the `next`
 * pointer after every step of every flow, the known-failure remedies, the
 * `dexe_write_doctor` report and the `dexe_write_context` result.
 *
 * Standalone (DEXE_WRITE_STANDALONE=1) registers the read tools too, so there a
 * name only has to exist; a mark on it stays true (it IS a read-server tool).
 */

const READ = new Set(READ_TOOLS);

/** Every string reachable in `v` (values only). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

interface Session {
  mode: "write-only" | "standalone";
  registered: Set<string>;
  client: Client;
  close: () => Promise<void>;
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
}

async function boot(mode: Session["mode"], statePath: string): Promise<Session> {
  process.env.DEXE_TOOLSETS = "full";
  process.env.DEXE_STATE_PATH = statePath;
  delete process.env.DEXE_PINATA_JWT; // dexe_write_doctor then probes nothing
  const config = { ...(await loadConfig()), writeStandalone: mode === "standalone" };
  const server = new McpServer({ name: "refs", version: "0.0.0" }, { instructions: instructionsFor(config) });
  registerAll(server, config);
  registerWriteDocResources(server, resolve(__dirname, "..", ".."), config);
  const client = new Client({ name: "refs-client", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const registered = new Set((await client.listTools()).tools.map((t) => t.name));
  return {
    mode,
    registered,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
    call: async (name, args = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[] };
      return res.content.map((x) => x.text ?? "").join("\n");
    },
  };
}

/** The names in `text` that are neither registered nor marked as the read server's. */
function dangling(text: string, registered: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const { raw, ref, glob, end } of toolRefs(text)) {
    const local = glob ? [...registered].some((n) => n.startsWith(ref)) : registered.has(ref);
    if (local) continue;
    const isRead = glob ? READ_TOOLS.some((n) => n.startsWith(ref)) : READ.has(ref);
    if (isRead && readServerMarkAfter(text, end)) continue;
    const at = Math.max(0, end - raw.length - 60);
    out.push(`${raw}: …${text.slice(at, end + 40).replace(/\s+/g, " ")}…`);
  }
  return out;
}

/** A structured step / pointer: its `tool` must be local or `providedBy` someone. */
function danglingStep(step: { tool: string; providedBy?: string }, registered: ReadonlySet<string>): string[] {
  if (registered.has(step.tool)) return [];
  if (READ.has(step.tool) && step.providedBy) return [];
  return [`${step.tool} (structured, providedBy=${step.providedBy ?? "none"})`];
}

for (const mode of ["write-only", "standalone"] as const) {
  describe(`${mode}: every tool the write server names is here or marked (read server)`, () => {
    let s: Session;
    let dir: string;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `dexe-refs-${mode}-`));
      const statePath = join(dir, "state.json");
      const st = new StateStore(statePath);
      st.recordDao({
        name: "Meridian Collective",
        govPool: "0xf113630C0000000000000000000000000000abcd",
        chainId: 97,
      } as Parameters<StateStore["recordDao"]>[0]);
      st.setActiveFlow({ flow: "launch_token_economy", step: "leg_dao", chainId: 97 });
      s = await boot(mode, statePath);
    });

    afterAll(async () => {
      await s.close();
      delete process.env.DEXE_STATE_PATH;
      delete process.env.DEXE_TOOLSETS;
      rmSync(dir, { recursive: true, force: true });
    });

    it("registers the write orientation trio, and the read server's names only standalone", () => {
      for (const t of ["dexe_write_context", "dexe_write_guide", "dexe_write_doctor"]) expect(s.registered.has(t), t).toBe(true);
      for (const t of ["dexe_context", "dexe_guide", "dexe_doctor"]) {
        expect(s.registered.has(t), t).toBe(mode === "standalone");
      }
    });

    it("the handshake", () => {
      expect(dangling(s.client.getInstructions() ?? "", s.registered)).toEqual([]);
    });

    it("every published description and schema description", async () => {
      const bad: string[] = [];
      for (const tool of (await s.client.listTools()).tools) {
        for (const text of [tool.description ?? "", ...strings(tool.inputSchema), ...strings(tool.outputSchema)]) {
          for (const d of dangling(text, s.registered)) bad.push(`${tool.name}: ${d}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("dexe_write_guide: the index and every flow plan, on both chains", async () => {
      const bad: string[] = [];
      const index = await s.call("dexe_write_guide");
      for (const d of dangling(index, s.registered)) bad.push(`index: ${d}`);
      for (const flow of FLOWS) {
        for (const chainId of [56, 97]) {
          const detail = JSON.parse(await s.call("dexe_write_guide", { flow: flow.id, chainId })) as {
            steps: Array<{ tool: string; providedBy?: string }>;
          };
          for (const step of detail.steps) for (const d of danglingStep(step, s.registered)) bad.push(`${flow.id}: ${d}`);
          // The prose: everything but the step `tool` fields checked above.
          const prose = { ...detail, steps: detail.steps.map(({ tool: _tool, ...rest }) => rest) };
          for (const text of strings(prose)) for (const d of dangling(text, s.registered)) bad.push(`${flow.id}@${chainId}: ${d}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("the next pointer after every step of every flow", () => {
      const bad: string[] = [];
      for (const flow of FLOWS) {
        for (const step of flow.steps) {
          for (const p of nextAfter(flow.id, step.id)?.next ?? []) {
            for (const d of danglingStep(p, s.registered)) bad.push(`${flow.id}.${step.id}: ${d}`);
            for (const text of strings({ when: p.when, why: p.why, params: p.params, note: p.paramsNote })) {
              for (const d of dangling(text, s.registered)) bad.push(`${flow.id}.${step.id}: ${d}`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });

    it("every known-failure remedy this server classifies with", () => {
      const bad: string[] = [];
      for (const f of writeKnownFailures()) {
        for (const d of dangling(`${f.what} ${f.remedy}`, s.registered)) bad.push(`${f.slug}: ${d}`);
      }
      expect(bad).toEqual([]);
    });

    it("every dexe-flow-* prompt", async () => {
      const bad: string[] = [];
      const { prompts } = await s.client.listPrompts();
      expect(prompts.length).toBe(FLOWS.length);
      for (const p of prompts) {
        const got = await s.client.getPrompt({ name: p.name });
        for (const text of strings(got.messages)) for (const d of dangling(text, s.registered)) bad.push(`${p.name}: ${d}`);
      }
      expect(bad).toEqual([]);
    });

    it("every dexe:// resource this server serves", async () => {
      // The docs also explain the deprecated aliases (now standalone-only) by
      // name; a mention is not a promise of the tool, so those are allowed.
      const allowed = new Set([...s.registered, ...Object.keys(DEPRECATED_ALIASES)]);
      const bad: string[] = [];
      const { resources } = await s.client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual(
        mode === "standalone"
          ? ["dexe://graph-schema", "dexe://playbook", "dexe://tools"]
          : ["dexe://playbook", "dexe://tools"],
      );
      for (const r of resources) {
        const got = await s.client.readResource({ uri: r.uri });
        for (const c of got.contents) {
          const text = "text" in c ? String(c.text) : "";
          for (const d of dangling(text, allowed)) bad.push(`${r.uri}: ${d}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("dexe_write_doctor and dexe_write_context", async () => {
      const doctor = await s.call("dexe_write_doctor");
      const context = await s.call("dexe_write_context", { includeDepositedPower: false, includeAgentBalances: false });
      expect(dangling(doctor, s.registered)).toEqual([]);
      expect(dangling(context, s.registered)).toEqual([]);
    });
  });
}

describe("the mark matcher", () => {
  it("accepts a direct mark, a shared trailing mark, and a backticked name", () => {
    const regs = new Set<string>();
    expect(dangling("check dexe_proposal_state (read server) first", regs)).toEqual([]);
    expect(dangling("dexe_proposal_list / dexe_read_settings / dexe_dao_info (read server) need no indexer", regs)).toEqual([]);
    expect(dangling("approve the GovUserKeeper (`dexe_dao_info` (read server))", regs)).toEqual([]);
  });

  it("rejects a bare read tool, a mark across a sentence, and a mark on a write tool", () => {
    const regs = new Set<string>();
    expect(dangling("check dexe_proposal_state first", regs)).toHaveLength(1);
    expect(dangling("read dexe_dao_info. Then dexe_read_settings (read server)", regs)).toHaveLength(1);
    expect(dangling("call dexe_tx_send (read server)", regs)).toHaveLength(1);
  });
});
