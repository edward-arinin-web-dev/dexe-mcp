import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { bestMatch, matchIntent, flowDetail, flowIndex, topicIndex } from "../../src/knowledge/index.js";
import { TOOLSETS, defaultProfileToolNames } from "../../src/tools/gate.js";

/**
 * 0.32.0 ships real multi-agent orchestration. The keyring, `signerKey` and the
 * agent ledger have existed (or exist now) as MECHANISM — but a capability
 * nobody can discover does not exist. Before this release, "run agents",
 * "swarm", "simulate a DAO" and "agents vote against each other" matched nothing
 * in dexe_guide, no doc described the safety model, and no skill carried the
 * sequence, so the least-exercised path in the product was also the least
 * documented one.
 *
 * These are the phrasings a user actually types, verbatim.
 */
const AGENT_PHRASINGS = [
  "run agents",
  "run agents against my dao",
  "multi-agent",
  "multi agent test of my dao",
  "swarm",
  "run a swarm against my dao",
  "simulate a dao",
  "dao simulation",
  "simulate governance with several wallets",
  "agents vote against each other",
  "i want agents that vote against each other",
  "test my dao with bots",
  "spin up an agent team",
  "use the agent keyring personas",
];

const root = resolve(__dirname, "..", "..");

describe("agent-team intent routing", () => {
  it.each(AGENT_PHRASINGS)("'%s' → agent_team", (phrase) => {
    expect(bestMatch(phrase)).toBe("agent_team");
  });

  it("does NOT steal the single-DAO write flows", () => {
    expect(bestMatch("please create a dao for my community")).toBe("create_dao");
    expect(bestMatch("vote on proposal 3 and execute it")).toBe("vote_execute");
  });

  it("does NOT steal the read / reporting phrasings", () => {
    expect(bestMatch("how do I query the subgraph for dao analytics")).toBe("read_dao_data");
    expect(bestMatch("give me a report on my dao")).toBe("report_dao_activity");
    expect(bestMatch("who voted on proposal 3")).toBe("report_dao_activity");
    expect(bestMatch("monitor my dao")).toBe("report_dao_activity");
  });

  it("still answers with the menu when nothing matches", () => {
    expect(bestMatch("do something with my tokens")).toBeNull();
  });

  it("'agents vote against each other' beats the vote flow it shares words with", () => {
    // "vote against" is a vote_execute trigger and matches this text verbatim,
    // so the multi-word agent forms have to carry enough weight to win outright
    // — otherwise the confident answer is the WRONG single-wallet flow.
    const m = matchIntent("agents vote against each other");
    expect(m[0]!.flow).toBe("agent_team");
    expect(m[0]!.score).toBeGreaterThanOrEqual(m[1]!.score * 2);
  });

  it("appears in the guide index next to the other flows", () => {
    const entry = flowIndex().find((f) => f.flow === "agent_team");
    expect(entry, "agent_team missing from the guide index").toBeDefined();
    expect(entry!.triggers).toContain("swarm");
    expect(entry!.summary).toMatch(/persona/i);
  });
});

