import { Interface } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { registerAll } from "../tools/index.js";
import { Artifacts } from "../artifacts.js";
import { SelectorIndex } from "../lib/selectors.js";
import { RpcProvider } from "../rpc.js";
import { multicall } from "../lib/multicall.js";
import { GET_PROPOSALS_FRAGMENT, decodeProposalView } from "../lib/govProposalView.js";
import { proposalStateName } from "../lib/preflight.js";
import { safeErrorMessage } from "../lib/redact.js";
import { reviewProposal } from "../tools/proposalReview.js";
import { makeAdapter, type ModelAdapter } from "../lib/council/adapters.js";
import { loadCouncilConfig, type CouncilConfig } from "../lib/council/config.js";
import { CouncilLog, runRound, type CouncilChain, type VoteOutcome } from "../lib/council/runner.js";

/**
 * `dexe-mcp council --config council.json [--once] [--dry-run]`
 *
 * Runs an agent council on one DeXe DAO: every Voting proposal gets a review
 * packet (dexe_proposal_review's code path), each agent's model decides, and
 * the vote goes out through dexe_proposal_vote_and_execute with that agent's
 * keyring slot. docs/AGENT-COUNCIL.md.
 */

export const COUNCIL_HELP = [
  "dexe-mcp council --config <council.json> [--once] [--dry-run]",
  "",
  "  --config <file>  the council: chain, govPool, addressBook, agents (signer slot, model, role)",
  "  --once           one pass over the Voting proposals, then exit",
  "  --dry-run        ask the models and log the decisions; send nothing",
  "",
  "Signing needs DEXE_SIGNER_MODE=unattended and the agents' keys as AGENT_PK_1..16 (or",
  "DEXE_AGENT_PK_n) in the environment or .env; the chain must be in DEXE_UNATTENDED_CHAINS.",
  "Decisions and votes are appended to the JSONL log next to the config; each proposal is",
  "decided once per agent, so a restart never votes twice. docs/AGENT-COUNCIL.md",
  "",
].join("\n");

interface Args {
  config?: string;
  once: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { once: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--config" || t === "-c") a.config = argv[++i];
    else if (t.startsWith("--config=")) a.config = t.slice("--config=".length);
    else if (t === "--once") a.once = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else throw new Error(`unknown argument '${t}'`);
  }
  return a;
}

const GOV = new Interface(["function latestProposalId() view returns (uint256)", GET_PROPOSALS_FRAGMENT]);

/** Collect every 0x…64-hex string under a txHash-like key in the vote tool's reply. */
function txHashesIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) txHashesIn(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && /hash$/i.test(k) && /^0x[0-9a-fA-F]{64}$/.test(x) && !out.includes(x)) out.push(x);
      else txHashesIn(x, out);
    }
  }
  return out;
}

const NOT_SENT_MODES = new Set(["failed", "payloads", "vote-not-sent", "dryRun", "blocked-risky", "blocked-treasury"]);

