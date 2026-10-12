import { safeErrorMessage } from "./redact.js";
import { renderUntrusted } from "./sanitize.js";

/**
 * Actionable-error layer (v0.22). Every catch-all in the composite flows, the
 * read tools, and the `dexe_tx_send` broadcast routes through
 * `toActionableError` so the model/user gets "what happened + what to do next"
 * instead of a raw ethers dump. The remedy tables are exported so
 * `npm run gen:knowledge` renders them into docs/PLAYBOOK.md — one source
 * (drift-checked by gen:knowledge:check in prepublishOnly).
 *
 * TWO TABLES. This file holds the failures a read can hit, with remedies that
 * only ever point at reads: retry, check an input, use another read tool, fix
 * the endpoint. Write code (src/lib/writeErrors.ts) registers its own table
 * through `registerKnownFailures`: the failures only signing, broadcasting or
 * pinning can raise (gas, nonce, wallet, Pinata), plus its own wording for
 * shared failures whose write-side remedy differs (a timed-out receipt wait,
 * the resume rule after a revert). It registers that table when it loads, so
 * in the single server — which loads it with every write tool —
 * `toActionableError` classifies and words every failure exactly as one
 * combined table would; a read-only server never loads it and never hands a
 * caller write advice.
 *
 * `toActionableError` goes through `safeErrorMessage`, so it is also a safe
 * sink for the W36 credential leak: no call site that uses it can print a keyed
 * RPC URL. Reaching for the raw `err.message` instead is what
 * tests/lib/no-raw-error-echo.test.ts exists to stop.
 *
 * TOOL NAMES IN `remedy` ARE A PROMISE. These strings are read by a model that
 * will immediately call whatever they name, and the default `DEXE_TOOLSETS`
 * profile is a subset of the surface (v0.31.0 narrowed it to `core`). A remedy
 * that names a gated tool without saying so sends a zero-config session to a
 * 404 — worse than no advice, because it is confident. Rule: prefer a tool the
 * default profile has; when only a gated one will do, append
 * `(needs DEXE_TOOLSETS=core,<set>)` right after the name — the same convention
 * the knowledge layer and the subgraph tool descriptions use, and the one
 * tests/tools/default-profile-references.test.ts enforces for `tools/list`.
 */

export interface KnownFailure {
  /** Matched against the raw error message (case-insensitive). */
  match: RegExp;
  /** Stable slug used in PLAYBOOK's error→remedy table. */
  slug: string;
  /** One-sentence statement of what went wrong, in user terms. */
  what: string;
  /** Concrete next step ("do X"), tool names included. */
  remedy: string;
}

/**
 * Known failure signatures a READ can hit. Order matters — first match wins.
 * Keep `what`/`remedy` self-contained: they are shown without the surrounding
 * code context. Remedies here name read tools and read-side settings only; the
 * write-side wording of the shared entries is in src/lib/writeErrors.ts.
 */