describe("agent_team flow content", () => {
  const flow = flowDetail("agent_team", { chainId: 97 })!;
  const allText = [
    ...flow.steps.map((s) => `${s.purpose} ${s.reportOnSuccess}`),
    ...flow.interview.map((p) => `${p.ask} ${p.riskIfUnusual ?? ""} ${p.constraint ?? ""}`),
  ].join("\n");

  it("resolves as a FLOW (interview + step journey), not a reference topic", () => {
    expect(flow).not.toBeNull();
    expect(flow.interview.length).toBeGreaterThanOrEqual(5);
    expect(flow.steps.length).toBeGreaterThanOrEqual(6);
    expect(flow.agentProtocol).toMatch(/confirmation BEFORE any broadcast/);
    expect(topicIndex().some((t) => t.topic === "agent_team")).toBe(false);
  });

  it("covers the four roles the harness proves work on-chain", () => {
    for (const role of ["proposer", "voter", "delegat", "validator"]) {
      expect(allText.toLowerCase(), `no coverage of the ${role} role`).toContain(role);
    }
  });

  it("teaches per-persona signing via signerKey on every acting step", () => {
    const signing = flow.steps.filter((s) => JSON.stringify(s.paramsTemplate).includes("signerKey"));
    expect(signing.map((s) => s.id)).toEqual(
      expect.arrayContaining(["broadcast_as", "propose", "vote_round"]),
    );
  });

  it("routes builder payloads through dexe_tx_send — builders never broadcast", () => {
    const build = flow.steps.find((s) => s.id === "delegate_build")!;
    const send = flow.steps.find((s) => s.id === "broadcast_as")!;
    expect(build.tool).toBe("dexe_vote_build_delegate");
    expect(send.tool).toBe("dexe_tx_send");
    expect(build.next?.some((n) => n.stepId === "broadcast_as")).toBe(true);
    expect(`${build.reportOnSuccess} ${send.purpose}`).toMatch(/never broadcast|verbatim/i);
  });

  it("warns that a mid-round autoExecute collapses a contested vote", () => {
    const vote = flow.steps.find((s) => s.id === "vote_round")!;
    expect(vote.paramsTemplate.autoExecute).toBe("false");
    expect(vote.purpose).toMatch(/autoExecute:false for every persona but the last/i);
    expect(vote.paramsTemplate.isVoteFor).toMatch(/false/);
  });

  it("keeps funding inside a cap and a budget, and says so in the interview", () => {
    const gas = flow.interview.find((p) => p.name === "gasPerAgent")!;
    const budget = flow.interview.find((p) => p.name === "dailyBudget")!;
    expect(gas.riskIfUnusual).toMatch(/DEXE_AGENT_FUND_MAX_WEI/);
    expect(budget.ask).toMatch(/SWARM_DAILY_BNB_BUDGET/);
    expect(budget.riskIfUnusual).toMatch(/refused/i);
  });

  it("names the throwaway-DAO risk before the first broadcast", () => {
    const dao = flow.interview.find((p) => p.name === "govPool")!;
    expect(dao.riskIfUnusual).toMatch(/pass real proposals/i);
  });

  it("teaches reconciliation from BOTH the ledger and the chain", () => {
    // Spend is not the same question as "did the proposal pass", so the flow
    // ends with both: per-persona attribution, then the on-chain outcome.
    const ledger = flow.steps.find((s) => s.id === "reconcile")!;
    expect(ledger.tool).toBe("dexe_agents_ledger");
    expect(ledger.purpose).toMatch(/spend/i);
    expect(ledger.purpose).toMatch(/confirmed\/reverted\/failed/);
    expect(ledger.reportOnSuccess).toMatch(/signerKey/);

    const outcome = flow.steps.find((s) => s.id === "verify_outcome")!;
    expect(outcome.tool).toBe("dexe_dao_report");
    // Turnout is subgraph-backed; on 97 it is simply not there.
    expect(outcome.purpose).toMatch(/mainnet only/i);
    // vp-locked as an instruction: unlock before the next round.
    expect(outcome.reportOnSuccess).toMatch(/withdraw/i);
  });

  it("annotates every non-default step tool with a toolset that really contains it", () => {
    // An agent told to call a tool the session does not have spends a turn on a
    // confident 404 — and the keyring tools are the ones this flow depends on.
    const defaults = defaultProfileToolNames();
    for (const step of flow.steps) {
      if (defaults.has(step.tool)) {
        expect(step.requiresToolset, `${step.id} is default-visible; the annotation is noise`).toBeUndefined();
        continue;
      }
      expect(step.requiresToolset, `${step.id} (${step.tool}) needs a toolset annotation`).toBeDefined();
      const unlocked = step.requiresToolset!.split("|").some((set) => TOOLSETS[set]?.has(step.tool));
      expect(unlocked, `${step.id}: '${step.requiresToolset}' does not contain ${step.tool}`).toBe(true);
    }
    expect(flow.steps.find((s) => s.id === "roster")!.tool).toBe("dexe_agents_list");
    expect(flow.steps.find((s) => s.id === "fund")!.tool).toBe("dexe_agents_fund");
    expect(defaults.has("dexe_agents_list")).toBe(false);
  });

  it("chain notes: 97 is the rehearsal, 56 states the unattended-hot-key risk", () => {
    expect(flow.chainNote?.chainId).toBe(97);
    expect(flow.chainNote?.note).toMatch(/rehearse/i);
    const mainnet = flowDetail("agent_team", { chainId: 56 })!;
    expect(mainnet.chainNote?.note).toMatch(/hot key/i);
    expect(mainnet.chainNote?.note).toMatch(/real BNB unattended/i);
  });

  it("chains composites with flowContext and resolves gotchas danger-first", () => {
    const propose = flow.steps.find((s) => s.id === "propose")!;
    expect(propose.paramsTemplate.flowContext).toBe('{"flow":"agent_team","step":"propose"}');
    const rank = { danger: 0, warn: 1, info: 2 } as const;
    const all = [...flow.gotchas, ...flow.steps.flatMap((s) => s.gotchas)];
    expect(all.length).toBeGreaterThan(0);
    for (let i = 1; i < flow.gotchas.length; i++) {
      expect(rank[flow.gotchas[i - 1]!.severity]).toBeLessThanOrEqual(rank[flow.gotchas[i]!.severity]);
    }
    expect(flow.gotchas.some((g) => g.id === "delegation-one-level")).toBe(true);
    expect(all.some((g) => g.id === "approve-userkeeper")).toBe(true);
  });

  it("stays inside the guide payload ceilings on BOTH chains", () => {
    for (const chainId of [56, 97]) {
      const bytes = Buffer.byteLength(JSON.stringify(flowDetail("agent_team", { chainId })), "utf8");
      expect(bytes, `agent_team detail on chain ${chainId} is ${bytes} bytes`).toBeLessThan(10240);
    }
    expect(Buffer.byteLength(JSON.stringify(flowIndex()), "utf8")).toBeLessThan(4096);
    expect(
      Buffer.byteLength(JSON.stringify({ flows: flowIndex(), topics: topicIndex() }), "utf8"),
    ).toBeLessThan(6144);
  });
});

