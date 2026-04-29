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
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  if (spec.dao === "{{firstAllowlistedDao}}") spec.dao = daos[0];
  else if (spec.dao === "{{secondAllowlistedDao}}") {
    if (!daos[1]) fail(`Scenario ${spec.id} requires a second DAO; SWARM_DAOS_${chainTag} has only ${daos.length}.`);
    spec.dao = daos[1];
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
  iter?: string;
}

// ---- Phase 1 atom: real-dispatch + loop expansion -------------------------

const GOV_POOL_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function undelegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function withdraw(address receiver, uint256 amount, uint256[] nftIds)",
  "function deposit(uint256 amount, uint256[] nftIds) payable",
  "function delegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
] as const;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

const USER_KEEPER_ABI = [
  "function tokenBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
  "function nftBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
  "function delegations(address user, bool perNftPowerArray) view returns (uint256 power, tuple(address delegatee, uint256 delegatedTokens, uint256[] delegatedNfts, uint256 nftPower, uint256[] perNftPower)[] delegationsInfo)",
  "function getWithdrawableAssets(address voter, uint256[] lockedProposals, uint256[] unlockedNfts) view returns (uint256 withdrawableTokens, uint256[] withdrawableNfts)",
  "function maxLockedAmount(address voter) view returns (uint256)",
] as const;

const VOTE_TYPES = ["PersonalVote", "MicropoolVote", "DelegatedVote", "TreasuryVote"] as const;

interface DispatchCtx {
  provider: JsonRpcProvider;
  agentWallet: Wallet;
  spec: ScenarioSpec;
  chainTag: string;
}

type Dispatcher = (args: Record<string, unknown>, ctx: DispatchCtx) => Promise<unknown>;

