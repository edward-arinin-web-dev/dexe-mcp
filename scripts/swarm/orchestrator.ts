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
import {
  evaluateExpect,
  validateStepExpectations,
  type AssertionResult,
  type Expectation,
} from "./expect.js";
import {
  classifyProposalCreateResult,
  resumeCapture,
  type ProposalCreateMcpResult,
} from "./proposalCreateResult.js";
import { routeStep } from "./stepRouting.js";
import {
  checkDaosRegistered,
  makeIsGovPool,
  unregisteredFixtureMessage,
} from "./allowlist-guard.js";
import { assertDistFresh, fileMtime, newestMtime } from "./dist-freshness.mjs";
import {
  isDaoTemplateKey,
  resolveTimeTemplate,
  unknownDaoKeyMessage,
} from "../../tests/swarm/lib/templates.js";

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
  /** Machine-checked assertions on the step's result. Evaluated after the
   *  capture is stored; a failure marks the step (and so the scenario) failed.
   *  NOT evaluated on the skip / cascade / dry-run paths. */
  expect?: Expectation[];
  /** The step is EXPECTED to error, and the message must contain this text.
   *  A matching error is a PASS; an unexpectedly successful call is a FAIL. */
  expectError?: string;
  /** Let the MCP sign this step as the keyring slot that owns this step's
   *  agent wallet (`signerKey`), instead of the orchestrator signing the
   *  returned payload locally. The only way a swarm run touches the server's
   *  broadcast guards, nonce queue and ledger. Mutually exclusive with
   *  `broadcast`. */
  serverSign?: boolean;
}

interface SuccessCriterion {
  id: string;
  check: string;
}

interface PrefundSpec {
  wallet: string;
  token: string;
  minBalance: string;
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
  /** Optional pre-scenario top-up: orchestrator transfers `token` from
   * AGENT_FUNDER_PK to each `wallet` so its ERC20 balance is at least
   * `minBalance`. Token can be a literal address or `{{firstAllowlistedToken}}`. */
  prefund?: PrefundSpec[];
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
    // _schema.md has claimed "the orchestrator validates this on load" since
    // Phase 0 while this function did a bare `JSON.parse(...) as ScenarioSpec`.
    // Without a real check a misspelled `expcet:` key or an unknown op is
    // dropped in silence — exactly how `successCriteria` became decorative.
    const errors = validateStepExpectations(spec);
    if (errors.length > 0) fail(`scenario ${spec.id}: ${errors.join("; ")}`);
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
  /** One entry per `expect` — passing ones included, so the JSONL keeps the
   *  evidence of what was actually checked. */
  assertions?: AssertionResult[];
}

// ---- Phase 1 atom: real-dispatch + loop expansion -------------------------

const GOV_POOL_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
  "function undelegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function withdraw(address receiver, uint256 amount, uint256[] nftIds)",
  "function deposit(uint256 amount, uint256[] nftIds) payable",
  "function delegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function multicall(bytes[] data) returns (bytes[] results)",
  "function unlock(address user)",
  "function getUserActiveProposalsCount(address user) view returns (uint256)",
] as const;

/**
 * F4 (docs/UPSTREAM-ISSUES.md): SphereX-era pools revert a raw top-level
 * `delegate()` / `vote()` with "disallowed tx pattern"; the frontend — and
 * `dexe_vote_build_delegate` / `dexe_vote_build_vote` — send the single-element
 * `multicall([call])` instead. The inline dispatchers below hand-encode these
 * two so `signerKey` never has to reach the MCP, and until 2026-09-24 they
 * encoded the RAW shape: every delegate/vote step failed on a fresh fixture
 * while the tool under test was emitting the right bytes. Same wrapper here.
 */