describe("docs/AGENTS.md", () => {
  const path = resolve(root, "docs", "AGENTS.md");
  const doc = existsSync(path) ? readFileSync(path, "utf8") : "";

  it("exists and ships (package.json files covers docs/)", () => {
    expect(existsSync(path), "docs/AGENTS.md missing").toBe(true);
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { files: string[] };
    const shipped = pkg.files.some(
      (e) => "docs/AGENTS.md" === e || "docs/AGENTS.md".startsWith(e.replace(/\/$/, "") + "/"),
    );
    expect(shipped, 'docs/AGENTS.md not covered by package.json "files"').toBe(true);
  });

  it("states the hot-key risk without softening it", () => {
    expect(doc).toMatch(/plaintext/i);
    expect(doc).toMatch(/sign without asking|signs without asking/i);
    expect(doc).toMatch(/burner wallets/i);
  });

  it("separates guards that ENFORCE from advisories that do not", () => {
    expect(doc).toMatch(/enforce/i);
    expect(doc).toMatch(/advis/i);
    // The honest half: an unset opt-in guard is no guard at all.
    expect(doc).toMatch(/unset is \*no\* guard|unset = no guard|not a lenient guard/i);
    for (const env of [
      "DEXE_SIGNER_ALLOWLIST",
      "DEXE_SIGNER_MAX_VALUE_WEI",
      "DEXE_SIGNER_MAX_BROADCASTS_PER_MIN",
      "DEXE_AGENT_FUND_MAX_WEI",
      "SWARM_DAILY_BNB_BUDGET",
    ]) {
      expect(doc, `docs/AGENTS.md must document ${env}`).toContain(env);
    }
  });

  it("gives the standing advice: throwaway wallets, testnet 97 first, disposable DAO", () => {
    expect(doc).toMatch(/chain 97|BSC testnet \(chain 97\)/);
    expect(doc).toMatch(/afford to lose/i);
  });

  it("documents the ledger fields a reconciliation actually needs", () => {
    for (const field of ["signerKey", "txHash", "outcome", "valueWei", "gasWei"]) {
      expect(doc, `ledger field ${field} undocumented`).toContain(field);
    }
    expect(doc).toMatch(/agent-ledger\.json/);
    expect(doc).toMatch(/DEXE_AGENT_LEDGER_PATH/);
  });

  it("carries the paste-able sequence and the signerKey split", () => {
    expect(doc).toMatch(/dexe_agents_list/);
    expect(doc).toMatch(/dexe_agents_fund/);
    expect(doc).toMatch(/dexe_proposal_vote_and_execute/);
    expect(doc).toMatch(/dexe_tx_send/);
    // Builders return unsigned payloads — the single most load-bearing fact.
    expect(doc).toMatch(/never broadcast/i);
    expect(doc).toMatch(/autoExecute: false|autoExecute:false/);
  });

  it("says which toolset the keyring tools live in", () => {
    expect(doc).toMatch(/DEXE_TOOLSETS=core,agents/);
    expect(doc).toMatch(/dexe_agents_ledger/);
  });

  it("documents the funding preview→confirm gate", () => {
    expect(doc).toMatch(/confirm: true/);
    expect(doc).toMatch(/[Pp]review/);
  });

  it("names only tools that are really registered", () => {
    const all = new Set<string>();
    for (const names of Object.values(TOOLSETS)) for (const n of names) all.add(n);
    // A doc that sends the reader to a tool nobody registers is worse than
    // silence: they spend a turn on a 404 and then improvise.
    const referenced = [...new Set(doc.match(/dexe_[a-z0-9_]+/g) ?? [])].filter((n) => !n.endsWith("_"));
    const orphans = referenced.filter((n) => !all.has(n));
    expect(orphans, `docs/AGENTS.md references unregistered tools: ${orphans.join(", ")}`).toEqual([]);
  });
});

