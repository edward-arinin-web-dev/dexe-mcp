import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { listTools, collectParams, type ParamEntry } from "../helpers/listTools.js";
import { annotationsFor } from "../../src/tools/annotations.js";
import { FLOWS, TOPICS } from "../../src/knowledge/index.js";

/**
 * ── Tool description & schema style guide, mechanically enforced ───────────
 *
 * A tool description and its parameter descriptions are the ONLY documentation
 * the model reads before it acts. Until 0.34.0 nothing checked them, and the
 * drift that produced was measurable: 304 of 767 top-level parameters had no
 * description at all — `govPool`, `proposalId`, `amount` and `isVoteFor` on
 * fund-moving builders in the DEFAULT profile — two tools required an env var
 * that has been optional since 0.17.0, one shipped an internal roadmap TODO to
 * users, and two named a contract method their handler does not encode. Review
 * does not scale to 168 tools and ~990 parameters across 37 register files; a
 * rule file does.
 *
 * THE STYLE GUIDE — ten rules, each one `it` below:
 *
 *  R1  Every description opens with an EFFECT MARKER from a closed vocabulary,
 *      and the marker matches the effect derived from the central annotations
 *      map plus the tool's own output shape — so prose and annotations cannot
 *      disagree about whether a call spends money (R1/R1b), a description
 *      cannot name a contract method its handler does not encode (R1c), and a
 *      tool that reaches the network cannot claim a closed world (R1d).
 *  R2  Length caps: 700 characters, with a named, numbered allowlist for the
 *      few catalog-enumerating composites. Nothing over 2,200, ever.
 *  R3  Every input parameter has a description. Absolute in the DEFAULT
 *      profile; a shrink-only ratchet for the gated sets.
 *  R4  A denominated numeric parameter states its unit.
 *  R5  A tool that talks about a chain exposes `chainId` (or `chainIds`), and
 *      every calldata-emitting builder does too.
 *  R6  `proposalId` is one published type per id space, and always described.
 *  R7  A closed choice set is published as an `enum`, built from its runtime
 *      source of truth.
 *  R8  One name per concept: no `poolAddress` without a `govPool` sibling.
 *  R9  No stale env names and no internal jargon in shipped text.
 *  R10 Parameter descriptions stay inside the per-param budget the `tools/list`
 *      byte ceiling (tests/tools/gate.test.ts) is made of.
 *
 * HOW TO SATISFY A FAILURE: fix the text, not the rule. Every exemption is a
 * literal list a reviewer can read, and every ratchet may only shrink.
 */

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../src");

/**
 * Every `server.registerTool(...)` / `server.tool(...)` site in the register
 * files, as {name, file, block}. A block runs from the tool name to the next
 * registration or the next top-level `function` — near enough that a rule can
 * ask "does THIS tool's handler do X" without parsing TypeScript.
 */
