/**
 * Swarm orchestrator — Phase 0 skeleton.
 *
 * Loads scenario JSON, validates env + DAO/token allowlists, resolves agent
 * wallets, iterates steps, and writes a JSONL state log + Markdown report.
 *
 * Phase 0 ONLY runs in `--dry-run` mode end-to-end. Real broadcast paths are
 * stubbed to "would-call" entries until Phase 1 wires real MCP tool dispatch.
 *
 * Usage:
 *   tsx scripts/swarm/orchestrator.ts --scenarios=S00-reset,S01-delegation-chain-3hop --dry-run
 *   tsx scripts/swarm/orchestrator.ts --scenarios=S01-delegation-chain-3hop --concurrency=1
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";

process.loadEnvFile?.();

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface AgentSpec {
  alias: string;
  role: string;
  wallet: string;
}

interface StepSpec {
  step: number;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  broadcast: boolean;
  captureAs?: string;
  skipIf?: string;
  comment?: string;
}

interface SuccessCriterion {
  id: string;
  check: string;
}

interface ScenarioSpec {
  id: string;
  title: string;
  priority: number;
  dao: string;
  dependsOn: string[];
  requiresBrowser: boolean;
  /** Chain ids this scenario can run on. Default = both 56 + 97. */
  requiresChain?: number[];
  agents: AgentSpec[];
  steps: StepSpec[];
  successCriteria: SuccessCriterion[];
  notes?: string;
  loop?: { over: string[]; appliesToSteps: number[]; comment?: string };
}

interface CliArgs {
  scenarios: string[];
  concurrency: number;
  dryRun: boolean;
  autoFix: boolean;
  skipReset: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (k: string) => {
    const m = argv.find((a) => a.startsWith(`--${k}=`));
    return m ? m.slice(k.length + 3) : undefined;
  };
  const flag = (k: string) => argv.includes(`--${k}`);
  return {
    scenarios:
      (get("scenarios") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    concurrency: Number(get("concurrency") ?? "1"),
    dryRun: flag("dry-run"),
    autoFix: flag("auto-fix"),
    skipReset: flag("skip-reset"),
  };
}

function fail(msg: string): never {
  console.error(`${RED}orchestrator: ${msg}${RESET}`);
  process.exit(1);
}

function parseList(key: string): string[] {
  return (process.env[key]?.trim() ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadScenarios(ids: string[]): ScenarioSpec[] {
  const dir = resolve("tests/swarm/scenarios");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  const all = new Map<string, ScenarioSpec>();
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(dir, f), "utf8")) as ScenarioSpec;
    if (spec.id !== f.replace(/\.json$/, "")) {
      fail(`scenario id '${spec.id}' must match filename '${f}'`);
    }
    all.set(spec.id, spec);
  }
  if (ids.length === 0) return [...all.values()];
  return ids.map((id) => {
    const s = all.get(id);
    if (!s) fail(`Unknown scenario: ${id}`);
    return s;
  });
}

function topoSort(scenarios: ScenarioSpec[]): ScenarioSpec[] {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const out: ScenarioSpec[] = [];
  const visit = (s: ScenarioSpec, stack: Set<string>) => {
    if (visited.has(s.id)) return;
    if (stack.has(s.id)) fail(`Cyclic dependsOn at ${s.id}`);
    stack.add(s.id);
    for (const dep of s.dependsOn ?? []) {
      const d = byId.get(dep);
      if (!d) {
        // Dependency not in this run — fine, treat as best-effort prereq.
        continue;
      }
      visit(d, stack);
    }
    stack.delete(s.id);
    visited.add(s.id);
    out.push(s);
  };
  for (const s of scenarios) visit(s, new Set());
  return out;
}

function resolveWallets(spec: ScenarioSpec): Map<string, { address: string; envKey: string }> {
  const map = new Map<string, { address: string; envKey: string }>();
  for (const a of spec.agents) {
    const pk = process.env[a.wallet]?.trim();
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      fail(`Scenario ${spec.id}: wallet env ${a.wallet} (alias ${a.alias}) is missing or malformed.`);
    }
    map.set(a.alias, { address: new Wallet(pk).address, envKey: a.wallet });
  }
  return map;
}