describe("dexe-agent-team skill", () => {
  const path = resolve(root, "dexe-plugin", "skills", "dexe-agent-team", "SKILL.md");
  // Normalize CRLF — the same trap tests/knowledge/reporting-discoverability.test.ts
  // hit one release earlier. This repo is developed on Windows with
  // core.autocrlf=true: a freshly written file has \n and the literal assertion
  // below passes, then the first checkout turns it into \r\n and the test fails
  // having changed nothing. A test that only holds before its file round-trips
  // through git teaches you to distrust the suite.
  const skill = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";

  it("exists with the same frontmatter shape as the other shipped skills", () => {
    expect(existsSync(path), "dexe-plugin/skills/dexe-agent-team/SKILL.md missing").toBe(true);
    expect(skill.startsWith("---\nname: dexe-agent-team\ndescription: |\n")).toBe(true);
    expect(skill.indexOf("\n---\n", 3), "frontmatter is not terminated").toBeGreaterThan(0);
  });

  it("its description carries the trigger words a user actually says", () => {
    const frontmatter = skill.slice(0, skill.indexOf("\n---\n", 3)).toLowerCase();
    for (const word of ["run agents", "multi-agent", "swarm", "agent team", "simulate a dao", "bots"]) {
      expect(frontmatter, `skill description must mention '${word}'`).toContain(word);
    }
  });

  it("leads with the safety model, not the recipe", () => {
    const head = skill.slice(0, skill.indexOf("## 1."));
    expect(head).toMatch(/plaintext/i);
    expect(head).toMatch(/burner wallets/i);
    expect(head).toMatch(/enforce/i);
    expect(head).toMatch(/advis/i);
  });

  it("teaches the sequence, the signerKey split and the ledger", () => {
    expect(skill).toMatch(/dexe_agents_list/);
    expect(skill).toMatch(/signerKey/);
    expect(skill).toMatch(/autoExecute:false/);
    expect(skill).toMatch(/dexe_agents_ledger/);
    expect(skill).toMatch(/agent-ledger\.json/);
    expect(skill).toMatch(/dexe_guide \{flow:"agent_team"\}/);
    expect(skill).toMatch(/DEXE_TOOLSETS=core,agents/);
    expect(skill).toMatch(/"confirm": true/);
  });

  it("names only tools that are really registered", () => {
    const all = new Set<string>();
    for (const names of Object.values(TOOLSETS)) for (const n of names) all.add(n);
    all.add("dexe_guide");
    const referenced = [...new Set(skill.match(/dexe_[a-z0-9_]+/g) ?? [])].filter(
      (n) => !n.endsWith("_"),
    );
    const orphans = referenced.filter((n) => !all.has(n));
    expect(orphans, `skill references unregistered tools: ${orphans.join(", ")}`).toEqual([]);
  });
});