function wrapInMulticall(iface: Interface, inner: string): string {
  return iface.encodeFunctionData("multicall", [[inner]]);
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount)",
  "function transfer(address recipient, uint256 amount)",
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
  /** True for a `serverSign` step: route the MCP call to the keyed child. */
  serverSign?: boolean;
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

  /** F23 (docs/UPSTREAM-ISSUES.md): an undelegate reverts while the delegatee
   * has a vote on record, and a standalone `unlock(delegatee)` is what clears
   * the finished ones. S00 sends it before each undelegate so one scenario's
   * leftover delegation does not survive the reset. Self-skips when the list is
   * already empty, and when the unlock would revert — a proposal the delegatee
   * voted on is still in Voting, and nothing can move until it ends. */
  async dexe_vote_build_unlock_delegatee(args, { provider, agentWallet }) {
    const govPool = String(args.govPool);
    const delegatee = String(args.delegatee);
    const gp = new Contract(govPool, GOV_POOL_ABI as unknown as string[], provider);
    const onRecord: bigint = await gp.getUserActiveProposalsCount(delegatee);
    if (onRecord === 0n) {
      return { skipped: true, reason: `delegatee ${delegatee} has no votes on record` };
    }
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("unlock", [delegatee]);
    try {
      await provider.call({ to: govPool, data, from: agentWallet.address });
    } catch {
      return {
        skipped: true,
        reason: `F23: delegatee ${delegatee} voted on a proposal still in Voting — unlock reverts until it ends`,
      };
    }
    return { payload: { to: govPool, data, value: "0" }, votesOnRecord: String(onRecord) };
  },

  /** S00's undelegate: the raw call, but only once the delegatee's list is
   * empty (F23). A delegation held by a live vote is reported as skipped — the
   * reset is best-effort and the next one, after the vote, picks it up. */
  async dexe_vote_build_undelegate_unlocked(args, { provider }) {
    const govPool = String(args.govPool);
    const delegatee = String(args.delegatee);
    const gp = new Contract(govPool, GOV_POOL_ABI as unknown as string[], provider);
    const onRecord: bigint = await gp.getUserActiveProposalsCount(delegatee);
    if (onRecord > 0n) {
      return {
        skipped: true,
        reason: `F23: delegatee ${delegatee} still has ${onRecord} vote(s) on record — undelegate would revert`,
      };
    }
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const data = iface.encodeFunctionData("undelegate", [
      delegatee,
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: govPool, data, value: "0" } };
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
    const inner = iface.encodeFunctionData("delegate", [
      String(args.delegatee),
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data: wrapInMulticall(iface, inner), value: "0" } };
  },

  async dexe_vote_build_vote(args) {
    const iface = new Interface(GOV_POOL_ABI as unknown as string[]);
    const inner = iface.encodeFunctionData("vote", [
      String(args.proposalId),
      Boolean(args.isVoteFor),
      String(args.amount),
      (args.nftIds as string[]) ?? [],
    ]);
    return { payload: { to: String(args.govPool), data: wrapInMulticall(iface, inner), value: "0" } };
  },

  // Phase 1.5: route the IPFS-touching composite tools through dexe-mcp via
  // stdio. proposal_build_modify_dao_profile is a no-op marker; proposal_create
  // (proposalType=modify_dao_profile) does IPFS + action encoding internally.
  async dexe_proposal_build_modify_dao_profile() {
    return { actions: [], note: "handled inline by proposal_create with proposalType=modify_dao_profile" };
  },

  /**
   * The 0.33 write-path guards return `dryRun` / `blocked-risky` /
   * `already-created` through `ok()` (no isError), so they reach this
   * dispatcher. Until 0.34.0 anything but payloads/executed threw and the
   * scenario was scored FAIL — the harness graded a guard doing its job
   * exactly like a regression. Classification is now a pure function so it can
   * be unit-tested without importing this self-executing module.
   */
  async dexe_proposal_create(args, { agentWallet, provider }) {
    const raw = await mcpCall("dexe_proposal_create", args);
    const verdict = classifyProposalCreateResult(raw);
    if (verdict.kind === "passthrough") return verdict.body;
    // A refusal must NOT land as a "pass": its capture would expand to "" in
    // every dependant step. `__deferred` cascade-skips them instead.
    if (verdict.kind === "defer") return { ...verdict.body, __deferred: verdict.reason };
    // `already-created` is a RESUME, not a failure — the duplicate guard's
    // whole point is that the run continues against the existing proposal.
    if (verdict.kind === "resume") return resumeCapture(verdict.body);
    const txHashes = await broadcastTxPayloads(verdict.steps, agentWallet);
    const gp = new Contract(String(args.govPool), LATEST_PROPOSAL_ID_ABI as unknown as string[], provider);
    const id: bigint = await gp.latestProposalId();
    return {
      mode: verdict.body.mode,
      proposalId: id.toString(),
      proposalIdNum: Number(id),
      txHashes,
      ...(txHashes.length > 0 ? { txHash: txHashes[txHashes.length - 1] } : {}),
      descriptionURL: verdict.body.descriptionURL,
      steps: verdict.body.steps,
    };
  },
};

