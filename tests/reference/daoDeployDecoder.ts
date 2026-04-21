/**
 * DAO Deploy Calldata Decoder
 *
 * Standalone utility to decode deployGovPool calldata into readable JSON.
 * Used by the comparator and can be used independently for debugging.
 *
 * Usage:
 *   npx tsx tests/reference/daoDeployDecoder.ts <calldata_hex>
 */

import { Interface } from "ethers";

const DEPLOY_GOV_POOL_ABI = [
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) parameters) returns (address)",
];

const iface = new Interface(DEPLOY_GOV_POOL_ABI);

function serialize(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "boolean" || typeof val === "string" || typeof val === "number") return val;
  if (typeof (val as any).toObject === "function") {
    const obj = (val as any).toObject();
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = serialize(v);
    return result;
  }
  if (Array.isArray(val)) return val.map(serialize);
  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (!/^\d+$/.test(k)) result[k] = serialize(v);
    }
    return result;
  }
  return String(val);
}

export function decodeDeployGovPool(calldata: string): unknown {
  const decoded = iface.decodeFunctionData("deployGovPool", calldata);
  return serialize(decoded);
}

// CLI
if (process.argv[1]?.includes("daoDeployDecoder")) {
  const hex = process.argv[2];
  if (!hex) {
    console.error("Usage: npx tsx tests/reference/daoDeployDecoder.ts <calldata_hex>");
    process.exit(1);
  }
  try {
    const result = decodeDeployGovPool(hex);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("Decode failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
