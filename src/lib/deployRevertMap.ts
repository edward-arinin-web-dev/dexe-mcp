/**
 * Deploy revert knowledge base — maps every known `deployGovPool` revert
 * string to its cause and a concrete fix. Consumed by three surfaces so the
 * calling model never has to research a revert:
 *   - the pre-sign simulation verdict (src/lib/deploySim.ts)
 *   - the post-broadcast failure path in dexe_dao_create
 *   - the revert table in docs/PLAYBOOK.md (mirrored manually)
 *
 * Provenance: every `match` string is verified against the DeXe-Protocol
 * contract sources (D:/dev/DeXe-Protocol, commit-independent require strings)
 * — file:line noted per entry. Order matters: first match wins, so more
 * specific strings go before generic ones.
 */

export interface DeployRevertEntry {
  /** Matched case-insensitively against the raw revert reason / error text. */
  match: RegExp;
  /** Stable slug (used in PLAYBOOK table and structuredContent). */
  slug: string;
  /** What went wrong, in user terms. */
  cause: string;
  /** Concrete next step the calling model can apply verbatim. */
  fix: string;
}

export const DEPLOY_KNOWN_REVERTS: readonly DeployRevertEntry[] = [
  {
    // PoolFactory.sol:317
    match: /pool name cannot be empty/i,
    slug: "name-empty",
    cause: "The encoded calldata carries an empty DAO name (encode-time field drift or a blank daoName input).",
    fix:
      "Pass a non-empty daoName. If the input was non-empty, the calldata encoding drifted — run dexe_compile to " +
      "refresh the PoolFactory ABI and re-run; the round-trip self-check will pinpoint the shifted field.",
  },
  {
    // PoolFactory.sol:318
    match: /pool name is already taken/i,
    slug: "name-taken",
    cause: "This deployer already deployed a DAO with this exact name on this chain (create2 salt = deployer + name).",
    fix: "Pick a different daoName (any change works) and re-run. The old pool keeps its name forever.",
  },
  {
    // PoolFactory.sol:187
    match: /unexpected pool address/i,
    slug: "predicted-address-drift",
    cause:
      "The factory's create2 result did not match its own prediction — usually a protocol upgrade landed between " +
      "prediction and deploy.",
    fix: "Re-run the deploy (addresses are re-predicted each build). If it persists, the factory contract changed — run dexe_compile and retry.",
  },
  {
    // PoolFactory.sol:306
    match: /power init failed/i,
    slug: "vote-power-init",
    cause: "The VotePower contract rejected its init call (wrong initData selector/args for the chosen voteType).",
    fix:
      "Do not override votePower.initData — the builder auto-encodes __LinearPower_init() (LINEAR) and " +
      "__PolynomialPower_init(c1,c2,c3) (POLYNOMIAL). For CUSTOM, verify presetAddress points at a compatible " +
      "vote-power contract and initData matches its init function.",
  },
  {
    // PoolFactory.sol:179 — wraps any revert inside the gov-token init call.
    match: /can't initialize token/i,
    slug: "token-init-failed",
    cause:
      "The gov token's init reverted inside the factory (the inner reason is swallowed). Usual causes: cap/mintedTotal " +
      "conflict or users/amounts mismatch.",
    fix:
      "Check tokenParams: cap > 0, cap ≥ mintedTotal, users.length == amounts.length, sum(amounts) ≤ mintedTotal. " +
      "The dexe_dao_create preflights verify all of these — prefer it over hand-built params.",
  },
  {
    // OZ ERC20CappedUpgradeable via ERC20Gov.sol:37 (__ERC20Capped_init)
    match: /ERC20Capped: cap is 0/i,
    slug: "cap-zero",
    cause: "tokenParams.cap is 0 — the gov token is ERC20Capped and has no uncapped mode.",
    fix: "Set cap ≥ mintedTotal (cap == mintedTotal is a valid fixed supply).",
  },
  {
    // ERC20Gov.sol:41-43
    match: /mintedTotal should not be greater than cap/i,
    slug: "cap-lt-minted",
    cause: "tokenParams.mintedTotal exceeds tokenParams.cap.",
    fix: "Raise cap to ≥ mintedTotal, or lower mintedTotal.",
  },
  {
    // ERC20Gov.sol:56
    match: /ERC20Gov: overminting/i,
    slug: "over-distribution",
    cause: "sum(tokenParams.amounts) exceeds mintedTotal — recipients were given more than the total mint.",
    fix: "Lower the recipient amounts or raise mintedTotal (treasury = mintedTotal − sum(amounts) must be ≥ 0).",
  },
  {
    // ERC20Gov.sol:45-47
    match: /users and amounts lengths mismatch/i,
    slug: "users-amounts-mismatch",
    cause: "tokenParams.users and tokenParams.amounts have different lengths.",
    fix: "Provide exactly one amount per recipient address.",
  },
  {
    // GovSettings.sol:95-105 (_validateProposalSettings)
    match: /GovSettings: invalid (validator )?(vote duration|quorum) value/i,
    slug: "settings-bounds",
    cause:
      "A proposalSettings entry violates contract bounds: duration > 0, durationValidators > 0, " +
      "0 < quorum ≤ 1e27, quorumValidators ≤ 1e27.",
    fix:
      "Fix the offending settings value. Remember the DeXe percentage scale: 1% = 1e25, 100% = 1e27; " +
      "durations are seconds and must be > 0.",
  },
  {
    // GovUserKeeper.sol:82
    match: /GovUK: zero addresses/i,
    slug: "userkeeper-asset",
    cause: "Neither a governance token nor an NFT was configured for the UserKeeper.",
    fix:
      "Set userKeeperParams.tokenAddress (existing ERC20), userKeeperParams.nftAddress (existing ERC721), " +
      "or tokenParams.name to create a new gov token.",
  },
  {
    // GovValidatorsUtils.sol:63-76 (validateProposalSettings / validateChangeBalances)
    match: /Validators: (duration is zero|invalid quorum value|invalid array length|invalid address)/i,
    slug: "validators-init",
    cause:
      "validatorsParams failed contract validation: proposalSettings.duration > 0, 0 < quorum ≤ 1e27, " +
      "validators.length == balances.length, no zero addresses.",
    fix: "Fix validatorsParams (durations in seconds, quorum at 1e25-per-percent scale, one balance per validator).",
  },
  {
    // SphereX protection on new protocol deployments (bug #35 family).
    match: /SphereX error|disallowed tx pattern/i,
    slug: "spherex-pattern",
    cause: "The protocol's SphereX guard rejected the transaction pattern (it profiles calls on fresh contracts).",
    fix:
      "Do not batch/multicall around the factory — send deployGovPool as a plain single transaction (dexe_dao_create " +
      "already does). If it persists, re-run once; repeated rejection means the protocol operator must allowlist the pattern.",
  },
  {
    match: /insufficient funds for (gas|intrinsic|transfer)/i,
    slug: "no-gas",
    cause: "The deployer wallet cannot cover gas for the deploy.",
    fix:
      "Fund the deployer with BNB on the target chain (testnet 97: https://www.bnbchain.org/en/testnet-faucet). " +
      "A GovPool deploy needs ~0.01-0.03 BNB on BSC at 2026 gas levels.",
  },
] as const;

