import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { bestMatch, matchIntent, topicDetail, topicIndex } from "../../src/knowledge/index.js";
import { TOOLSETS, defaultProfileToolNames } from "../../src/tools/gate.js";

/**
 * The 0.31.0 promise is that a user can ASK for a report in their own words.
 * Before this release "report", "stats", "activity", "who voted", "how is the
 * DAO doing", "weekly digest" and "monitor" matched nothing at all — dexe_guide
 * answered every one of them with the flow menu, which is the same as saying
 * "the capability isn't here". These are the phrasings, verbatim.
 */
const REPORTING_PHRASINGS = [
  "give me a report on my dao",
  "dao report for 0x2546f0000000000000000000000000000000935916",
  "show me the stats",
  "what is the activity in this dao",
  "who voted on proposal 3",
  "how is the dao doing",
  "set up a weekly report for my dao",
  "set up a weekly digest for my dao",
  "monitor my dao",
  "i want to periodically pull a complex report about a dao",
  "turnout for the last proposals",
  "health check on the dao",
  "watch the dao for proposals that need my vote",
];

const root = resolve(__dirname, "..", "..");

describe("reporting intent routing", () => {
  it.each(REPORTING_PHRASINGS)("'%s' → report_dao_activity", (phrase) => {
    expect(bestMatch(phrase)).toBe("report_dao_activity");
  });

  it("does NOT steal the read_dao_data phrasings (subgraph/how-do-I questions)", () => {
    expect(bestMatch("how do I query the subgraph for dao analytics")).toBe("read_dao_data");
    expect(bestMatch("show me the token holders and protocol stats")).toBe("read_dao_data");
  });

  it("does NOT steal the write flows", () => {
    expect(bestMatch("please create a dao for my community")).toBe("create_dao");
    expect(bestMatch("vote on proposal 3 and execute it")).toBe("vote_execute");
  });

  it("still answers with the menu when nothing matches", () => {
    expect(bestMatch("do something with my tokens")).toBeNull();
  });

  it("a verbatim phrase beats a bag-of-words coincidence ('who voted' vs the vote flow)", () => {
    // The 2x-ratio rule alone called this 3-vs-2 a tie and served the menu.
    const m = matchIntent("who voted on proposal 3");
    const top = m[0]!;
    const runnerUp = m[1]!;
    expect(top.flow).toBe("report_dao_activity");
    expect(top.phraseHits).toBeGreaterThan(0);
    expect(runnerUp.phraseHits).toBe(0);
    expect(top.score).toBeLessThan(runnerUp.score * 2); // would have been null before
  });

  it("the reporting topic is in the index tier next to the flows", () => {
    const entry = topicIndex().find((t) => t.topic === "report_dao_activity");
    expect(entry, "report_dao_activity missing from the guide index").toBeDefined();
    expect(entry!.summary).toMatch(/dexe_dao_report/);
  });
});

describe("report_dao_activity topic content", () => {
  const topic = topicDetail("report_dao_activity")!;

  it("resolves", () => {
    expect(topic).not.toBeNull();
    expect(topic.sections.length).toBeGreaterThanOrEqual(5);
  });

  it("every documented tool is a registered tool", () => {
    const all = new Set<string>();
    for (const names of Object.values(TOOLSETS)) for (const n of names) all.add(n);
    const orphans = topic.tools.filter((t) => !all.has(t.tool)).map((t) => t.tool);
    expect(orphans, `topic references unregistered tools: ${orphans.join(", ")}`).toEqual([]);
  });

  it("names dexe_dao_report as default-visible and annotates the tools that still need a toolset", () => {
    const report = topic.tools.find((t) => t.tool === "dexe_dao_report")!;
    expect(report, "dexe_dao_report must be documented by the reporting topic").toBeDefined();
    // The whole point of the release: a fresh install can run this.
    expect(defaultProfileToolNames().has("dexe_dao_report")).toBe(true);
    expect(report.requiresToolset).toBeUndefined();
    const inbox = topic.tools.find((t) => t.tool === "dexe_user_inbox")!;
    expect(inbox.requiresToolset).toContain("read");
  });

  it("teaches the since diff, the first-run trap, and the scheduling commands", () => {
    const text = topic.sections.map((s) => s.text).join("\n");
    expect(text).toMatch(/since: "last"/);
    expect(text, "the first run has no baseline — a schedule that omits this reports an error").toMatch(
      /ERRORS when\s+no snapshot exists|first run/i,
    );
    expect(text).toMatch(/\/schedule/);
    expect(text).toMatch(/\/loop/);
  });

  it("states the chain coverage and the degrade-don't-lie rule", () => {
    const text = topic.sections.map((s) => s.text).join("\n");
    expect(text).toMatch(/BSC MAINNET \(56\) only/);
    expect(text).toMatch(/never as zero rows|unavailable/i);
    expect(topic.gotchas.some((g) => g.id === "subgraph-backend-mainnet-only")).toBe(true);
  });

  it("read_dao_data points at it, so a data question still finds the report", () => {
    const read = topicDetail("read_dao_data")!;
    const text = read.sections.map((s) => s.text).join("\n");
    expect(text).toMatch(/dexe_dao_report/);
    expect(text).toMatch(/report_dao_activity/);
  });

  it("read_dao_data's toolset-gating section describes the CURRENT default profile", () => {
    const read = topicDetail("read_dao_data")!;
    const gating = read.sections.find((s) => s.heading === "Toolset gating")!;
    // It used to claim the default was 'core,proposals' and that dexe_graph_query
    // needed the `read` set — both false since 0.31.0, and both were the exact
    // claim that made the "reads work zero-config" promise a lie.
    expect(gating.text).not.toMatch(/'core,proposals'/);
    expect(gating.text).toMatch(/dexe_graph_query/);
    const graphQuery = read.tools.find((t) => t.tool === "dexe_graph_query")!;
    expect(graphQuery.requiresToolset).toBeUndefined();
  });
});

