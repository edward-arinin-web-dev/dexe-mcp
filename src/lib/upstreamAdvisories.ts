/**
 * The shape and constructor of an upstream-protocol advisory, plus the one
 * advisory a READ surface has to show: F15 (the vested leg of a token sale
 * cannot be withdrawn), which dexe_read_token_sale_position prints next to the
 * "withdrawable" number it would otherwise contradict.
 *
 * Every other advisory is about building or sending a transaction and lives in
 * ./protocolAdvisories.ts, which re-exports everything here.
 *
 * `docs/UPSTREAM-ISSUES.md` is the authoritative description of every id used
 * here; keep the two in sync.
 */

/** Path to the authoritative write-up, quoted in every advisory. */
export const UPSTREAM_DOC = "docs/UPSTREAM-ISSUES.md";

export interface UpstreamAdvisory {
  /** Issue id as filed in docs/UPSTREAM-ISSUES.md — "F15", "F12", "#36". */
  readonly id: string;
  /** DANGER = funds or governance can be lost; WARN = the call will just fail. */
  readonly severity: "DANGER" | "WARN";
  /** Where the caller reads the full story. */
  readonly upstream: string;
  /** Ready-to-surface text, already prefixed with its severity marker. */
  readonly text: string;
}

export function upstream(id: string, severity: UpstreamAdvisory["severity"], body: string): UpstreamAdvisory {
  const ref = `${UPSTREAM_DOC} (${id})`;
  return {
    id,
    severity,
    upstream: ref,
    text: `⚠ ${severity} — UPSTREAM PROTOCOL DEFECT ${id} (not a dexe-mcp bug): ${body} See ${ref}.`,
  };
}

// ---------- F15 — TokenSaleProposal.vestingWithdraw is blocked (funds-loss) --

/**
 * F15: on every SphereX-era pool, `vestingWithdraw` reverts in EVERY call shape
 * (raw and multicall-wrapped — the DeXe frontend uses only those two, so the
 * official UI fails identically). A tier opened with `vestingPercentage > 0`
 * therefore strands its vested allocation permanently. `claim` (the instant
 * portion) still works.
 */
export const VESTING_WITHDRAW_ADVISORY = upstream(
  "F15",
  "DANGER",
  "TokenSaleProposal.vestingWithdraw reverts \"SphereX error: disallowed tx pattern\" in every call shape on " +
    "current pools, so the VESTED portion of a purchase can never be withdrawn — the tokens are stranded, with " +
    "no client-side workaround. Only `claim` (the instant portion) works. Open tiers with vestingPercentage " +
    "\"0\" and hold back the remainder off-chain, or wait for the protocol fix.",
);