/** Tool names answered by an inline dispatcher — `signerKey` never reaches the
 *  MCP for these, so `serverSign` on one of them would be a silent no-op. */
const INLINE_DISPATCHER_NAMES = Object.keys(DISPATCHERS);

/** Every field optional: the three sources (getHelperContracts, getNftContracts,
 *  the predicted-helper allowlists) resolve independently and any of them can be
 *  unavailable. `{{dao.<key>}}` then expands to "" and the tool's own
 *  `Invalid <field>` check is what surfaces it — the same fail-open posture the
 *  helper fetch always had. */
interface DaoHelpers {
  settings?: string;
  userKeeper?: string;
  validators?: string;
  poolRegistry?: string;
  votePower?: string;
  /** From getNftContracts() — fetched in its OWN try block so a revert there
   *  cannot discard the five helpers above. */
  nftMultiplier?: string;
  expertNft?: string;
  dexeExpertNft?: string;
  babt?: string;
  /** Factory-PREDICTED helpers. GovPool has no forward getter for either, so
   *  these come from the index-parallel SWARM_TOKENSALE_* /
   *  SWARM_DISTRIBUTION_* allowlists. Both are proposal EXECUTORS, i.e. write
   *  targets — which is why they are allowlists and not free-form env. */
  tokenSale?: string;
  distributionProposal?: string;
}