export const READ_KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    // MUST precede `subgraph-failed`: the orphan fault's message also matches
    // `Subgraph errors:`, and the generic remedy there says "re-run once
    // (429/5xx/timeouts are usually transient)" — which is the one thing that
    // cannot help here. This fault is DETERMINISTIC: the indexer never
    // populated a relation, GraphQL non-null propagation annihilates the whole
    // document, and every retry returns the identical error.
    match: /Null value resolved for non-null field|expected prefetched result, but found nothing/i,
    slug: "subgraph-orphan-relation",
    what:
      "The indexer never populated a relation this query selects, so the gateway rejected the WHOLE document — including the healthy fields in it. Deterministic: retrying returns the identical error, and an empty answer here is NOT 'the DAO has none'.",
    remedy:
      "Do NOT retry — it will fail identically. The DAO-level reads already drop the broken relation and answer " +
      "anyway with `indexerWarning` / `degraded` set (dexe_read_dao_members, dexe_read_dao_experts, " +
      "dexe_proposal_voters, dexe_dao_report), so prefer those over a hand-written dexe_graph_query. " +
      "For a hand-written query, remove the named relation from the selection set (leave at least one " +
      "unconditional field in its parent) and re-send. On-chain reads are unaffected: dexe_proposal_list / " +
      "dexe_read_settings / dexe_dao_info need no indexer at all.",
  },
  {
    // Every subgraph failure funnels through the `Subgraph …` messages in
    // src/lib/subgraph.ts. Must precede `rpc-flaky`, which would otherwise
    // claim the 429 variant and blame the RPC instead of the indexer.
    match: /\bSubgraph (HTTP \d{3}|errors:|returned empty data|request to )/i,
    slug: "subgraph-failed",
    what:
      "The subgraph (indexer) failed, so this read returned NO data — that is NOT the same as 'the DAO has none'. Do not report an empty result.",
    // No profile hints here: the read server registers every read tool. The
    // single server words this with its DEXE_TOOLSETS hints (lib/writeErrors.ts).
    remedy:
      "Re-run once (429/5xx/timeouts are usually transient). If it persists, read the same facts on-chain instead — " +
      "dexe_proposal_list / dexe_read_settings / dexe_dao_info need no indexer; dexe_read_gov_state and " +
      "dexe_read_multicall cover the rest. " +
      "A 401/403/429 on the shipped default endpoint means you are sharing the packaged Graph key: get a free one at " +
      "thegraph.com/studio, set DEXE_SUBGRAPH_POOLS_URL / _VALIDATORS_URL / _INTERACTIONS_URL in .env, and restart. " +
      "Entity/field names for a hand-written query: call dexe_graph_schema (live introspection) " +
      "or read the dexe://graph-schema resource.",
  },
  {
    // MUST precede `backend-failed`. A 400 is the caller's argument being
    // refused, not the service being down, so every clause of the generic
    // backend remedy ("wait and retry", "a 401 means the token expired") is
    // wrong here — and the only 400-able argument these reads take is the
    // continuation cursor. `backendGetJson` deliberately phrases this one
    // without the literal "backend HTTP 400" so it cannot fall through.
    match: /DeXe backend rejected the request: HTTP 400/i,
    slug: "backend-page-token-rejected",
    what:
      "The DeXe backend refused the request as malformed (HTTP 400) — on a paginated read that is almost always the `pageToken`: cursors are opaque, single-use and bound to the query that produced them.",
    remedy:
      "Do NOT retry with the same pageToken — it will be refused identically. Re-run the call WITHOUT pageToken to " +
      "start the listing again from page 1, then page forward using only the `nextPageToken` that THIS call " +
      "returned. A cursor from a different token/holder/chainId/pageSize, or one edited or re-wrapped by hand, is " +
      "not valid here. If you passed no pageToken, the rejected argument is another one: check the address is " +
      "checksummed-or-lowercase hex and that pageSize is 1-100.",
  },
  {
    // DeXe backend (api.dexe.io) — treasury/NFT/holder reads and the off-chain
    // proposal + auth surface.
    match: /backend HTTP \d{3}|backend request timed out|DeXe backend[^\n]{0,40}(failed|unreachable)/i,
    slug: "backend-failed",
    what:
      "The DeXe backend API (api.dexe.io) failed or timed out — the enriched answer (USD prices, token discovery, off-chain proposals) is unavailable.",
    remedy:
      "Re-run the call: tools that can fall back serve the same call on-chain and report `degraded: true` (no token auto-discovery, no USD). " +
      "Off-chain proposal data has no on-chain fallback — the backend is its system of record, so wait and retry. " +
      "Point DEXE_BACKEND_API_URL at another host only if you run your own.",
  },
  {
    // A deadline fired. Distinct from `rpc-flaky`: the endpoint did not refuse
    // us, it went silent, and the fix is a different endpoint far more often
    // than a retry. Must precede `rpc-flaky` (which also matches ETIMEDOUT).
    match: /timed out after \d|\bETIMEDOUT\b|\bAbortError\b|operation was aborted|aborted due to timeout/i,
    slug: "rpc-timeout",
    what:
      "The endpoint accepted the connection and then went silent until the deadline fired. The call was abandoned, not answered.",
    remedy:
      "No state was changed by a timed-out read — re-run it. A public endpoint that keeps stalling will not improve: " +
      "set your own DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET (Alchemy/QuickNode/Ankr) in .env and restart.",
  },
  {
    match: /rate.?limit|\b429\b|SERVER_ERROR|could not detect network|failed to fetch|fetch failed|ETIMEDOUT|ECONNRESET/i,
    slug: "rpc-flaky",
    what: "The RPC endpoint failed or rate-limited mid-call (retries were already attempted).",
    remedy:
      "Re-run the call — a read changes nothing, so a retry is safe. For reliability set a private endpoint " +
      "in .env (DEXE_RPC_URL_MAINNET / DEXE_RPC_URL_TESTNET, e.g. Alchemy/QuickNode/Ankr) and restart.",
  },
  {
    match: /execution reverted|CALL_EXCEPTION|transaction failed|status.*0\b/i,
    slug: "onchain-revert",
    what: "The contract call reverted on-chain (nothing was changed).",
    remedy:
      "Read the revert reason above if present. On a read the usual causes are an address that is not the " +
      "contract the tool expects (check it with dexe_dao_registry_lookup or dexe_dao_info), a proposal id that " +
      "does not exist yet or is in a state the call does not accept (check dexe_proposal_list / " +
      "dexe_proposal_state), or the wrong chain (pass the DAO's chainId). Fix the input and re-run.",
  },
] as const;

/**
 * Another edition's wording for a failure the read table already classifies:
 * same slug, same `match`, its own `what` / `remedy`.
 */
export interface KnownFailureWording {
  what?: string;
  remedy: string;
}

