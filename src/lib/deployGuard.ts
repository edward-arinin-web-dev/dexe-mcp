import type { Interface } from "ethers";

/**
 * deployGovPool encode → decode round-trip verifier.
 *
 * The `PoolFactory.deployGovPool` argument is a large, deeply-nested tuple that
 * `buildDeployGovPool` encodes POSITIONALLY. A stale ABI, a reordered tuple, or
 * an offset-corrupting mistake in one dynamic sub-field silently shifts later
 * fields — the classic symptom is an empty `name`, which reverts on-chain with
 * `"PoolFactory: pool name cannot be empty"` after burning gas. A param-value
 * guard cannot see this because the corruption happens at ENCODE time.
 *
 * `roundTripDeployCalldata` decodes the freshly-built calldata with the same
 * Interface and asserts every load-bearing field survived — a cheap, offline
 * complement to the B9 eth_call simulation (which only runs at broadcast). It
 * catches positional/field drift immediately, at build time, with a precise
 * field-level diff instead of an opaque revert.
 */

export interface DeployFieldMismatch {
  field: string;
  expected: string;
  got: string;
}

export interface RoundTripResult {
  ok: boolean;
  mismatches: DeployFieldMismatch[];
}

/** Minimal named view of the deployGovPool struct (both the intended object and the decoded Result satisfy this via named access). */
export interface DeployStructView {
  name: unknown;
  descriptionURL: unknown;
  verifier: unknown;
  onlyBABTHolders: unknown;
  votePowerParams: { voteType: unknown; initData: unknown; presetAddress: unknown };
  settingsParams: {
    proposalSettings: ArrayLike<any> & Iterable<any>;
    additionalProposalExecutors: ArrayLike<unknown> & Iterable<unknown>;
  };
  validatorsParams: {
    name: unknown;
    symbol: unknown;
    proposalSettings: { duration: unknown; executionDelay: unknown; quorum: unknown };
    validators: ArrayLike<unknown> & Iterable<unknown>;
    balances: ArrayLike<unknown> & Iterable<unknown>;
  };
  userKeeperParams: { tokenAddress: unknown; nftAddress: unknown; individualPower: unknown; nftsTotalSupply: unknown };
  tokenParams: {
    name: unknown;
    symbol: unknown;
    users: ArrayLike<unknown> & Iterable<unknown>;
    cap: unknown;
    mintedTotal: unknown;
    amounts: ArrayLike<unknown> & Iterable<unknown>;
  };
}

/** Canonicalize a scalar (bigint / ethers v6 numeric / bool / hex / string) so the
 *  intended object (strings) and the ABI-decoded Result (bigints) compare equal. */
function canon(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // ethers v5 BigNumber fallback; v6 returns native bigint (handled above)
    const o = v as { toString(): string; _isBigNumber?: boolean; _hex?: string };
    if (o._isBigNumber || o._hex) return BigInt(o.toString()).toString();
    return String(v);
  }
  const s = String(v);
  return /^0x[0-9a-fA-F]*$/.test(s) ? s.toLowerCase() : s;
}

function extract(p: DeployStructView): Record<string, string> {
  const o: Record<string, string> = {};
  o["name"] = canon(p.name);
  o["descriptionURL"] = canon(p.descriptionURL);
  o["verifier"] = canon(p.verifier);
  o["onlyBABTHolders"] = canon(p.onlyBABTHolders);
  o["votePower.voteType"] = canon(p.votePowerParams.voteType);
  o["votePower.initData"] = canon(p.votePowerParams.initData);
  o["votePower.presetAddress"] = canon(p.votePowerParams.presetAddress);

  Array.from(p.settingsParams.additionalProposalExecutors).forEach((e, i) => {
    o[`executors[${i}]`] = canon(e);
  });
  Array.from(p.settingsParams.proposalSettings).forEach((s: any, i: number) => {
    for (const f of [
      "earlyCompletion",
      "delegatedVotingAllowed",
      "validatorsVote",
      "duration",
      "durationValidators",
      "executionDelay",
      "quorum",
      "quorumValidators",
      "minVotesForVoting",
      "minVotesForCreating",
      "executorDescription",
    ]) {
      o[`ps[${i}].${f}`] = canon(s[f]);
    }
    const ri = s.rewardsInfo ?? {};
    for (const f of ["rewardToken", "creationReward", "executionReward", "voteRewardsCoefficient"]) {
      o[`ps[${i}].rewards.${f}`] = canon(ri[f]);
    }
  });

  const vp = p.validatorsParams;
  o["val.name"] = canon(vp.name);
  o["val.symbol"] = canon(vp.symbol);
  o["val.ps.duration"] = canon(vp.proposalSettings.duration);
  o["val.ps.executionDelay"] = canon(vp.proposalSettings.executionDelay);
  o["val.ps.quorum"] = canon(vp.proposalSettings.quorum);
  Array.from(vp.validators).forEach((v, i) => (o[`val.validators[${i}]`] = canon(v)));
  Array.from(vp.balances).forEach((v, i) => (o[`val.balances[${i}]`] = canon(v)));

  const uk = p.userKeeperParams;
  o["uk.tokenAddress"] = canon(uk.tokenAddress);
  o["uk.nftAddress"] = canon(uk.nftAddress);
  o["uk.individualPower"] = canon(uk.individualPower);
  o["uk.nftsTotalSupply"] = canon(uk.nftsTotalSupply);

  const tp = p.tokenParams;
  o["tp.name"] = canon(tp.name);
  o["tp.symbol"] = canon(tp.symbol);
  o["tp.cap"] = canon(tp.cap);
  o["tp.mintedTotal"] = canon(tp.mintedTotal);
  Array.from(tp.users).forEach((u, i) => (o[`tp.users[${i}]`] = canon(u)));
  Array.from(tp.amounts).forEach((a, i) => (o[`tp.amounts[${i}]`] = canon(a)));

  return o;
}

/**
 * Decode `data` (the built deployGovPool calldata) with `iface`, then assert
 * every load-bearing field equals the `expected` intended struct. Returns the
 * field-level mismatches; empty ⇒ the calldata faithfully encodes the intent.
 *
 * Throws only if `data` cannot be parsed as a deployGovPool call at all (that is
 * itself a fatal encoding error — surface it as "do not broadcast").
 */
export function roundTripDeployCalldata(
  data: string,
  iface: Interface,
  expected: DeployStructView,
): RoundTripResult {
  const parsed = iface.parseTransaction({ data });
  if (!parsed || parsed.name !== "deployGovPool") {
    return {
      ok: false,
      mismatches: [{ field: "<decode>", expected: "deployGovPool(...)", got: parsed?.name ?? "unparseable" }],
    };
  }
  const decoded = parsed.args[0] as unknown as DeployStructView;
  const a = extract(expected);
  const b = extract(decoded);
  const mismatches: DeployFieldMismatch[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ea = a[k] ?? "(absent)";
    const eb = b[k] ?? "(absent)";
    if (ea !== eb) mismatches.push({ field: k, expected: ea, got: eb });
  }
  return { ok: mismatches.length === 0, mismatches };
}