/** Verdict of classifying a raw revert reason against the knowledge base. */
export interface DeployRevertVerdict {
  slug: string;
  cause: string;
  fix: string;
  /** True when the reason matched a known entry (false → opaque fallback). */
  known: boolean;
}

/**
 * Classify a deploy revert reason. Always returns a verdict — unknown/empty
 * reasons get the `opaque` fallback listing the likely silent-revert causes
 * (bounds violations revert with empty reasons on some RPCs).
 */
export function mapDeployRevert(reason: string | undefined | null): DeployRevertVerdict {
  const raw = (reason ?? "").trim();
  if (raw.length > 0) {
    const hit = DEPLOY_KNOWN_REVERTS.find((e) => e.match.test(raw));
    if (hit) return { slug: hit.slug, cause: hit.cause, fix: hit.fix, known: true };
  }
  return {
    slug: "opaque",
    known: false,
    cause: raw.length > 0 ? `Unrecognized revert reason: "${raw}".` : "The deploy reverted without a reason string.",
    fix:
      "Likely causes, in order: (1) settings bounds — duration/durationValidators > 0, 0 < quorum ≤ 1e27; " +
      "(2) name already taken by this deployer; (3) cap/mintedTotal conflict; (4) validator params invalid. " +
      "All are checked by dexe_dao_create's preflights — re-run through it rather than hand-building params, " +
      "and run dexe_compile if the ABI may be stale.",
  };
}