const DISPATCHERS: Record<string, Dispatcher> = {
  async dexe_vote_user_power(args, { provider }) {
    const govPool = String(args.govPool);
    const user = String(args.user);
    const gp = new Contract(govPool, GOV_POOL_ABI as unknown as string[], provider);
    const helpers = await gp.getHelperContracts();
    const userKeeper = helpers[1] as string;
    const uk = new Contract(userKeeper, USER_KEEPER_ABI as unknown as string[], provider);
    const power: Record<string, { tokenBalance: string; tokenOwned: string; nftBalance: string; nftOwned: string }> = {};
    let totalBalance = 0n;
    for (let i = 0; i < VOTE_TYPES.length; i++) {
      const [bal, owned] = await uk.tokenBalance(user, i);
      const [nbal, nowned] = await uk.nftBalance(user, i);
      power[VOTE_TYPES[i]] = {
        tokenBalance: String(bal),
        tokenOwned: String(owned),
        nftBalance: String(nbal),
        nftOwned: String(nowned),
      };
      // Personal.tokenBalance includes wallet balance (per
      // bug_flow_deposited_power.md). Withdrawable = balance - ownedBalance.
      if (i === 0) totalBalance = bal - owned;
    }
    return { govPool, user, userKeeper, power, totalBalance: String(totalBalance) };
  },

  async dexe_read_delegation_map(args, { provider }) {
    const govPool = String(args.dao ?? args.govPool);
    const user = String(args.delegator ?? args.user ?? args.delegatee);
    if (!govPool || !user) return [];
    const gp = new Contract(govPool, GOV_POOL_ABI as unknown as string[], provider);
    const helpers = await gp.getHelperContracts();
    const uk = new Contract(helpers[1], USER_KEEPER_ABI as unknown as string[], provider);
    const [, info] = await uk.delegations(user, false);
    // Shape compatible with S00's outA.0.delegatee / outA.0.amount references.
    return (info as Array<{ delegatee: string; delegatedTokens: bigint; delegatedNfts: bigint[] }>).map((d) => ({
      delegatee: d.delegatee,
      amount: String(d.delegatedTokens),
      nftIds: d.delegatedNfts.map((n) => n.toString()),
    }));
  },

  async dexe_vote_build_undelegate(args) {
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("undelegate", [
      String(args.delegatee),
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data, value: "0" } };
  },

  async dexe_vote_build_withdraw(args) {
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("withdraw", [
      String(args.receiver),
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data, value: "0" } };
  },

  /** Computes withdrawable as (Personal.balance - Personal.owned) -
   * maxLockedAmount. Used by S00 reset where the prior step's powerA capture
   * goes stale after undelegate (delegated tokens flow back to Personal) and
   * `getWithdrawableAssets([],[])` ignores active proposal locks. Self-skips
   * when nothing is withdrawable. */
  async dexe_vote_build_withdraw_all(args, { provider }) {
    const govPool = String(args.govPool);
    const receiver = String(args.receiver);
    const gp = new Contract(govPool, GOV_POOL_ABI as unknown as string[], provider);
    const helpers = await gp.getHelperContracts();
    const uk = new Contract(helpers[1], USER_KEEPER_ABI as unknown as string[], provider);
    const [bal, owned] = await uk.tokenBalance(receiver, 0);
    const locked: bigint = await uk.maxLockedAmount(receiver);
    const deposited = bal - owned;
    const withdrawable = deposited > locked ? deposited - locked : 0n;
    if (withdrawable === 0n) {
      return {
        skipped: true,
        reason: `no withdrawable (deposited=${deposited} locked=${locked})`,
      };
    }
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("withdraw", [receiver, withdrawable, []]);
    return {
      payload: { to: govPool, data, value: "0" },
      withdrawableTokens: String(withdrawable),
      deposited: String(deposited),
      locked: String(locked),
    };
  },

  async dexe_vote_build_erc20_approve(args) {
    const iface = new Interface(ERC20_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("approve", [
      String(args.spender),
      String(args.amount),
    ]);
    return { payload: { to: String(args.token), data, value: "0" } };
  },

  async dexe_vote_build_deposit(args) {
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("deposit", [
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data, value: "0" } };
  },

  async dexe_vote_build_delegate(args) {
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("delegate", [
      String(args.delegatee),
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data, value: "0" } };
  },

  async dexe_vote_build_vote(args) {
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("vote", [
      String(args.proposalId),
      Boolean(args.isVoteFor),
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data, value: "0" } };
  },

  // Phase 1.5: route the IPFS-touching composite tools through dexe-mcp via
  // stdio. proposal_build_modify_dao_profile is a no-op marker; proposal_create
  // (proposalType=modify_dao_profile) does IPFS + action encoding internally.
  async dexe_proposal_build_modify_dao_profile() {
    return { actions: [], note: "handled inline by proposal_create with proposalType=modify_dao_profile" };
  },

  async dexe_proposal_create(args, { agentWallet, provider }) {
    const result = (await mcpCall("dexe_proposal_create", args)) as ProposalCreateMcpResult;
    if (result.mode === "executed") {
      return result; // server had a signer; not expected in our flow
    }
    if (result.mode !== "payloads" || !result.steps) {
      throw new Error(`unexpected proposal_create shape: ${JSON.stringify(result).slice(0, 200)}`);
    }
    const txHashes = await broadcastTxPayloads(result.steps, agentWallet);
    const gp = new Contract(String(args.govPool), LATEST_PROPOSAL_ID_ABI as unknown as string[], provider);
    const proposalId = (await gp.latestProposalId()).toString();
    return { proposalId, txHashes, descriptionURL: result.descriptionURL };
  },
};

interface TemplateCtx {
  dao: string;
  daoHelpers?: { settings: string; userKeeper: string; validators: string; poolRegistry: string; votePower: string };
  firstAllowlistedToken?: string;
  wallets: Map<string, { address: string; envKey: string }>;
  captures: Record<string, unknown>;
  /** Set by expand() when a referenced capture has __deferred. Lets the caller
   * cascade-skip a step that depends on a deferred upstream step. */
  deferredCascade?: { var: string; reason: string } | null;
}

function resolvePath(path: string, root: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let cur: unknown = root[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (cur == null) return undefined;
    if (parts[i] === "length" && Array.isArray(cur)) return cur.length;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

function expand(value: unknown, ctx: TemplateCtx): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (_full, expr) => {
      const t = String(expr).trim();
      if (t === "dao") return ctx.dao;
      if (t === "firstAllowlistedToken") return ctx.firstAllowlistedToken ?? "";
      if (t.startsWith("dao.") && ctx.daoHelpers) {
        const k = t.slice(4) as keyof NonNullable<TemplateCtx["daoHelpers"]>;
        return ctx.daoHelpers[k] ?? "";
      }
      const m = t.match(/^agent:([A-Za-z]):address$/);
      if (m) return ctx.wallets.get(m[1])?.address ?? "";
      const head = t.split(".")[0];
      const root = ctx.captures[head];
      if (root && typeof root === "object" && "__deferred" in (root as object)) {
        ctx.deferredCascade = {
          var: head,
          reason: String((root as { __deferred: string }).__deferred),
        };
        return "";
      }
      const r = resolvePath(t, ctx.captures);
      return r != null ? String(r) : "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expand(v, ctx);
    return out;
  }
  return value;
}

function evalSkipIf(expr: string, captures: Record<string, unknown>): boolean {
  // Supported forms: <varRef> == 'literal' | <varRef> == 0 | <varRef>.length == 0
  const m = expr.match(/^\s*([\w.]+)\s*(==|!=)\s*(.+)\s*$/);
  if (!m) return false;
  const left = resolvePath(m[1], captures);
  let right: string = m[3].trim();
  if (
    (right.startsWith("'") && right.endsWith("'")) ||
    (right.startsWith('"') && right.endsWith('"'))
  ) {
    right = right.slice(1, -1);
  }
  const eq = String(left ?? "") === right;
  return m[2] === "==" ? eq : !eq;
}

/** Substitute a fromAlias (typically "A") with toAlias in a step's text-bearing
 * fields. Used for loop expansion where scenarios are written for the first
 * alias and orchestrator iterates the rest. */
function applyLoopAlias(step: StepSpec, fromAlias: string, toAlias: string): StepSpec {
  if (fromAlias === toAlias) return step;
  const swap = (s: string): string =>
    s
      .replace(new RegExp(`\\{\\{agent:${fromAlias}:`, "g"), `{{agent:${toAlias}:`)
      .replace(new RegExp(`\\{\\{(\\w+)${fromAlias}\\.`, "g"), `{{$1${toAlias}.`)
      .replace(new RegExp(`\\{\\{(\\w+)${fromAlias}\\}\\}`, "g"), `{{$1${toAlias}}}`);
  const argsJson = JSON.stringify(step.args);
  const newArgs = JSON.parse(swap(argsJson)) as Record<string, unknown>;
  const newCapture =
    step.captureAs && step.captureAs.endsWith(fromAlias)
      ? step.captureAs.slice(0, -fromAlias.length) + toAlias
      : step.captureAs;
  const newSkip = step.skipIf
    ? swap(step.skipIf).replace(new RegExp(`\\b(\\w+)${fromAlias}\\b`, "g"), `$1${toAlias}`)
    : undefined;
  return {
    ...step,
    agent: step.agent === fromAlias ? toAlias : step.agent,
    captureAs: newCapture,
    skipIf: newSkip,
    args: newArgs,
  };
}

class Mutex {
  private chain: Promise<void> = Promise.resolve();
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const walletMutexes = new Map<string, Mutex>();
function mutexFor(envKey: string): Mutex {
  let m = walletMutexes.get(envKey);
  if (!m) {
    m = new Mutex();
    walletMutexes.set(envKey, m);
  }
  return m;
}

// ---- MCP-stdio bridge (Phase 1.5) -----------------------------------------
// Spawns dist/index.js with DEXE_PRIVATE_KEY="" so composite tools return
// TxPayload lists instead of broadcasting. Orchestrator signs each payload
// with the per-step agent wallet.

let mcpClientPromise: Promise<McpClient> | null = null;

async function getMcpClient(): Promise<McpClient> {
  if (!mcpClientPromise) {
    mcpClientPromise = (async () => {
      const transport = new StdioClientTransport({
        command: "node",
        args: [resolve("dist/index.js")],
        env: { ...process.env, DEXE_PRIVATE_KEY: "" } as Record<string, string>,
        cwd: process.cwd(),
      });
      const c = new McpClient({ name: "swarm-orchestrator", version: "0.1.0" });
      await c.connect(transport);
      return c;
    })();
  }
  return mcpClientPromise;
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const c = await getMcpClient();
  const res = await c.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`MCP ${name}: ${JSON.stringify(res.content)}`);
  if (res.structuredContent) return res.structuredContent;
  // Many tools return JSON-encoded text in content[0].text rather than structured.
  const text = (res.content as Array<{ type: string; text?: string }> | undefined)?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

interface ProposalCreateMcpResult {
  mode?: "payloads" | "executed";
  steps?: Array<{ label: string; skipped: boolean; payload?: { to: string; data: string; value: string; chainId: number } }>;
  descriptionURL?: string;
}

async function broadcastTxPayloads(
  steps: NonNullable<ProposalCreateMcpResult["steps"]>,
  wallet: Wallet,
): Promise<string[]> {
  const txHashes: string[] = [];
  for (const s of steps) {
    if (s.skipped || !s.payload) continue;
    const tx = await wallet.sendTransaction({
      to: s.payload.to,
      data: s.payload.data,
      value: BigInt(s.payload.value ?? "0"),
      chainId: BigInt(s.payload.chainId),
    });
    const rcpt = await tx.wait(1);
    txHashes.push(rcpt?.hash ?? tx.hash);
  }
  return txHashes;
}

const LATEST_PROPOSAL_ID_ABI = ["function latestProposalId() view returns (uint256)"] as const;

/** Generic MCP fallback dispatcher. Used when no inline dispatcher is
 * registered for a tool name. Routes the call through the dexe-mcp stdio
 * bridge, then handles the three return shapes uniformly:
 *   - {payload: {to,data,value,chainId}}    → broadcast as one tx (build_*)
 *   - {mode:"payloads", steps:[{payload}]}  → broadcast each in order (composite)
 *   - anything else                          → returned as captured result
 */
function mcpFallbackDispatcher(toolName: string): Dispatcher {
  return async (args, { agentWallet, provider }) => {
    const result = (await mcpCall(toolName, args)) as
      | { payload?: { to: string; data: string; value?: string; chainId?: number } }
      | { mode?: string; steps?: Array<{ skipped: boolean; payload?: { to: string; data: string; value: string; chainId: number } }> }
      | Record<string, unknown>
      | null;
    if (result && typeof result === "object" && "payload" in result && (result as { payload: unknown }).payload) {
      // build_* shape — return as-is so executeStep's broadcast wrapper picks it up.
      return result;
    }
    if (
      result &&
      typeof result === "object" &&
      "mode" in result &&
      (result as { mode?: string }).mode === "payloads" &&
      Array.isArray((result as { steps?: unknown[] }).steps)
    ) {
      const steps = (result as { steps: NonNullable<ProposalCreateMcpResult["steps"]> }).steps;
      const txHashes = await broadcastTxPayloads(steps, agentWallet);
      // Best-effort proposalId capture if a govPool arg is present.
      let proposalId: string | undefined;
      const gp = (args as { govPool?: string }).govPool;
      if (gp) {
        try {
          const c = new Contract(gp, LATEST_PROPOSAL_ID_ABI as unknown as string[], provider);
          proposalId = (await c.latestProposalId()).toString();
        } catch {
          /* contract may not be a GovPool; ignore */
        }
      }
      return { ...result, txHashes, proposalId };
    }
    return result;
  };
}

// ---------------------------------------------------------------------------

async function runScenario(
  spec: ScenarioSpec,
  args: CliArgs,
  stateFile: string,
  chainId: number,
  chainTag: string,
  provider: JsonRpcProvider,
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

  const tokens = parseList(`SWARM_TOKENS_${chainTag}`);
  const daos = parseList(`SWARM_DAOS_${chainTag}`);
  // Pick the token that matches this scenario's DAO (by index in allowlists).
  const daoIdx = daos.findIndex((d) => d.toLowerCase() === spec.dao.toLowerCase());
  const firstAllowlistedToken = daoIdx >= 0 ? tokens[daoIdx] ?? tokens[0] : tokens[0];
  let daoHelpers: TemplateCtx["daoHelpers"];
  try {
    const gp = new Contract(spec.dao, GOV_POOL_ABI as unknown as string[], provider);
    const h = await gp.getHelperContracts();
    daoHelpers = {
      settings: h[0] as string,
      userKeeper: h[1] as string,
      validators: h[2] as string,
      poolRegistry: h[3] as string,
      votePower: h[4] as string,
    };
  } catch (err) {
    console.log(`    ${YELLOW}~${RESET} Could not fetch DAO helpers (${err instanceof Error ? err.message : err}); {{dao.userKeeper}} unavailable.`);
  }

  // Loop expansion: when spec.loop is set, repeat loop.appliesToSteps once per
  // alias in loop.over. The first alias is treated as the template; subsequent
  // iterations swap that letter throughout the step's args / captureAs / skipIf.
  const loopAliases = spec.loop?.over ?? [""];
  const loopSteps = new Set(spec.loop?.appliesToSteps ?? []);
  const fromAlias = spec.loop?.over[0] ?? "";

  const captures: Record<string, unknown> = {};
  const stepsLog: StepLog[] = [];

  const executeStep = async (step: StepSpec, iter: string) => {
    const tplCtx: TemplateCtx = {
      dao: spec.dao,
      daoHelpers,
      firstAllowlistedToken,
      wallets,
      captures,
      deferredCascade: null,
    };
    const expandedArgs = expand(step.args, tplCtx) as Record<string, unknown>;
    const log: StepLog = {
      ts: new Date().toISOString(),
      scenarioId: spec.id,
      stepId: step.step,
      agent: step.agent,
      tool: step.tool,
      args: expandedArgs,
      status: "skipped",
      iter: iter || undefined,
    };
    const tag = iter ? `[${iter}] ` : "";

    // Cascade-skip if any expanded {{var.*}} resolved to a deferred upstream capture.
    if (tplCtx.deferredCascade) {
      log.status = "skipped";
      log.error = `cascade-deferred via ${tplCtx.deferredCascade.var} (${tplCtx.deferredCascade.reason})`;
      console.log(`    ${YELLOW}~${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${YELLOW}(${log.error})${RESET}`);
      if (step.captureAs) captures[step.captureAs] = { __deferred: log.error };
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }

    // skipIf gate
    if (step.skipIf && evalSkipIf(step.skipIf, captures)) {
      log.status = "skipped";
      log.error = `skipIf: ${step.skipIf}`;
      console.log(`    ${DIM}·${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${DIM}(skip: ${step.skipIf})${RESET}`);
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }

    if (args.dryRun) {
      log.status = "would-call";
      console.log(`    ${YELLOW}~${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${DIM}(dry-run)${RESET}`);
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }

    const dispatcher: Dispatcher = DISPATCHERS[step.tool] ?? mcpFallbackDispatcher(step.tool);

    const walletInfo = wallets.get(step.agent);
    if (!walletInfo) {
      log.status = "fail";
      log.error = `Unknown agent alias ${step.agent}`;
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }
    const pk = process.env[walletInfo.envKey]?.trim() ?? "";
    const agentWallet = new Wallet(pk, provider);

    const ctx: DispatchCtx = { provider, agentWallet, spec, chainTag };
    try {
      const result = await mutexFor(walletInfo.envKey).runExclusive(async () => {
        const r = await dispatcher(expandedArgs, ctx);
        if (r && typeof r === "object" && "__deferred" in r) {
          return r;
        }
        if (step.broadcast && r && typeof r === "object" && "payload" in r) {
          const p = (r as { payload: { to: string; data: string; value?: string } }).payload;
          const tx = await agentWallet.sendTransaction({
            to: p.to,
            data: p.data,
            value: BigInt(p.value ?? "0"),
          });
          const rcpt = await tx.wait(1);
          return { ...r, txHash: tx.hash, blockNumber: rcpt?.blockNumber };
        }
        return r;
      });

      if (result && typeof result === "object" && "__deferred" in result) {
        log.status = "skipped";
        log.error = `deferred: ${(result as { __deferred: string }).__deferred}`;
        console.log(`    ${YELLOW}~${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${YELLOW}(${log.error})${RESET}`);
        // Propagate deferred state so downstream steps cascade-skip via {{captureAs.*}} refs.
        if (step.captureAs) captures[step.captureAs] = result;
      } else if (result && typeof result === "object" && (result as { skipped?: boolean }).skipped === true) {
        log.status = "skipped";
        log.error = String((result as { reason?: string }).reason ?? "dispatcher self-skip");
        console.log(`    ${DIM}·${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${DIM}(${log.error})${RESET}`);
        if (step.captureAs) captures[step.captureAs] = result;
      } else {
        log.status = "pass";
        log.captured = result;
        if (result && typeof result === "object" && "txHash" in result) {
          log.txHash = String((result as { txHash: string }).txHash);
        }
        if (step.captureAs) captures[step.captureAs] = result;
        const txStr = log.txHash ? ` ${DIM}${log.txHash.slice(0, 12)}…${RESET}` : "";
        console.log(`    ${GREEN}✓${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}${txStr}`);
      }
    } catch (err) {
      log.status = "fail";
      log.error = err instanceof Error ? err.message : String(err);
      console.log(`    ${RED}✗${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${RED}${log.error}${RESET}`);
    }
    appendFileSync(stateFile, JSON.stringify(log) + "\n");
    stepsLog.push(log);
  };

  for (const step of spec.steps) {
    if (loopSteps.has(step.step) && spec.loop) {
      for (const it of loopAliases) {
        const expanded = applyLoopAlias(step, fromAlias, it);
        await executeStep(expanded, it);
      }
    } else {
      await executeStep(step, "");
    }
  }

  const allOk = stepsLog.every((s) => s.status !== "fail");
  return { id: spec.id, pass: allOk, steps: stepsLog };
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
  lines.push(`**Network:** BSC ${args.dryRun ? "(any)" : "live"}`);
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
    results.push(await runScenario(spec, args, stateFile, expectedChainId, chainTag, provider));
  }

  writeReport(runId, results, byId, args);

  if (mcpClientPromise) {
    try {
      const c = await mcpClientPromise;
      await c.close();
    } catch {
      /* swallow */
    }
  }

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