function registrationBlocks(): Array<{ name: string; file: string; block: string }> {
  const files = [
    ...readdirSync(resolve(SRC, "tools"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => resolve(SRC, "tools", f)),
    ...readdirSync(resolve(SRC, "governor/tools"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => resolve(SRC, "governor/tools", f)),
  ];
  const out: Array<{ name: string; file: string; block: string }> = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const raw of src.split(/\n\s*server\.(?:registerTool|tool)\(/).slice(1)) {
      const nameMatch = /^\s*"(dexe_[a-z0-9_]+)"/.exec(raw);
      if (!nameMatch) continue;
      const end = raw.search(/\n(?:export )?function /);
      out.push({
        name: nameMatch[1]!,
        file: file.split(/[\\/]/).pop()!,
        block: end === -1 ? raw : raw.slice(0, end),
      });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Effect classification — derived, not hand-listed, so it cannot go stale.
// ──────────────────────────────────────────────────────────────────────────

type Effect = "READ" | "BUILD" | "ACTIONS" | "HTTP" | "BROADCAST" | "REMOTE_WRITE" | "LOCAL_WRITE";

/**
 * Tools that return an HTTP request for the CALLER to send but do not name it
 * `request` in their output schema. Both are auth helpers; only
 * `dexe_auth_login` dispatches.
 */
const HTTP_REQUEST_TOOLS = new Set(["dexe_auth_login_request", "dexe_auth_request_nonce"]);

/**
 * Builders that declare no `outputSchema`, so the shape sniff below cannot see
 * they emit calldata. The six `dexe_gov_build_*` return {to, value, data,
 * selector}; the privacy-policy signer returns EIP-712 typed data to sign.
 */
const BUILD_WITHOUT_OUTPUT_SCHEMA = new Set([
  "dexe_gov_build_propose",
  "dexe_gov_build_vote_cast",
  "dexe_gov_build_queue",
  "dexe_gov_build_execute",
  "dexe_gov_build_delegate",
  "dexe_gov_build_cancel",
]);

function effectOf(tool: Tool): Effect {
  const a = annotationsFor(tool.name);
  // An unclassified tool is its own rule's failure (annotations.test.ts).
  // Treat it as a read here so R1 reports the more useful message.
  if (a?.readOnlyHint === false) {
    if (a.destructiveHint === true) return "BROADCAST";
    if (a.openWorldHint === false) return "LOCAL_WRITE";
    return "REMOTE_WRITE";
  }
  const props = tool.outputSchema?.properties ? Object.keys(tool.outputSchema.properties) : [];
  if (props.includes("request") || HTTP_REQUEST_TOOLS.has(tool.name)) return "HTTP";
  if (props.includes("actions")) return "ACTIONS";
  // `metadata` + `data` is the internal-proposal builder shape: the encoded
  // GovValidators.createInternalProposal argument dexe_proposal_create submits.
  if (
    props.includes("payload") ||
    props.includes("action") ||
    (props.includes("to") && props.includes("data")) ||
    (props.includes("metadata") && props.includes("data"))
  )
    return "BUILD";
  if (BUILD_WITHOUT_OUTPUT_SCHEMA.has(tool.name)) return "BUILD";
  return "READ";
}

/**
 * The closed marker vocabulary. `Read-only, local.` is the accepted, more
 * precise spelling of the read marker for a tool that touches no network.
 */
const EFFECT_MARKER: Record<Effect, RegExp> = {
  READ: /^Read-only(, local)?\.\s/,
  BUILD: /^Builds calldata; does not broadcast\.\s/,
  ACTIONS: /^Builds proposal actions; does not broadcast\.\s/,
  HTTP: /^Builds an HTTP request; does not send it\.\s/,
  BROADCAST: /^Broadcasts when a signer is configured\.\s/,
  REMOTE_WRITE: /^Writes to a remote service\.\s/,
  LOCAL_WRITE: /^Runs locally and writes artifacts\.\s/,
};

const MARKER_TEXT: Record<Effect, string> = {
  READ: "Read-only.",
  BUILD: "Builds calldata; does not broadcast.",
  ACTIONS: "Builds proposal actions; does not broadcast.",
  HTTP: "Builds an HTTP request; does not send it.",
  BROADCAST: "Broadcasts when a signer is configured.",
  REMOTE_WRITE: "Writes to a remote service.",
  LOCAL_WRITE: "Runs locally and writes artifacts.",
};

// ──────────────────────────────────────────────────────────────────────────
// R2 — length
// ──────────────────────────────────────────────────────────────────────────

/**
 * The cap is 700 characters. These enumerate a catalog or a schema that has no
 * other home in a `tools/list`, so each gets a named, numbered allowance
 * instead of a category the next tool can claim. Every number is a ceiling to
 * defend, not headroom to spend.
 */
const LONG_OK: Record<string, number> = {
  dexe_proposal_create: 2000,
  dexe_dao_create: 1100,
  dexe_dao_build_deploy: 1100,
  dexe_agents_fund: 800,
  dexe_safe_propose_tx: 750,
};
// Claude Code keeps 2,048 characters of a tool description and drops the rest
// (docs: "truncates each tool description and each server's instructions at
// 2,048 characters"), so nothing may be allowlisted past it.
const HARD_LENGTH_CEILING = 2048;

// ──────────────────────────────────────────────────────────────────────────
// R4 — units
// ──────────────────────────────────────────────────────────────────────────

/**
 * A parameter name that denominates a quantity. Word-boundary matched so
 * `rewardToken` (an address) and `rewardPeriod` (seconds) do not qualify just
 * for containing `reward`.
 */
const DENOMINATED = /(^|[^a-z])(amount|amounts|supply|balance|value|values|price|cap|fee)($|[^a-z])/i;

/** Any of these counts as having stated the unit. */
const UNIT_PHRASE =
  /raw base units|wei|whole tokens|human units|smallest-unit|\d+-decimal|decimal point|percent|%|seconds|PRECISION/i;

/** Addresses, booleans and flags named like quantities are exempt when they say so. */
const NOT_A_QUANTITY = /address|boolean|contract|true|false|JSON|object|document/i;

// ──────────────────────────────────────────────────────────────────────────
// R9 — banned text
// ──────────────────────────────────────────────────────────────────────────

const BANNED: Array<[RegExp, string]> = [
  // Optional and legacy since the multichain refactor; the server boots with a
  // baked public RPC. `DEXE_RPC_URL_MAINNET` / `_TESTNET` / `_<chainId>` are
  // the live names and are deliberately NOT matched.
  [/DEXE_RPC_URL(?![_A-Z])/, "DEXE_RPC_URL is optional and legacy — name DEXE_RPC_URL_MAINNET / _TESTNET"],
  [/not yet wired/i, "internal status note"],
  [/placeholder until/i, "internal status note"],
  [/\bPhase \d/, "internal phase number"],
  [/\bTODO\b/, "internal marker"],
  [/\bFIXME\b/, "internal marker"],
  [/future enhancement/i, "internal roadmap note"],
  // Pinned by tests/tools/subgraph-chain-explicit.test.ts since 0.30.2; the
  // rule lives here now so there is one place to read it.
  [/env-bound/i, "pre-0.30.2 single-chain claim"],
];

// ──────────────────────────────────────────────────────────────────────────
// R3 — the shrink-only ratchet for undescribed params outside `core`
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parameters in the GATED toolsets that still carry no description, as
 * `<tool>.<path>`. THE ONLY LEGAL DIRECTION FOR THIS LIST IS SHORTER. A new
 * undescribed parameter fails the rule; describing one and deleting its line
 * here is the fix. Default-profile parameters are never allowed in — R3a has
 * no exemptions at all.
 */
const KNOWN_UNDESCRIBED: string[] = [];

describe("tool description & schema lint", () => {
  let full: Tool[];
  let defaultProfile: Tool[];
  let defaultNames: Set<string>;
  const params = new Map<string, ParamEntry[]>();

  beforeAll(async () => {
    full = (await listTools("full")).tools;
    const def = await listTools(undefined);
    defaultProfile = def.tools;
    defaultNames = new Set(def.names);
    for (const t of full) params.set(t.name, collectParams(t));
  });

  // ── R1 ──────────────────────────────────────────────────────────────────
  it("R1: every description opens with the effect marker its annotations imply", () => {
    const offenders: string[] = [];
    for (const t of full) {
      const effect = effectOf(t);
      const desc = t.description ?? "";
      if (!EFFECT_MARKER[effect].test(desc)) {
        offenders.push(
          `${t.name}: expected to start with "${MARKER_TEXT[effect]}" (effect ${effect}), got "${desc.slice(0, 48)}…"`,
        );
      }
    }
    expect(offenders, `descriptions missing their effect marker:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("R1b: no description claims an effect it does not have", () => {
    // A read that opens "Broadcasts…" is the dangerous direction; catch it
    // independently so a marker typo cannot hide it.
    const offenders: string[] = [];
    for (const t of full) {
      const effect = effectOf(t);
      const desc = t.description ?? "";
      if (effect !== "BROADCAST" && /^Broadcasts when a signer/.test(desc)) offenders.push(`${t.name}: does not broadcast`);
      if (effect === "BROADCAST" && /^Read-only/.test(desc)) offenders.push(`${t.name}: broadcasts, but says read-only`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("R1c: a description that names a contract method names one the handler encodes", () => {
    /**
     * The drift this closes, measured on 0.33.1: `dexe_vote_build_vote` said it
     * built `GovPool.vote(...)` while the handler emitted
     * `GovPool.multicall([vote(...)])` — the SphereX shape added in 0.24.1
     * without touching the prose. An agent that decodes the payload before
     * signing sees a selector the description never mentions, and either
     * re-builds by hand (reintroducing the revert) or stalls.
     *
     * Static, because the truth is in the source. A block may encode more than
     * it claims (advisory paths), and may claim more than one method:
     * `dexe_vote_build_execute` legitimately documents both `GovPool.execute`
     * and `GovValidators.executeInternalProposal`.
     */
    const CLAIM = /`([A-Z][A-Za-z0-9]*)\.([A-Za-z0-9_]+)\(/g;
    const ENCODED =
      /(?:method:\s*"([A-Za-z0-9_]+)"|encodeFunctionData\(\s*"([A-Za-z0-9_]+)"|getFunction\(\s*"([A-Za-z0-9_]+)")/g;
    const offenders: string[] = [];

    // `method: "x"` is what buildPayload() puts in the TOP-LEVEL selector; the
    // other two forms also match inner calls a wrapper encodes.
    const TOP_LEVEL = /method:\s*"([A-Za-z0-9_]+)"/g;

    for (const { name, block } of registrationBlocks()) {
      const cut = block.search(/inputSchema:/);
      const head = cut === -1 ? block.slice(0, 2000) : block.slice(0, cut);
      const claimed = new Set<string>();
      for (const m of head.matchAll(CLAIM)) claimed.add(m[2]!);
      if (claimed.size === 0) continue;
      const encoded = new Set<string>();
      for (const m of block.matchAll(ENCODED)) encoded.add((m[1] ?? m[2] ?? m[3])!);
      if (encoded.size === 0) continue; // nothing encoded here to compare against
      const missing = [...claimed].filter((c) => !encoded.has(c));
      if (missing.length === claimed.size) {
        offenders.push(
          `${name}: description names ${[...claimed].join("/")} but the handler encodes ${[...encoded].join("/")}`,
        );
        continue;
      }
      // The half that caught the real defect: `dexe_vote_build_vote` named
      // `GovPool.vote(...)`, which the handler DOES encode — as the inner
      // element of the `multicall` it actually sends. Naming an inner call and
      // staying silent about the selector on the wire is the drift.
      const topLevel = [...block.matchAll(TOP_LEVEL)].map((m) => m[1]!);
      if (topLevel.length > 0 && !topLevel.some((m) => head.includes(m))) {
        offenders.push(
          `${name}: description names ${[...claimed].join("/")} but the selector on the wire is ${[...new Set(topLevel)].join("/")}`,
        );
      }
    }
    expect(offenders, `description/handler method drift:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("R1d: a tool that reaches the network is not annotated as closed-world", () => {
    /**
     * `openWorldHint: false` tells a host the tool's domain is closed — local
     * artifacts, the bundled corpus, pure compute over the arguments. It was
     * wrong for `dexe_graph_schema`, which issues a live GraphQL introspection
     * query against the configured subgraph, and the description then said
     * "local" because the annotation did. Derived from the source so the next
     * one cannot slip through.
     */
    const NETWORK_CALL = /\b(gqlRequest|tryProvider|getProvider)\s*\(/;
    const offenders: string[] = [];
    for (const { name, file, block } of registrationBlocks()) {
      if (annotationsFor(name)?.openWorldHint !== false) continue;
      if (NETWORK_CALL.test(block)) offenders.push(`${name} (${file})`);
    }
    expect(
      offenders,
      `annotated openWorldHint:false but the handler calls out to the network: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  // ── R2 ──────────────────────────────────────────────────────────────────
  it("R2: descriptions stay inside their length cap", () => {
    const offenders: string[] = [];
    for (const t of full) {
      const len = (t.description ?? "").length;
      const cap = LONG_OK[t.name] ?? 700;
      if (len === 0) offenders.push(`${t.name}: no description at all`);
      else if (len > cap) offenders.push(`${t.name}: ${len} > ${cap}`);
      if (len > HARD_LENGTH_CEILING) offenders.push(`${t.name}: ${len} is over the hard ceiling ${HARD_LENGTH_CEILING}`);
    }
    expect(
      offenders,
      `over the length cap — move the detail into dexe_guide or a parameter description:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("R2b: the long-tool allowlist has no stale entries", () => {
    const names = new Set(full.map((t) => t.name));
    const stale = Object.keys(LONG_OK).filter((n) => !names.has(n));
    expect(stale, `LONG_OK names no longer registered: ${stale.join(", ")}`).toEqual([]);
  });

  // ── R3 ──────────────────────────────────────────────────────────────────
  it("R3a: every DEFAULT-profile parameter has a description (no exemptions)", () => {
    const offenders: string[] = [];
    for (const t of defaultProfile) {
      for (const p of collectParams(t)) if (!p.description) offenders.push(`${t.name}.${p.path}`);
    }
    expect(
      offenders,
      `undescribed parameters a zero-config session sees:\n  ${offenders.join("\n  ")}\n` +
        "Say what it is, its unit or encoding, and where to get it. If the text names another tool, " +
        "annotate it `(needs DEXE_TOOLSETS=core,<set>)` unless it is in the default profile — see " +
        "tests/tools/default-profile-references.test.ts.",
    ).toEqual([]);
  });

  it("R3b: undescribed parameters in the gated sets only ever decrease", () => {
    const offenders: string[] = [];
    for (const t of full) {
      if (defaultNames.has(t.name)) continue;
      for (const p of params.get(t.name) ?? []) if (!p.description) offenders.push(`${t.name}.${p.path}`);
    }
    const known = new Set(KNOWN_UNDESCRIBED);
    const added = offenders.filter((o) => !known.has(o));
    expect(added, `NEW undescribed parameters — describe them, do not extend the list:\n  ${added.join("\n  ")}`).toEqual(
      [],
    );
    expect(
      offenders.length,
      `KNOWN_UNDESCRIBED has ${KNOWN_UNDESCRIBED.length} entries but only ${offenders.length} are still undescribed — delete the fixed ones`,
    ).toBe(KNOWN_UNDESCRIBED.length);
  });

  // ── R4 ──────────────────────────────────────────────────────────────────
  it("R4: a denominated numeric parameter states its unit", () => {
    const offenders: string[] = [];
    for (const t of full) {
      for (const p of params.get(t.name) ?? []) {
        const leaf = (p.path.split(".").pop() ?? p.path).replace(/\[\]$/, "");
        if (!DENOMINATED.test(leaf)) continue;
        if (p.type && !["string", "number", "integer", "array"].includes(p.type)) continue;
        if (!p.description) continue; // R3 owns absence
        if (NOT_A_QUANTITY.test(p.description)) continue;
        if (!UNIT_PHRASE.test(p.description)) offenders.push(`${t.name}.${p.path}: "${p.description.slice(0, 70)}"`);
      }
    }
    expect(
      offenders,
      `amount-shaped parameters with no unit — the 10^18 error, waiting:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  // ── R5 ──────────────────────────────────────────────────────────────────
  it("R5: a tool that talks about a chain exposes chainId", () => {
    const CHAIN_TALK = /\bchain \d|\bchainId\b|BSC mainnet|BSC testnet|56 mainnet|97 testnet/;
    const offenders: string[] = [];
    for (const t of full) {
      const top = Object.keys((t.inputSchema?.properties ?? {}) as Record<string, unknown>);
      if (top.includes("chainId") || top.includes("chainIds")) continue;
      const text = [t.description ?? "", ...(params.get(t.name) ?? []).map((p) => p.description)].join(" ");
      if (CHAIN_TALK.test(text)) offenders.push(t.name);
    }
    expect(
      offenders,
      `these name a chain but take no chainId — add the optional param, or stop naming a chain: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("R5b: every calldata-emitting builder takes a chainId", () => {
    /**
     * The `dexe_gov_*` builders resolve the chain from the governor's own
     * bundled config (src/governor/loader.ts), so a chainId param there would
     * be a second, contradictable source of truth. `dexe_proposal_build_offchain`
     * posts to the backend, which files the proposal by its own chain_id field.
     */
    const CHAIN_FROM_CONFIG = /^dexe_gov_(build|hash)_/;
    const offenders: string[] = [];
    for (const t of full) {
      const effect = effectOf(t);
      if (effect !== "BUILD" && effect !== "ACTIONS") continue;
      if (CHAIN_FROM_CONFIG.test(t.name)) continue;
      const top = Object.keys((t.inputSchema?.properties ?? {}) as Record<string, unknown>);
      if (!top.includes("chainId")) offenders.push(t.name);
    }
    expect(offenders, `builders without an optional chainId: ${offenders.join(", ")}`).toEqual([]);
  });

  // ── R6 ──────────────────────────────────────────────────────────────────
  it("R6: every proposalId is described, and names the id space it belongs to", () => {
    /**
     * `proposalId` means three different things on this surface and the same
     * value used to change published type three times inside ONE workflow
     * (dexe_proposal_list → dexe_proposal_state → dexe_vote_build_vote →
     * dexe_proposal_vote_and_execute), with the encoding stated on 2 of 25.
     * The encoding is now stated on all of them, and each text names which of
     * the three id spaces it belongs to:
     *
     *   DeXe pool    — a 1-indexed counter on the GovPool
     *   DeXe backend — the off-chain service's own id, a JSON number
     *   OZ / Bravo   — the keccak-derived uint256 from hashProposal
     */
    const SPACE_PHRASE: Record<string, RegExp> = {
      dexe: /1-indexed/i,
      offchain: /backend/i,
      governor: /hashProposal/i,
    };
    const offenders: string[] = [];
    const types = new Map<string, string[]>();
    for (const t of full) {
      const prop = ((t.inputSchema?.properties ?? {}) as Record<string, { type?: unknown; description?: string }>)
        .proposalId;
      if (!prop) continue;
      const space = t.name.startsWith("dexe_gov_") ? "governor" : /offchain/.test(t.name) ? "offchain" : "dexe";
      const desc = prop.description?.trim() ?? "";
      if (!desc) offenders.push(`${t.name}: no description`);
      else if (!SPACE_PHRASE[space]!.test(desc))
        offenders.push(`${t.name}: does not name the ${space} id space (${SPACE_PHRASE[space]!.source})`);
      const bucket = types.get(space) ?? [];
      bucket.push(`${t.name}:${JSON.stringify(prop.type)}`);
      types.set(space, bucket);
    }
    expect(offenders, `proposalId descriptions:\n  ${offenders.join("\n  ")}`).toEqual([]);

    /**
     * TYPE debt, ratcheted rather than fixed: the DeXe space still publishes
     * three encodings (integer / string|number / string). Collapsing them is
     * NOT a widening, which is why it is not done here — `parseUintString`
     * (src/lib/amount.ts) hard-rejects a non-string, so advertising `number` on
     * the builders would move a clean schema rejection to a runtime throw; and
     * the read tools decode with a bare `BigInt()`, so routing them through
     * `parseUintString` would narrow input that works today. Both belong in a
     * release that can carry the migration note. The number may only go DOWN.
     */
    const DISTINCT_TYPES_ALLOWED: Record<string, number> = { dexe: 3, governor: 1, offchain: 1 };
    for (const [space, entries] of types) {
      const distinct = new Set(entries.map((e) => e.slice(e.indexOf(":") + 1)));
      expect(
        distinct.size,
        `the ${space} id space publishes ${distinct.size} encodings (allowed ${DISTINCT_TYPES_ALLOWED[space]}): ${entries.join(", ")}`,
      ).toBeLessThanOrEqual(DISTINCT_TYPES_ALLOWED[space]!);
    }
  });

  // ── R7 ──────────────────────────────────────────────────────────────────
  it("R7: a closed choice set is published as an enum, from its own source of truth", () => {
    const guide = full.find((t) => t.name === "dexe_guide")!;
    const flow = ((guide.inputSchema?.properties ?? {}) as Record<string, { enum?: string[] }>).flow;
    expect(flow?.enum, "dexe_guide.flow must publish the ids, not prose").toBeDefined();
    expect([...(flow!.enum ?? [])].sort()).toEqual([...FLOWS.map((f) => f.id), ...TOPICS.map((t) => t.id)].sort());

    // A parameter whose description spells out a closed set ("'a' | 'b' | 'c'")
    // while still typed as a free string is the pattern this rule catches.
    const PROSE_CHOICES = /'[a-z_]+'\s*\|\s*'[a-z_]+'\s*\|\s*'[a-z_]+'/;
    const offenders: string[] = [];
    for (const t of full) {
      for (const p of params.get(t.name) ?? []) {
        if (p.type !== "string" || (p.node as { enum?: unknown }).enum) continue;
        if (!PROSE_CHOICES.test(p.description)) continue;
        // `governor` is the one legitimate case: the three bundled ids AND each
        // of those DAOs' own contract addresses resolve, so the value space is
        // not the id list (src/governor/loader.ts, resolveGovernor).
        if (p.path === "governor") continue;
        offenders.push(`${t.name}.${p.path}`);
      }
    }
    expect(offenders, `finite choice sets published as free text: ${offenders.join(", ")}`).toEqual([]);
  });

  // ── R8 ──────────────────────────────────────────────────────────────────
  it("R8: one name per concept — no poolAddress without a govPool sibling", () => {
    const offenders: string[] = [];
    for (const t of full) {
      const top = (t.inputSchema?.properties ?? {}) as Record<string, { description?: string }>;
      if (!("poolAddress" in top)) continue;
      if (!("govPool" in top)) {
        offenders.push(`${t.name}: has poolAddress but no govPool alias (add govPool; never remove poolAddress)`);
        continue;
      }
      if (!top.govPool?.description?.trim()) offenders.push(`${t.name}: govPool is the preferred name and must be described`);
      if (!/deprecated/i.test(top.poolAddress?.description ?? ""))
        offenders.push(`${t.name}: poolAddress must say it is the deprecated alias`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  // ── R9 ──────────────────────────────────────────────────────────────────
  it("R9: no stale env names and no internal jargon in shipped text", () => {
    const offenders: string[] = [];
    for (const t of full) {
      const texts: Array<[string, string]> = [["description", t.description ?? ""]];
      for (const p of params.get(t.name) ?? []) texts.push([p.path, p.description]);
      for (const [where, text] of texts) {
        for (const [re, why] of BANNED) if (re.test(text)) offenders.push(`${t.name}.${where}: ${why}`);
      }
    }
    expect(offenders, `banned text in shipped descriptions:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // ── R10 ─────────────────────────────────────────────────────────────────
  it("R10: parameter descriptions stay inside the byte budget", () => {
    /**
     * `tools/list` for the default profile is capped in tests/tools/gate.test.ts
     * and that cap is a budget, not debt. There are two ways to overspend it,
     * so there are two assertions: one parameter turning into a paragraph, and
     * the sum of all of them creeping up a line at a time. The aggregate is the
     * one that matters — a single long text is sometimes right (the max-uint256
     * allowance example is 78 digits on its own).
     */
    const long: string[] = [];
    let defaultParamChars = 0;
    for (const t of defaultProfile) {
      for (const p of collectParams(t)) {
        defaultParamChars += p.description.length;
        if (p.description.length > 400) long.push(`${t.name}.${p.path}: ${p.description.length} chars`);
      }
    }
    expect(long, `over the 400-char per-parameter cap:\n  ${long.join("\n  ")}`).toEqual([]);
    // Measured at 0.34.0 (21.3k after the backfill that gave every
    // default-profile parameter a description). A ceiling to defend, not
    // headroom to spend: the whole default `tools/list` has ~7 KB of room under
    // the gate.test.ts line, and this is the line item that grows by itself.
    expect(
      defaultParamChars,
      `default-profile parameter descriptions total ${defaultParamChars} chars — trim one before adding one`,
    ).toBeLessThan(22_000);

    const wide: string[] = [];
    for (const t of full) {
      for (const p of params.get(t.name) ?? []) {
        if (p.description.length > 400) wide.push(`${t.name}.${p.path}: ${p.description.length} chars`);
      }
    }
    expect(wide, `over the 400-char hard parameter ceiling:\n  ${wide.join("\n  ")}`).toEqual([]);
  });
});