describe("docs/REPORTING.md", () => {
  const path = resolve(root, "docs", "REPORTING.md");
  const doc = existsSync(path) ? readFileSync(path, "utf8") : "";

  it("exists and ships (package.json files covers docs/)", () => {
    expect(existsSync(path), "docs/REPORTING.md missing").toBe(true);
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { files: string[] };
    const shipped = pkg.files.some(
      (e) => "docs/REPORTING.md" === e || "docs/REPORTING.md".startsWith(e.replace(/\/$/, "") + "/"),
    );
    expect(shipped, 'docs/REPORTING.md not covered by package.json "files"').toBe(true);
  });

  it("carries literal, runnable /loop and /schedule invocations", () => {
    // Paste-able or it is not a recipe: the line must start with the command.
    const loops = [...doc.matchAll(/^\/loop \d+[mh] .+/gm)];
    expect(loops.length, "no verbatim '/loop <interval> …' line").toBeGreaterThanOrEqual(2);
    const schedules = [...doc.matchAll(/^\/schedule .+/gm)];
    expect(schedules.length, "no verbatim '/schedule …' line").toBeGreaterThanOrEqual(2);
    expect(doc).toMatch(/dexe_dao_report/);
  });

  it("covers the daily digest and the hourly needs-a-vote watch", () => {
    expect(doc).toMatch(/daily digest/i);
    expect(doc).toMatch(/hourly/i);
    expect(doc).toMatch(/sections:\["deadlines","proposals"\]/);
  });

  it("states chain coverage and what a scheduled run on an unindexed chain reports", () => {
    expect(doc).toMatch(/BSC mainnet \(56\) only/i);
    expect(doc).toMatch(/on-chain sections still render|on-chain sections/i);
    expect(doc).toMatch(/unavailable\[\]/);
  });

  it("surfaces the gotchas: first-run baseline, UTC cron floor, no local env in the cloud", () => {
    expect(doc).toMatch(/errors\*\* when no snapshot exists|First-run gotcha/i);
    expect(doc).toMatch(/minimum interval 1 hour/i);
    expect(doc).toMatch(/UTC/);
    expect(doc).toMatch(/no access to your machine/i);
  });
});

describe("dexe-report skill", () => {
  const path = resolve(root, "dexe-plugin", "skills", "dexe-report", "SKILL.md");
  // Normalize CRLF. The repo is developed on Windows with core.autocrlf=true, so
  // a checked-out file has \r\n while a freshly written one has \n — meaning a
  // literal "---\nname:" assertion passes when the file is created and fails
  // after the next checkout. Line endings are not what these tests are about.
  const skill = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";

  it("exists with the same frontmatter shape as the other shipped skills", () => {
    expect(existsSync(path), "dexe-plugin/skills/dexe-report/SKILL.md missing").toBe(true);
    expect(skill.startsWith("---\nname: dexe-report\ndescription: |\n")).toBe(true);
    const end = skill.indexOf("\n---\n", 3);
    expect(end, "frontmatter is not terminated").toBeGreaterThan(0);
  });

  it("its description carries the trigger words a user actually says", () => {
    const frontmatter = skill.slice(0, skill.indexOf("\n---\n", 3));
    for (const word of ["report", "stats", "activity", "who voted", "digest", "monitor"]) {
      expect(frontmatter.toLowerCase(), `skill description must mention '${word}'`).toContain(word);
    }
  });

  it("teaches the three things: the call, the since diff, and scheduling", () => {
    expect(skill).toMatch(/dexe_dao_report/);
    expect(skill).toMatch(/since: "last"/);
    expect(skill).toMatch(/^\/loop \d+[mh] /m);
    expect(skill).toMatch(/\/schedule/);
    expect(skill).toMatch(/minimum interval 1 hour/i);
  });

  it("warns about the mainnet-only sections and stays read-only", () => {
    expect(skill).toMatch(/BSC mainnet \(56\) only/i);
    expect(skill).toMatch(/read-only/i);
  });
});

describe("dexe_guide serves the reporting topic (real server, default profile)", () => {
  let client: Client;
  let server: McpServer;
  let stateDir: string;

  async function callGuide(args: Record<string, unknown>) {
    const res = await client.callTool({ name: "dexe_guide", arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    return JSON.parse(text) as Record<string, any>;
  }

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "dexe-report-guide-"));
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
    "set up a weekly report for my dao",
    "how is the dao doing",
    "who voted on the last proposals",
    "monitor my dao for anything that needs a vote",
  ])("intent '%s' → topic-detail report_dao_activity", async (intent) => {
    const out = await callGuide({ intent });
    expect(out.mode).toBe("topic-detail");
    expect(out.topic).toBe("report_dao_activity");
    // Reference material carries no interview / broadcast-confirmation framing.
    expect(out.agentProtocol).toBeUndefined();
  });

  it("flow:report_dao_activity → the full topic with tools and gotchas", async () => {
    const out = await callGuide({ flow: "report_dao_activity", chainId: 56 });
    expect(out.mode).toBe("topic-detail");
    expect(out.tools.map((t: any) => t.tool)).toContain("dexe_dao_report");
    expect(out.gotchas.length).toBeGreaterThan(0);
  });

  it("the tool it points at is actually callable in this default session", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("dexe_guide");
    expect(names, "the guide would be advertising a tool the default profile hides").toContain("dexe_dao_report");
  });
});