describe("dexe_guide serves the agent flow (real server, default profile)", () => {
  let client: Client;
  let server: McpServer;
  let stateDir: string;

  async function callGuide(args: Record<string, unknown>) {
    const res = await client.callTool({ name: "dexe_guide", arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    return JSON.parse(text) as Record<string, any>;
  }

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "dexe-agent-guide-"));
    const statePath = join(stateDir, "state.json");
    writeFileSync(statePath, JSON.stringify({ version: 1, knownDaos: [], recentProposals: [], walletLabels: {} }));
    process.env.DEXE_STATE_PATH = statePath;
    delete process.env.DEXE_TOOLSETS;
    const config = await loadConfig();
    server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerAll(server, config);
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    delete process.env.DEXE_STATE_PATH;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each([
    "run agents on my dao",
    "i want a swarm that votes",
    "simulate a dao with several wallets",
    "agents vote against each other",
    "test my dao with bots",
  ])("intent '%s' → flow-detail agent_team", async (intent) => {
    const out = await callGuide({ intent });
    expect(out.mode).toBe("flow-detail");
    expect(out.flow).toBe("agent_team");
    expect(out.agentProtocol).toMatch(/interview/);
  });

  it("flow:agent_team → the full plan with the toolset annotation the session needs", async () => {
    const out = await callGuide({ flow: "agent_team", chainId: 97 });
    expect(out.mode).toBe("flow-detail");
    const roster = out.steps.find((s: any) => s.id === "roster");
    expect(roster.tool).toBe("dexe_agents_list");
    // Default profile does NOT carry the keyring tools, so the plan must say so.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("dexe_agents_list");
    expect(roster.requiresToolset).toContain("vote");
  });

  it("an MCP prompt is registered for the flow, like every other flow", async () => {
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("dexe-flow-agent_team");
    const got = await client.getPrompt({ name: "dexe-flow-agent_team", arguments: {} });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/signerKey/);
    expect(text).toMatch(/SWARM_DAILY_BNB_BUDGET/);
  });
});

describe("the keyring tools the flow points at are reachable with core,agents,vote", () => {
  it("registers every tool the agent_team flow calls", async () => {
    const previous = process.env.DEXE_TOOLSETS;
    process.env.DEXE_TOOLSETS = "core,agents,vote";
    try {
      const config = await loadConfig();
      const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
      registerAll(server, config);
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      const names = new Set((await client.listTools()).tools.map((t) => t.name));
      await client.close();
      await server.close();
      // Every step of the plan must be callable in this profile — the flow is
      // only useful if the session it recommends can actually run it.
      const stepTools = [...new Set(flowDetail("agent_team")!.steps.map((s) => s.tool))];
      const missing = stepTools.filter((t) => !names.has(t));
      expect(missing, `agent_team steps unreachable under core,agents,vote: ${missing.join(", ")}`).toEqual([]);
      expect(names.has("dexe_agents_ledger")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DEXE_TOOLSETS;
      else process.env.DEXE_TOOLSETS = previous;
    }
  });
});