interface TemplateCtx {
  dao: string;
  daoHelpers?: DaoHelpers;
  firstAllowlistedToken?: string;
  allowlistedDaos?: string[];
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
    // Whole-value single-template short-circuit: preserves the underlying type
    // (number, boolean, object) instead of stringifying it. Lets scenarios
    // pass a number-typed proposalId via {{createdProp.proposalIdNum}} to
    // tools whose schemas demand z.number().
    const whole = value.match(/^\{\{([^}]+)\}\}$/);
    if (whole) {
      const t = whole[1].trim();
      if (t === "dao") return ctx.dao;
      if (t === "firstAllowlistedToken") return ctx.firstAllowlistedToken ?? "";
      if (t === "firstAllowlistedDao") return ctx.allowlistedDaos?.[0] ?? "";
      if (t === "secondAllowlistedDao") return ctx.allowlistedDaos?.[1] ?? "";
      // Before the captures lookup, so a capture literally named `now` cannot
      // shadow it. Returns a decimal STRING on purpose — every consuming field
      // (saleStartTime/saleEndTime, startedAt/deadline) is z.string().
      const nowTpl = resolveTimeTemplate(t);
      if (nowTpl !== null) return nowTpl;
      if (t.startsWith("dao.")) {
        const k = t.slice(4);
        if (!isDaoTemplateKey(k)) throw new Error(unknownDaoKeyMessage(k));
        return ctx.daoHelpers?.[k] ?? "";
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
      return r ?? "";
    }
    return value.replace(/\{\{([^}]+)\}\}/g, (_full, expr) => {
      const t = String(expr).trim();
      if (t === "dao") return ctx.dao;
      if (t === "firstAllowlistedToken") return ctx.firstAllowlistedToken ?? "";
      if (t === "firstAllowlistedDao") return ctx.allowlistedDaos?.[0] ?? "";
      if (t === "secondAllowlistedDao") return ctx.allowlistedDaos?.[1] ?? "";
      const nowTpl = resolveTimeTemplate(t);
      if (nowTpl !== null) return nowTpl;
      if (t.startsWith("dao.")) {
        const k = t.slice(4);
        if (!isDaoTemplateKey(k)) throw new Error(unknownDaoKeyMessage(k));
        return ctx.daoHelpers?.[k] ?? "";
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

const mcpClientPromises: { payloads: Promise<McpClient> | null; signing: Promise<McpClient> | null } = {
  payloads: null,
  signing: null,
};

/**
 * Two children, on purpose.
 *
 * `payloads` — DEXE_PRIVATE_KEY="" — is what every ordinary step talks to: the
 * composites answer `mode: "payloads"` and the orchestrator signs each payload
 * with the step's own agent wallet.
 *
 * `signing` keeps a primary key, so the server is in KEYRING mode and honours
 * `signerKey`. A `serverSign` step needs exactly that: in the keyless child
 * the server is in WalletConnect mode and refuses `signerKey` outright
 * ("not available in WalletConnect mode"), which is how every serverSign
 * scenario (S66, S67) failed on the 2026-09-24 sweep without the server's send
 * path ever being exercised. The primary is whichever hot key the runner has
 * (DEXE_PRIVATE_KEY, else the funder); the persona still comes from signerKey.
 */
async function getMcpClient(kind: "payloads" | "signing" = "payloads"): Promise<McpClient> {
  if (!mcpClientPromises[kind]) {
    mcpClientPromises[kind] = (async () => {
      const primary =
        kind === "signing"
          ? process.env.DEXE_PRIVATE_KEY?.trim() || process.env.AGENT_FUNDER_PK?.trim() || ""
          : "";
      if (kind === "signing" && !primary) {
        throw new Error(
          "serverSign needs a primary hot key for the MCP child (DEXE_PRIVATE_KEY or AGENT_FUNDER_PK in .env) — " +
            "without one the server is in WalletConnect mode and refuses signerKey.",
        );
      }
      const transport = new StdioClientTransport({
        command: "node",
        args: [resolve("dist/index.js")],
        // DEXE_TOOLSETS=full: scenario steps hit read/vote/dev tools that the
        // slim default surface hides — without this ~34 steps 404 as "unknown
        // tool" (P3 harness bug, 2026-07-07 run).
        env: { ...process.env, DEXE_PRIVATE_KEY: primary, DEXE_TOOLSETS: "full" } as Record<string, string>,
        cwd: process.cwd(),
      });
      const c = new McpClient({ name: `swarm-orchestrator-${kind}`, version: "0.1.0" });
      await c.connect(transport);
      return c;
    })();
  }
  return mcpClientPromises[kind]!;
}

async function mcpCall(
  name: string,
  args: Record<string, unknown>,
  opts: { serverSign?: boolean } = {},
): Promise<unknown> {
  const c = await getMcpClient(opts.serverSign ? "signing" : "payloads");
  const res = await c.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`MCP ${name}: ${JSON.stringify(res.content)}`);
  if (res.structuredContent) return res.structuredContent;
  // Many tools return JSON-encoded text in a content item rather than
  // structured. NOT necessarily the first one: the keyless server this harness
  // spawns attaches a WalletConnect pairing QR as an EXTRA text item on every
  // write (0.18+), and it comes first. Taking content[0] parsed the QR, and
  // every execute scenario (S52–S57, S64) scored "returned no mode — server
  // older than 0.30?" against a server that had answered correctly. Pick the
  // item that parses as JSON; fall back to the first text.
  const items = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  for (const it of items) {
    if (it.type !== "text" || !it.text) continue;
    try {
      return JSON.parse(it.text);
    } catch {
      /* not the JSON item */
    }
  }
  return items.find((it) => it.type === "text" && it.text)?.text ?? null;
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
  return async (args, { agentWallet, provider, serverSign }) => {
    const result = (await mcpCall(toolName, args, { serverSign: Boolean(serverSign) })) as
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
      // A serverSign step asked the MCP to broadcast. If payloads come back
      // anyway the slot is not configured in the child's env — signing them
      // here would silently rescue the step and prove nothing about the
      // server's send path, which is the only reason serverSign exists.
      if ("signerKey" in args) {
        throw new Error(
          `${toolName} returned mode "payloads" despite signerKey="${String(args.signerKey)}" — that keyring ` +
            `slot is not configured in the MCP child's env (DEXE_AGENT_PK_* / AGENT_PK_*). The orchestrator ` +
            `refuses to sign a serverSign step locally.`,
        );
      }
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

  // ---- Pre-scenario funding: top up wallets from AGENT_FUNDER_PK if their
  // token balance is below the per-spec threshold. Skipped on dry-run.
  if (!args.dryRun && spec.prefund && spec.prefund.length > 0) {
    const funderPk = process.env.AGENT_FUNDER_PK?.trim();
    if (funderPk && /^0x[0-9a-fA-F]{64}$/.test(funderPk)) {
      const funder = new Wallet(funderPk, provider);
      for (const pf of spec.prefund) {
        const w = wallets.get(pf.wallet);
        if (!w) continue;
        let tokenAddr = pf.token;
        if (tokenAddr === "{{firstAllowlistedToken}}") tokenAddr = firstAllowlistedToken ?? "";
        if (!tokenAddr) continue;
        const erc20 = new Contract(tokenAddr, ERC20_ABI as unknown as string[], provider);
        const cur: bigint = await erc20.balanceOf(w.address);
        const min = BigInt(pf.minBalance);
        if (cur >= min) continue;
        const shortfall = min - cur;
        const tk = new Contract(tokenAddr, ERC20_ABI as unknown as string[], funder);
        const tx = await tk.transfer(w.address, shortfall);
        await tx.wait(1);
        console.log(`    ${DIM}prefund${RESET} ${pf.wallet} ← ${shortfall} (${tokenAddr.slice(0, 10)}…) tx ${tx.hash.slice(0, 12)}…`);
      }
    } else {
      console.log(`    ${YELLOW}~${RESET} prefund requested but AGENT_FUNDER_PK is missing/malformed; skipping.`);
    }
  }
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
  // SEPARATE try block on purpose. Folding this into the one above would mean a
  // revert here discards the five helpers it already resolved, emptying
  // {{dao.userKeeper}} & co across every scenario that uses them.
  try {
    const gp2 = new Contract(spec.dao, GOV_POOL_ABI as unknown as string[], provider);
    const n = (await gp2.getFunction("getNftContracts").staticCall()) as string[];
    if (daoHelpers) {
      daoHelpers.nftMultiplier = n[0] as string;
      daoHelpers.expertNft = n[1] as string;
      daoHelpers.dexeExpertNft = n[2] as string;
      daoHelpers.babt = n[3] as string;
    }
  } catch (err) {
    console.log(`    ${YELLOW}~${RESET} Could not fetch DAO NFT contracts (${err instanceof Error ? err.message : err}); {{dao.expertNft}} / {{dao.nftMultiplier}} unavailable.`);
  }
  // Predicted helpers: no on-chain getter exists, so they come from
  // index-parallel allowlists. Refuse an entry that is not in the list for this
  // chain — both are proposal executors, i.e. write targets.
  {
    const sales = parseList(`SWARM_TOKENSALE_${chainTag}`);
    const dists = parseList(`SWARM_DISTRIBUTION_${chainTag}`);
    const sale = daoIdx >= 0 ? sales[daoIdx] : undefined;
    const dist = daoIdx >= 0 ? dists[daoIdx] : undefined;
    if (sale || dist) {
      daoHelpers ??= {};
      if (sale) daoHelpers.tokenSale = sale;
      if (dist) daoHelpers.distributionProposal = dist;
    }
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
      allowlistedDaos: daos,
      wallets,
      captures,
      deferredCascade: null,
    };
    const tag = iter ? `[${iter}] ` : "";
    let expandedArgs: Record<string, unknown>;
    try {
      expandedArgs = expand(step.args, tplCtx) as Record<string, unknown>;
    } catch (err) {
      // A malformed {{now±N}} or an unknown {{dao.*}} key must fail the step
      // loudly rather than resolve to "" (which BigInt()s to 0 downstream and
      // surfaces as a nonsense "window is in the PAST" further on).
      const log: StepLog = {
        ts: new Date().toISOString(),
        scenarioId: spec.id,
        stepId: step.step,
        agent: step.agent,
        tool: step.tool,
        args: step.args,
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
        iter: iter || undefined,
      };
      console.log(`    ${RED}✗${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${RED}${log.error}${RESET}`);
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }
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

    // Assertions are NOT evaluated on any early-return path below: a
    // cascade-skip, a skipIf and --dry-run all return before the tool is
    // dispatched, so there is no result to assert on. Evaluating there would
    // turn `swarm:smoke` (--dry-run) and the *-dry scenarios red the moment a
    // scenario gains an `expect` block.
    const expectCount = step.expect?.length ?? 0;

    // Cascade-skip if any expanded {{var.*}} resolved to a deferred upstream capture.
    if (tplCtx.deferredCascade) {
      log.status = "skipped";
      log.error = `cascade-deferred via ${tplCtx.deferredCascade.var} (${tplCtx.deferredCascade.reason})`;
      log.assertions = [];
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
      log.assertions = [];
      console.log(`    ${DIM}·${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${DIM}(skip: ${step.skipIf})${RESET}`);
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }

    if (args.dryRun) {
      log.status = "would-call";
      log.assertions = [];
      if (expectCount > 0) log.error = `${expectCount} expectation(s) not evaluated (dry-run)`;
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

    // serverSign: the MCP signs as this step's persona, so the server's
    // broadcast guards / nonce queue / ledger are exercised. The slot is
    // DERIVED from the same env key the wallet mutex keys on, so the queue and
    // the actual sender are the same EOA by construction.
    let route: ReturnType<typeof routeStep>;
    try {
      route = routeStep(step, walletInfo.envKey, {
        inlineDispatchers: INLINE_DISPATCHER_NAMES,
        scenarioId: spec.id,
      });
    } catch (err) {
      log.status = "fail";
      log.error = err instanceof Error ? err.message : String(err);
      console.log(`    ${RED}✗${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${RED}${log.error}${RESET}`);
      appendFileSync(stateFile, JSON.stringify(log) + "\n");
      stepsLog.push(log);
      return;
    }
    if (route.mode === "server") {
      expandedArgs = { ...expandedArgs, signerKey: route.signerKey };
      log.args = expandedArgs;
    }

    const pk = process.env[walletInfo.envKey]?.trim() ?? "";
    const agentWallet = new Wallet(pk, provider);

    const ctx: DispatchCtx = { provider, agentWallet, spec, chainTag, serverSign: route.mode === "server" };
    try {
      const result = await mutexFor(walletInfo.envKey).runExclusive(async () => {
        const r = await dispatcher(expandedArgs, ctx);
        if (r && typeof r === "object" && "__deferred" in r) {
          return r;
        }
        // A serverSign step is already broadcast by the MCP — re-sending its
        // payload locally would double-spend the nonce.
        if (route.mode === "local" && step.broadcast && r && typeof r === "object" && "payload" in r) {
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
        // Keep the body: an assertion or a triage read on a deferred step saw
        // nothing before, because only the pass branch set `captured`.
        log.captured = result;
        console.log(`    ${YELLOW}~${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${YELLOW}(${log.error})${RESET}`);
        // Propagate deferred state so downstream steps cascade-skip via {{captureAs.*}} refs.
        if (step.captureAs) captures[step.captureAs] = result;
      } else if (result && typeof result === "object" && (result as { skipped?: boolean }).skipped === true) {
        log.status = "skipped";
        log.error = String((result as { reason?: string }).reason ?? "dispatcher self-skip");
        log.captured = result;
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

      // ---- assertions ---------------------------------------------------
      // Evaluated against the captures PLUS the step's own result, so a step
      // with no captureAs can still assert on what it returned.
      if (step.expectError) {
        const landedAs = log.status;
        log.status = "fail";
        log.error =
          `expected an error containing "${step.expectError}" but the call returned ` +
          `(${landedAs}): ${JSON.stringify(result)?.slice(0, 200)}`;
        console.log(`    ${RED}✗${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${RED}${log.error}${RESET}`);
      } else if (expectCount > 0) {
        const root: Record<string, unknown> = { ...captures, result, self: result };
        const exps = (step.expect ?? []).map((e) => ({
          ...e,
          // Expected values go through the same template expansion as args, so
          // `{{firstAllowlistedToken}}` / `{{agent:B:address}}` / an earlier
          // capture can be the expected value in a chain-agnostic scenario.
          value: e.value === undefined ? undefined : expand(e.value, tplCtx),
        }));
        log.assertions = evaluateExpect(exps, root);
        const bad = log.assertions.filter((a) => !a.ok);
        if (bad.length > 0) {
          log.status = "fail";
          log.error = bad.map((a) => a.message).join("; ");
          console.log(`    ${RED}✗${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${RED}${log.error}${RESET}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (step.expectError && message.includes(step.expectError)) {
        // The refusal IS the assertion. Mark the step passed, but hand
        // dependants a deferred capture so they cascade-skip instead of
        // expanding {{cap.field}} to "" and sending nonsense.
        log.status = "pass";
        log.error = `expected error: ${message}`;
        log.captured = { expectedError: message };
        if (step.captureAs) captures[step.captureAs] = { __deferred: `expectError satisfied: ${message}` };
        console.log(`    ${GREEN}✓${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${DIM}(refused as expected)${RESET}`);
      } else {
        log.status = "fail";
        log.error = step.expectError
          ? `expected an error containing "${step.expectError}" but got: ${message}`
          : message;
        console.log(`    ${RED}✗${RESET} ${tag}step ${step.step} ${step.agent} → ${step.tool}  ${RED}${log.error}${RESET}`);
      }
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
  // `Asserts` makes an UNVERIFIED scenario visible: "—" means nothing was
  // machine-checked, so a ✅ there only says "nothing threw".
  lines.push("| Scenario | Title | Result | Steps | Skipped | Asserts |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    const s = scenarios.get(r.id)!;
    const verdict = r.pass ? "✅ pass" : "❌ fail";
    const all = r.steps.flatMap((st) => st.assertions ?? []);
    const asserts = all.length === 0 ? "—" : `${all.filter((a) => a.ok).length}/${all.length}`;
    const skipped = r.steps.filter((st) => st.status === "skipped").length;
    lines.push(`| ${r.id} | ${s.title} | ${verdict} | ${r.steps.length} | ${skipped} | ${asserts} |`);
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
      for (const a of step.assertions ?? []) {
        if (a.ok) continue;
        lines.push(`  - ✗ ${a.message ?? `expect ${a.path} ${a.op}`}`);
      }
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

  // ---- startup guards (ONCE, before the scenario loop) -------------------
  // Not in getMcpClient(): that is reached lazily, per step, and only for tools
  // with no inline dispatcher — by then the prefund block has already moved
  // ERC20 on-chain. Not in checkAllowlists() either: that is synchronous and
  // runs per scenario, and its fail() would exit before writeReport().
  if (!args.dryRun) {
    const fresh = assertDistFresh(fileMtime(resolve("dist/index.js")), newestMtime(resolve("src")));
    if (!fresh.ok) {
      if (fresh.level === "missing" || process.env.SWARM_SKIP_DIST_CHECK !== "1") fail(fresh.message);
      console.log(`${YELLOW}~${RESET} ${fresh.message}`);
    }
  }
  {
    const daoList = parseList(`SWARM_DAOS_${chainTag}`);
    if (daoList.length > 0) {
      try {
        const isGovPool = await makeIsGovPool(provider, expectedChainId);
        const { unregistered, verified } = await checkDaosRegistered(daoList, isGovPool);
        if (verified && unregistered.length > 0) {
          const msg = unregisteredFixtureMessage(
            unregistered[0]!,
            daoList.indexOf(unregistered[0]!),
            chainTag,
            expectedChainId,
          );
          // Keep `swarm:smoke` (--dry-run) usable: a dry run never dispatches a
          // composite, so it never hits the W10 refusal.
          if (args.dryRun) console.log(`${YELLOW}~ ${msg}${RESET}`);
          else fail(msg);
        }
      } catch {
        console.log(`${YELLOW}~${RESET} Fixture registration check skipped (RPC/registry unavailable).`);
      }
    }
  }

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

  for (const pending of Object.values(mcpClientPromises)) {
    if (!pending) continue;
    try {
      const c = await pending;
      await c.close();
    } catch {
      /* swallow */
    }
  }

  const failed = results.filter((r) => !r.pass).length;
  const passed = results.length - failed;
  const reportPath = resolve(`tests/reports/swarm/${runId}/run.md`);
  // Single machine-greppable line for nightly cron / webhook posters.
  // Format: SWARM <runId> <pass>/<total> <mode> <chainTag> <reportPath>
  console.log(
    `SWARM ${runId} ${passed}/${results.length} ${args.dryRun ? "dry-run" : "broadcast"} ${chainTag} ${reportPath}`,
  );
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