/** The real chain: in-process MCP for the vote, direct reads for the rest. */
export async function openChain(cfg: CouncilConfig): Promise<CouncilChain & { close(): Promise<void> }> {
  const base = await loadConfig();
  // Only what the council calls; the gate drops everything else.
  const config = { ...base, toolsets: ["core"] };
  const server = new McpServer({ name: "dexe-council", version: "0.0.0" }, {});
  registerAll(server, config, { reportStore: null });
  const client = new Client({ name: "dexe-council", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const ctx = { config, artifacts: new Artifacts(config), selectors: new SelectorIndex(new Artifacts(config)) };
  const rpc = new RpcProvider(config);
  const provider = () => {
    const p = rpc.tryProvider(cfg.chain);
    if ("error" in p) throw new Error(`${p.error}\n${p.remediation}`);
    return p.ok;
  };
  const readViews = async (offset: number, limit: number) => {
    const [r] = await multicall(provider(), [
      { target: cfg.govPool, iface: GOV, method: "getProposals", args: [offset, limit] },
    ]);
    if (!r?.success) throw new Error("getProposals reverted");
    return (r.value as unknown[]).map(decodeProposalView);
  };

  return {
    async listActive() {
      const [r] = await multicall(provider(), [{ target: cfg.govPool, iface: GOV, method: "latestProposalId", args: [] }]);
      if (!r?.success) throw new Error("latestProposalId reverted — is govPool a GovPool?");
      const latest = Number(r.value);
      if (latest === 0) return [];
      const offset = Math.max(0, latest - cfg.scanLatest);
      const views = await readViews(offset, latest - offset);
      return views.flatMap((v, i) => (v && v.proposalState === 0 ? [offset + i + 1] : []));
    },
    review: (id) =>
      reviewProposal(ctx, { govPool: cfg.govPool, proposalId: id, chainId: cfg.chain, addressBook: cfg.addressBook, limits: cfg.limits }, rpc),
    async state(id) {
      const [v] = await readViews(id - 1, 1);
      if (!v) throw new Error(`proposal ${id} not readable`);
      return { index: v.proposalState, name: proposalStateName(v.proposalState) };
    },
    async vote(agent, id, isFor): Promise<VoteOutcome> {
      const res = (await client.callTool({
        name: "dexe_proposal_vote_and_execute",
        arguments: {
          govPool: cfg.govPool,
          chainId: cfg.chain,
          proposalId: id,
          isVoteFor: isFor,
          depositFirst: "auto",
          // An AGAINST vote never executes anything; a FOR vote moves a passed
          // proposal on (validator round or execute) like a human voter would.
          autoExecute: isFor,
          driveValidatorRound: isFor,
          signerKey: agent.signerKey,
        },
      })) as { isError?: boolean; content?: { type: string; text?: string }[] };
      const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      if (res.isError) return { ok: false, txHashes: [], error: text.slice(0, 500) };
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse((res.content ?? [])[0]?.text ?? "") as Record<string, unknown>;
      } catch {
        /* non-JSON success text */
      }
      let mode = typeof json?.mode === "string" ? json.mode : undefined;
      const ok = !mode || !NOT_SENT_MODES.has(mode);
      // The wallet voted before the council did (e.g. createProposalAndVote by
      // the proposer agent). GovPool refuses a second vote, so the decision is
      // NOT what is on-chain when the sides or amounts differ; say so, and do
      // not retry (a retry can never land).
      let note: string | undefined;
      if (mode === "already-voted") {
        const cast = typeof json?.voteAlreadyCast === "string" ? json.voteAlreadyCast : "";
        if (typeof json?.voteChangeAdvisory === "string") mode = "already-voted-differs";
        note = cast.split(". GovPool")[0]?.slice(0, 300);
      }
      return {
        ok,
        mode,
        txHashes: json ? txHashesIn(json) : [],
        stateAfter: typeof json?.proposalStateAfter === "string" ? json.proposalStateAfter : undefined,
        ...(note ? { note } : {}),
        ...(ok ? {} : { error: text.slice(0, 500) }),
      };
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`[dexe-mcp council] ${(e as Error).message}\n\n${COUNCIL_HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(COUNCIL_HELP);
    return 0;
  }
  if (!args.config) {
    process.stderr.write(`[dexe-mcp council] --config is required\n\n${COUNCIL_HELP}`);
    return 2;
  }
  let cfg: CouncilConfig;
  try {
    cfg = loadCouncilConfig(args.config);
  } catch (e) {
    process.stderr.write(`[dexe-mcp council] ${(e as Error).message}\n`);
    return 2;
  }
  if (!args.dryRun && process.env.DEXE_SIGNER_MODE?.trim().toLowerCase() !== "unattended") {
    process.stderr.write(
      "[dexe-mcp council] voting needs DEXE_SIGNER_MODE=unattended (agents sign with their keyring slots). " +
        "Use --dry-run to only see the decisions.\n",
    );
    return 2;
  }
  const say = (l: string) => process.stderr.write(`[council] ${l}\n`);
  const adapters = new Map<string, ModelAdapter>(cfg.agents.map((a) => [a.name, makeAdapter(a.model)]));
  const log = new CouncilLog(cfg.logPath);
  say(
    `${cfg.agents.length} agent(s) on ${cfg.govPool} (chain ${cfg.chain})${args.dryRun ? ", DRY RUN" : ""}; log ${cfg.logPath}`,
  );

  let chain: Awaited<ReturnType<typeof openChain>>;
  try {
    chain = await openChain(cfg);
  } catch (e) {
    say(`cannot start: ${safeErrorMessage(e)}`);
    return 1;
  }
  let stop = false;
  const onSig = () => {
    stop = true;
    say("stopping after this round");
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  try {
    for (;;) {
      const s = await runRound(cfg, chain, adapters, log, { dryRun: args.dryRun, say });
      say(`round: ${s.proposals.length} in Voting, ${s.decided} decided, ${s.voted} voted, ${s.skipped} skipped, ${s.errors} error(s)`);
      if (args.once || stop) return s.errors > 0 ? 1 : 0;
      await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
      if (stop) return 0;
    }
  } finally {
    await chain.close();
  }
}