/** What write code registers on top of the read table. */
export interface KnownFailureRegistration {
  /**
   * Failures no read can raise (gas, nonce, wallet, Pinata). Matched BEFORE
   * every read entry, in this order. A slug the read table already has is
   * refused: a second `match` would change which failures that slug claims —
   * reword it with `wording` instead.
   */
  failures?: readonly KnownFailure[];
  /** Write-side wording for shared failures, keyed by read slug. */
  wording?: Readonly<Record<string, KnownFailureWording>>;
}

/**
 * The read table with a registration applied: registered failures first, then
 * every read entry in order, reworded where the registration says so. Pure —
 * `registerKnownFailures` applies it to the live table, `gen:knowledge` to the
 * one it renders. Throws on a registration that would change a classification.
 */
export function mergeKnownFailures(
  base: readonly KnownFailure[],
  reg: KnownFailureRegistration,
): readonly KnownFailure[] {
  const baseSlugs = new Set(base.map((k) => k.slug));
  for (const f of reg.failures ?? []) {
    if (baseSlugs.has(f.slug)) {
      throw new Error(
        `registerKnownFailures: '${f.slug}' is already classified by the read table — pass its wording, not a second entry.`,
      );
    }
  }
  const wording = reg.wording ?? {};
  for (const slug of Object.keys(wording)) {
    if (!baseSlugs.has(slug)) {
      throw new Error(`registerKnownFailures: no read failure '${slug}' to reword — register it as a failure instead.`);
    }
  }
  return [
    ...(reg.failures ?? []),
    ...base.map((k) => {
      const w = wording[k.slug];
      return w ? { ...k, what: w.what ?? k.what, remedy: w.remedy } : k;
    }),
  ];
}

/** Everything registered so far. Re-registering a slug replaces it in place. */
const registeredFailures: KnownFailure[] = [];
const registeredWording = new Map<string, KnownFailureWording>();
let activeTable: readonly KnownFailure[] = READ_KNOWN_FAILURES;

/**
 * Add another edition's failures and wording to the table `toActionableError`
 * uses by default. src/lib/writeErrors.ts registers the write table when it
 * loads, so it is in force in any process that runs write code. Idempotent:
 * registering the same table again changes nothing.
 */
export function registerKnownFailures(reg: KnownFailureRegistration): void {
  const failures = [...registeredFailures];
  for (const f of reg.failures ?? []) {
    const at = failures.findIndex((x) => x.slug === f.slug);
    if (at >= 0) failures[at] = f;
    else failures.push(f);
  }
  const wording = new Map(registeredWording);
  for (const [slug, w] of Object.entries(reg.wording ?? {})) wording.set(slug, w);
  // Validate the whole result before touching the live table.
  activeTable = mergeKnownFailures(READ_KNOWN_FAILURES, { failures, wording: Object.fromEntries(wording) });
  registeredFailures.splice(0, registeredFailures.length, ...failures);
  registeredWording.clear();
  for (const [slug, w] of wording) registeredWording.set(slug, w);
}

/** The table `toActionableError` classifies against right now. */
export function knownFailures(): readonly KnownFailure[] {
  return activeTable;
}

/** Result of classifying an unknown error against the known-failure table. */
export interface ActionableError {
  message: string;
  slug?: string;
}

/**
 * Wrap a caught error with step context and, when the signature is recognized,
 * a concrete remedy. Falls back to the redacted raw message so nothing is lost.
 * Classifies against the registered table (`knownFailures()`) unless a table is
 * passed.
 */
export function toActionableError(
  err: unknown,
  step?: string,
  table: readonly KnownFailure[] = knownFailures(),
): ActionableError {
  const raw = safeErrorMessage(err);
  const hit = table.find((k) => k.match.test(raw));
  const prefix = step ? `${step} failed: ` : "";
  if (!hit) return { message: `${prefix}${raw}` };
  return {
    slug: hit.slug,
    message: `${prefix}${raw}\n\n${hit.what}\nNext step: ${hit.remedy}`,
  };
}

/** Cap for a revert string: long enough for every real one, short enough that a hostile one cannot flood the context. */
const REVERT_REASON_MAX = 500;

/**
 * A contract's `Error(string)` payload is written by whoever deployed that
 * contract, and a DAO proposal action can name ANY target — so a revert reason
 * is third-party content, not diagnostics. Until 0.34.0 it was interpolated raw
 * into the B9 pre-broadcast guard's abort message, i.e. into text the model
 * reads at the exact moment it decides whether to retry a broadcast, with its
 * newlines, zero-width characters and bidi overrides intact.
 *
 * `renderUntrusted` NFKC-normalizes, escapes control characters to a visible
 * `\xNN`, strips zero-width / bidi marks, defangs fence markers and flags
 * non-ASCII. Server-authored strings must NOT go through here: escaping our own
 * newlines (the public-RPC onboarding hint, for instance) degrades the very
 * message we meant to show.
 */
export function sanitizeRevertReason(raw: unknown, fallback = "unknown"): string {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const rendered = renderUntrusted(raw, REVERT_REASON_MAX);
  return rendered.length > 0 ? rendered : fallback;
}
