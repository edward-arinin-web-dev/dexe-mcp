/**
 * Fixture-allowlist guards — pure decision helpers plus one RPC factory.
 * Side-effect-free at import: no `main()`, no `process.exit`, no env reads.
 *
 * WHY: every composite refuses a DAO that PoolRegistry does not know
 * (`refuseIfNotGovPool` in src/tools/flow.ts — the W10 guard), and the chain-97
 * protocol has been redeployed since the current fixtures were minted. Nothing
 * in the harness checked registration, so the failure surfaced 13 times, one
 * scenario at a time, 40 minutes into a broadcast sweep, as
 * `Refusing: 0x… is not a registered DeXe GovPool`.
 *
 * The guard must be LOUD and EARLY, and it must fail OPEN — mirroring the
 * MCP-side `catch { return; }` — so a flaky RPC never blocks a valid run.
 */

import { Contract, JsonRpcProvider } from "ethers";
import { AddressBook, CONTRACT_NAMES } from "../../src/lib/addresses.js";

const IS_GOV_POOL_ABI = ["function isGovPool(address) view returns (bool)"] as const;
const TOKEN_ADDRESS_ABI = ["function tokenAddress() view returns (address)"] as const;
const HELPERS_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
] as const;

export type IsGovPoolFn = (dao: string) => Promise<boolean>;
export type GovTokenFn = (dao: string) => Promise<string>;

/**
 * Canonical registry resolver.
 *
 * NEVER derive the registry from the pool itself. A de-registered pool still
 * self-reports its OLD registry via `getHelperContracts()[3]`, and that old
 * registry still answers `isGovPool == true` for it — so the obvious
 * implementation green-lights exactly the fixture this guard exists to catch.
 * Resolve POOL_REGISTRY through ContractsRegistry, the same path
 * `src/tools/flow.ts` and `src/tools/dao.ts` take.
 */
export async function makeIsGovPool(
  provider: JsonRpcProvider,
  chainId: number,
): Promise<IsGovPoolFn> {
  const book = new AddressBook({ provider, chainId });
  const registryAddr = await book.resolve(CONTRACT_NAMES.POOL_REGISTRY);
  const reg = new Contract(registryAddr, IS_GOV_POOL_ABI as unknown as string[], provider);
  return (dao: string) => reg.getFunction("isGovPool").staticCall(dao) as Promise<boolean>;
}

/** Reads `GovPool → GovUserKeeper.tokenAddress()` — the DAO's gov ERC20. */
export function makeGovTokenReader(provider: JsonRpcProvider): GovTokenFn {
  return async (dao: string) => {
    const gp = new Contract(dao, HELPERS_ABI as unknown as string[], provider);
    const helpers = (await gp.getFunction("getHelperContracts").staticCall()) as string[];
    const uk = new Contract(String(helpers[1]), TOKEN_ADDRESS_ABI as unknown as string[], provider);
    return String(await uk.getFunction("tokenAddress").staticCall());
  };
}

export interface RegistrationVerdict {
  /** Allowlisted DAOs PoolRegistry does not recognize. */
  unregistered: string[];
  /** false ⇒ the check could not run (registry unresolvable / RPC flake). */
  verified: boolean;
}

/**
 * Fail-OPEN: ANY throw returns `{unregistered: [], verified: false}` and the
 * caller continues with a warning. Never throws.
 */
export async function checkDaosRegistered(
  daos: string[],
  isGovPool: IsGovPoolFn,
): Promise<RegistrationVerdict> {
  const unregistered: string[] = [];
  for (const d of daos) {
    let ok: boolean;
    try {
      ok = await isGovPool(d);
    } catch {
      return { unregistered: [], verified: false };
    }
    if (!ok) unregistered.push(d);
  }
  return { unregistered, verified: true };
}

/** The remediation text an operator sees. Names the fix, not just the fact. */
export function unregisteredFixtureMessage(
  addr: string,
  index: number,
  chainTag: string,
  chainId: number,
): string {
  return (
    `SWARM_DAOS_${chainTag}[${index}] ${addr} is not a registered GovPool on chain ${chainId} ` +
    `(PoolRegistry.isGovPool == false) — every composite (dexe_proposal_create, ` +
    `dexe_proposal_vote_and_execute, dexe_dao_create follow-ups) will refuse it with the W10 guard. ` +
    `Remedy: deploy a fresh fixture with dexe_dao_create on chain ${chainId} and replace this entry ` +
    `in SWARM_DAOS_${chainTag}, together with its index-parallel gov token in SWARM_TOKENS_${chainTag}. ` +
    `See tests/swarm/README.md § "Refresh the fixture DAO".`
  );
}

/**
 * `SWARM_TOKENS_<tag>` is index-parallel to `SWARM_DAOS_<tag>`: the orchestrator
 * picks `tokens[daoIdx]` and preflight resolves `daos[i]`'s UserKeeper for
 * `tokens[i]`. Nothing said so and nothing checked it, so a second DAO added
 * out of order mis-paired in silence and the scenario failed later with an
 * unrelated-looking "low creating power".
 *
 * Returns null when the lists are consistent, else the message.
 */
export function assertIndexParallel(
  daos: string[],
  tokens: string[],
  chainTag: string,
): string | null {
  if (daos.length === tokens.length) return null;
  return (
    `SWARM_DAOS_${chainTag} has ${daos.length} entr${daos.length === 1 ? "y" : "ies"} but ` +
    `SWARM_TOKENS_${chainTag} has ${tokens.length}. They are index-parallel: tokens[i] must be the ` +
    `gov token of daos[i] (orchestrator picks the token by the DAO's index). Pad or trim the shorter list.`
  );
}

export interface PairingVerdict {
  /** Index-parallel entries whose token is not the DAO's gov token. */
  mismatches: Array<{ index: number; dao: string; expected: string; actual: string }>;
  /** false ⇒ at least one pair could not be read; treat as "unknown", not bad. */
  verified: boolean;
}

/**
 * On-chain pairing check, fail-OPEN per pair.
 *
 * A DAO whose UserKeeper reports the zero address is NFT-only and legitimately
 * has no gov ERC20 — that is skipped, not flagged, or a valid NFT fixture would
 * hard-fail preflight.
 */
export async function checkTokenPairing(
  daos: string[],
  tokens: string[],
  readGovToken: GovTokenFn,
): Promise<PairingVerdict> {
  const mismatches: PairingVerdict["mismatches"] = [];
  let verified = true;
  const n = Math.min(daos.length, tokens.length);
  for (let i = 0; i < n; i++) {
    const dao = daos[i]!;
    const token = tokens[i]!;
    let actual: string;
    try {
      actual = await readGovToken(dao);
    } catch {
      verified = false;
      continue;
    }
    if (!actual || /^0x0{40}$/i.test(actual)) continue; // NFT-only DAO — no ERC20
    if (actual.toLowerCase() !== token.toLowerCase()) {
      mismatches.push({ index: i, dao, expected: actual, actual: token });
    }
  }
  return { mismatches, verified };
}

export function tokenPairingMessage(
  m: { index: number; dao: string; expected: string; actual: string },
  chainTag: string,
): string {
  return (
    `SWARM_TOKENS_${chainTag}[${m.index}] is ${m.actual}, but DAO ${m.dao} ` +
    `(SWARM_DAOS_${chainTag}[${m.index}]) uses gov token ${m.expected}. The two lists are index-parallel — ` +
    `entry i of the token list must be the gov token of entry i of the DAO list. Reorder or replace the entry.`
  );
}