function checkAllowlists(spec: ScenarioSpec, chainTag: string) {
  const daos = parseList(`SWARM_DAOS_${chainTag}`);
  if (daos.length === 0) fail(`SWARM_DAOS_${chainTag} allowlist empty.`);
  if (spec.dao === "{{firstAllowlistedDao}}") {
    spec.dao = daos[0];
  }
  const lower = daos.map((a) => a.toLowerCase());
  if (spec.dao && !lower.includes(spec.dao.toLowerCase())) {
    fail(`Scenario ${spec.id} DAO ${spec.dao} not in SWARM_DAOS_${chainTag} allowlist.`);
  }
}

interface StepLog {
  ts: string;
  scenarioId: string;
  stepId: number;
  agent: string;
  tool: string;
  status: "pass" | "fail" | "skipped" | "would-call";
  args: Record<string, unknown>;
  captured?: unknown;
  txHash?: string;
  error?: string;
}

async function runScenario(
  spec: ScenarioSpec,
  args: CliArgs,
  stateFile: string,
  chainId: number,
  chainTag: string,
): Promise<{ id: string; pass: boolean; steps: StepLog[] }> {
  const allowedChains = spec.requiresChain ?? [56, 97];
  if (!allowedChains.includes(chainId)) {
    console.log(`${DIM}─${RESET} ${spec.id}  ${DIM}skipped (requires chain ${allowedChains.join("/")}, current ${chainId})${RESET}`);
    return { id: spec.id, pass: true, steps: [] };
  }
  console.log(`${DIM}─${RESET} ${spec.id}  ${spec.title}`);
  checkAllowlists(spec, chainTag);
  const wallets = resolveWallets(spec);
  for (const [alias, w] of wallets) {
    console.log(`    ${alias}=${w.envKey} ${w.address}`);
  }

  const steps: StepLog[] = [];
  for (const step of spec.steps) {
    const log: StepLog = {
      ts: new Date().toISOString(),
      scenarioId: spec.id,
      stepId: step.step,
      agent: step.agent,
      tool: step.tool,
      args: step.args,
      status: args.dryRun || !step.broadcast ? "would-call" : "skipped",
    };
    if (args.dryRun) {
      console.log(
        `    ${YELLOW}~${RESET} step ${step.step} ${step.agent} → ${step.tool}  ${DIM}(dry-run)${RESET}`,
      );
    } else {
      // Phase 0: real-broadcast path is intentionally a stub. Phase 1 wires
      // real MCP tool dispatch via a child Claude Code subagent or direct
      // library import.
      console.log(
        `    ${RED}!${RESET} step ${step.step} ${step.agent} → ${step.tool}  ${RED}(real broadcast not wired in Phase 0)${RESET}`,
      );
      log.status = "skipped";
      log.error = "Phase 0: broadcast dispatch not implemented; re-run with --dry-run.";
    }
    appendFileSync(stateFile, JSON.stringify(log) + "\n");
    steps.push(log);
  }

  const allOk = steps.every((s) => s.status === "would-call" || s.status === "pass" || s.status === "skipped");
  return { id: spec.id, pass: allOk, steps };
}

