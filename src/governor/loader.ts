import uniswap from "./configs/uniswap.json" with { type: "json" };
import compound from "./configs/compound.json" with { type: "json" };
import optimism from "./configs/optimism.json" with { type: "json" };

/**
 * Per-DAO Governor config. Source of truth lives in src/governor/configs/*.json
 * and is imported here so `tsc` bundles the JSON into dist without an extra
 * copy step. To add a new DAO: drop a JSON file in configs/, add an import
 * line below, and append to ALL_CONFIGS.
 */
export interface GovernorConfig {
  id: string;
  chainId: number;
  governorAddress: string;
  governorVersion: "oz-v4" | "oz-v5" | "bravo-v3";
  votingToken: {
    type: "ERC20Votes" | "ERC20VotesComp";
    address: string;
    symbol: string;
    decimals: number;
  };
  timelock?: { address: string; minDelay: number };
  votingParams: {
    votingDelay: number;
    votingPeriod: number;
    proposalThreshold?: string;
    quorumNumerator: number;
    quorumDenominator: number;
  };
  executor: { type: "timelock" | "governor-self"; id?: string | null };
  /**
   * How `readQuorum` derives quorum for OZ-family governors. Omitted / "governor"
   * → vanilla `quorum(blockNumber)`. "votable-supply" → OP-style governors whose
   * `quorum(uint256)` is keyed by proposalId; quorum is computed as
   * `votableSupply(block) * quorumNumerator / quorumDenominator`. Ignored for Bravo.
   */
  quorumSource?: "governor" | "votable-supply";
  explorer?: { etherscanBase?: string; tallyOrgSlug?: string };
  notes?: string;
}

const RAW_CONFIGS: unknown[] = [uniswap, compound, optimism];

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function assertAddress(label: string, v: unknown): asserts v is string {
  if (typeof v !== "string" || !ADDR_RE.test(v)) {
    throw new Error(`governor config: ${label} must be a 0x-prefixed 20-byte address, got ${String(v)}`);
  }
}

export function validateGovernorConfig(raw: unknown, source: string): GovernorConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`governor config ${source}: root must be an object`);
  }
  const o = raw as Record<string, any>;
  if (typeof o.id !== "string" || !/^[a-z0-9-]+$/.test(o.id)) {
    throw new Error(`governor config ${source}: id must match /^[a-z0-9-]+$/`);
  }
  if (typeof o.chainId !== "number" || o.chainId < 1) {
    throw new Error(`governor config ${source}: chainId must be a positive integer`);
  }
  assertAddress(`${source}.governorAddress`, o.governorAddress);
  const version = o.governorVersion ?? "oz-v4";
  if (!["oz-v4", "oz-v5", "bravo-v3"].includes(version)) {
    throw new Error(`governor config ${source}: governorVersion must be oz-v4|oz-v5|bravo-v3`);
  }
  const vt = o.votingToken;
  if (!vt || typeof vt !== "object") throw new Error(`${source}: votingToken missing`);
  assertAddress(`${source}.votingToken.address`, vt.address);
  if (!["ERC20Votes", "ERC20VotesComp"].includes(vt.type)) {
    throw new Error(`${source}: votingToken.type must be ERC20Votes|ERC20VotesComp`);
  }
  if (typeof vt.symbol !== "string") throw new Error(`${source}: votingToken.symbol missing`);
  const decimals = typeof vt.decimals === "number" ? vt.decimals : 18;

  if (o.timelock !== undefined) {
    assertAddress(`${source}.timelock.address`, o.timelock?.address);
    if (typeof o.timelock?.minDelay !== "number") {
      throw new Error(`${source}: timelock.minDelay must be a number (seconds)`);
    }
  }

  const vp = o.votingParams;
  if (!vp || typeof vp !== "object") throw new Error(`${source}: votingParams missing`);
  if (typeof vp.votingDelay !== "number") throw new Error(`${source}: votingParams.votingDelay missing`);
  if (typeof vp.votingPeriod !== "number") throw new Error(`${source}: votingParams.votingPeriod missing`);
  if (typeof vp.quorumNumerator !== "number") {
    throw new Error(`${source}: votingParams.quorumNumerator missing`);
  }

  const ex = o.executor;
  if (!ex || typeof ex !== "object") throw new Error(`${source}: executor missing`);
  if (!["timelock", "governor-self"].includes(ex.type)) {
    throw new Error(`${source}: executor.type must be timelock|governor-self`);
  }

  if (o.quorumSource !== undefined && !["governor", "votable-supply"].includes(o.quorumSource)) {
    throw new Error(`${source}: quorumSource must be governor|votable-supply`);
  }

  return {
    id: o.id,
    chainId: o.chainId,
    governorAddress: o.governorAddress,
    governorVersion: version,
    votingToken: { type: vt.type, address: vt.address, symbol: vt.symbol, decimals },
    timelock: o.timelock,
    votingParams: {
      votingDelay: vp.votingDelay,
      votingPeriod: vp.votingPeriod,
      proposalThreshold: vp.proposalThreshold,
      quorumNumerator: vp.quorumNumerator,
      quorumDenominator: typeof vp.quorumDenominator === "number" ? vp.quorumDenominator : 100,
    },
    executor: { type: ex.type, id: ex.id ?? null },
    quorumSource: o.quorumSource,
    explorer: o.explorer,
    notes: o.notes,
  };
}

let cache: Map<string, GovernorConfig> | null = null;

export function loadGovernorConfigs(): Map<string, GovernorConfig> {
  if (cache) return cache;
  const out = new Map<string, GovernorConfig>();
  for (const raw of RAW_CONFIGS) {
    const id = typeof (raw as any)?.id === "string" ? (raw as any).id : "<anonymous>";
    const cfg = validateGovernorConfig(raw, `configs/${id}.json`);
    if (out.has(cfg.id)) throw new Error(`governor config: duplicate id "${cfg.id}"`);
    out.set(cfg.id, cfg);
  }
  cache = out;
  return cache;
}

export function resolveGovernor(idOrAddress: string): GovernorConfig {
  const configs = loadGovernorConfigs();
  const lower = idOrAddress.toLowerCase();
  for (const cfg of configs.values()) {
    if (cfg.id === idOrAddress || cfg.governorAddress.toLowerCase() === lower) return cfg;
  }
  const known = [...configs.keys()].join(", ") || "(none)";
  throw new Error(`unknown governor "${idOrAddress}"; known ids: [${known}]`);
}