function writeReport(
  runId: string,
  results: Array<{ id: string; pass: boolean; steps: StepLog[] }>,
  scenarios: Map<string, ScenarioSpec>,
  args: CliArgs,
) {
  const reportDir = resolve(`tests/reports/swarm/${runId}`);
  mkdirSync(reportDir, { recursive: true });
  const totalPass = results.filter((r) => r.pass).length;
  const lines: string[] = [];
  lines.push(`# Swarm Run \`${runId}\``);
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Mode:** ${args.dryRun ? "dry-run" : "broadcast"}`);
  lines.push(`**Network:** BSC mainnet (chain 56)`);
  lines.push(`**Scenarios:** ${results.length} total | ${totalPass} pass | ${results.length - totalPass} fail`);
  lines.push("");
  lines.push("| Scenario | Title | Result | Steps |");
  lines.push("|---|---|---|---|");
  for (const r of results) {
    const s = scenarios.get(r.id)!;
    const verdict = r.pass ? "✅ pass" : "❌ fail";
    lines.push(`| ${r.id} | ${s.title} | ${verdict} | ${r.steps.length} |`);
  }
  lines.push("");
  for (const r of results) {
    const s = scenarios.get(r.id)!;
    lines.push(`## ${r.id}`);
    lines.push("");
    lines.push(`> ${s.title}`);
    lines.push("");
    for (const step of r.steps) {
      const icon = step.status === "would-call" ? "~" : step.status === "pass" ? "✓" : step.status === "skipped" ? "·" : "✗";
      lines.push(`- ${icon} step ${step.stepId} \`${step.tool}\` (${step.agent}) — **${step.status}**${step.error ? ` — ${step.error}` : ""}`);
    }
    lines.push("");
  }
  writeFileSync(join(reportDir, "run.md"), lines.join("\n"));
  console.log(`${GREEN}Report:${RESET} ${join(reportDir, "run.md")}`);
}

async function main() {
  const args = parseArgs();

  const expectedChainId = Number(
    (process.env.SWARM_CHAIN_ID ?? process.env.DEXE_CHAIN_ID ?? "56").trim(),
  );
  const chainTag = expectedChainId === 56 ? "MAINNET" : expectedChainId === 97 ? "TESTNET" : null;
  if (!chainTag) fail(`Unsupported SWARM_CHAIN_ID=${expectedChainId}.`);

  const rpcUrl = (
    process.env[`SWARM_RPC_URL_${chainTag}`] ??
    process.env.SWARM_RPC_URL ??
    process.env.DEXE_RPC_URL ??
    ""
  ).trim();
  if (!rpcUrl) fail(`Set SWARM_RPC_URL_${chainTag} or SWARM_RPC_URL or DEXE_RPC_URL.`);
  const provider = new JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== expectedChainId) {
    fail(`RPC chainId ${net.chainId} != expected ${expectedChainId}`);
  }
  console.log(`${GREEN}✓${RESET} RPC ${rpcUrl} → chain ${net.chainId} (${chainTag})`);

  const scenarios = loadScenarios(args.scenarios);
  let active = scenarios;
  if (args.skipReset) active = active.filter((s) => s.id !== "S00-reset");
  const sorted = topoSort(active);
  const byId = new Map(sorted.map((s) => [s.id, s]));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const stateFile = resolve(`tests/swarm/state/${runId}.jsonl`);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, "");

  console.log(`${DIM}Run id:${RESET} ${runId}`);
  console.log(`${DIM}State:${RESET}  ${stateFile}`);
  console.log(`${DIM}Mode:${RESET}   ${args.dryRun ? "dry-run" : "BROADCAST"}`);
  console.log(`${DIM}Plan:${RESET}   ${sorted.map((s) => s.id).join(" → ")}`);

  // Phase 0 runs serially regardless of --concurrency. Wallet semaphore +
  // parallel batches arrive in Phase 1.
  if (args.concurrency > 1) {
    console.log(`${YELLOW}Phase 0: --concurrency=${args.concurrency} ignored, running serially.${RESET}`);
  }

  const results: Array<{ id: string; pass: boolean; steps: StepLog[] }> = [];
  for (const spec of sorted) {
    results.push(await runScenario(spec, args, stateFile, expectedChainId, chainTag));
  }

  writeReport(runId, results, byId, args);

  const failed = results.filter((r) => !r.pass).length;
  if (failed > 0) {
    console.log(`${RED}${failed}/${results.length} scenario(s) failed.${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}All ${results.length} scenario(s) ok.${RESET}`);
}

main().catch((err) => {
  console.error(`${RED}orchestrator crashed:${RESET}`, err);
  process.exit(2);
});
