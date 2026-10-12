import { ZeroAddress } from "ethers";

/**
 * TokenSaleProposal ABI fragments shared by the token-sale reads
 * (dexe_read_token_sale_tiers / _user, dexe_read_token_sales,
 * dexe_read_token_sale_position) and the OTC write composites and buy builders, so
 * every surface decodes the same nested shapes.
 */

/**
 * Exact mirror of `ITokenSaleProposal.TierView` — a NESTED struct of
 * `{ tierInitParams, tierInfo, tierAdditionalInfo }`. The previous flat shape
 * (saleTokenAddress before claimLockDuration, reversed VestingSettings) was
 * the pre-Bug-#25 field order and decoded garbage against live tiers.
 * Field order verified against
 * `DeXe-Protocol/contracts/interfaces/gov/proposals/ITokenSaleProposal.sol`.
 */
export const TIER_VIEW_TUPLE =
  "tuple(" +
  "tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint64 saleStartTime, uint64 saleEndTime, uint64 claimLockDuration, address saleTokenAddress, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 vestingPercentage, uint64 vestingDuration, uint64 cliffPeriod, uint64 unlockStep) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails) tierInitParams, " +
  "tuple(bool isOff, uint256 totalSold, string uri, tuple(uint64 vestingStartTime, uint64 vestingEndTime) vestingTierInfo) tierInfo, " +
  "tuple(bytes32 merkleRoot, string merkleUri, uint256 lastModified) tierAdditionalInfo" +
  ")";

export const GET_TIER_VIEWS_FRAGMENT = `function getTierViews(uint256 offset, uint256 limit) view returns (${TIER_VIEW_TUPLE}[] tierViews)`;

/** Authoritative `getUserViews` fragment — shared with read.ts so both decode the same nested UserView shape. */
export const GET_USER_VIEWS_FRAGMENT =
  "function getUserViews(address user, uint256[] tierIds, bytes32[][] proofs) view returns (tuple(bool canParticipate, tuple(bool isClaimed, bool canClaim, uint64 claimUnlockTime, uint256 claimTotalAmount, uint256 boughtTotalAmount, address[] lockedTokenAddresses, uint256[] lockedTokenAmounts, address[] lockedNftAddresses, uint256[][] lockedNftIds, address[] purchaseTokenAddresses, uint256[] purchaseTokenAmounts) purchaseView, tuple(uint64 latestVestingWithdraw, uint64 nextUnlockTime, uint256 nextUnlockAmount, uint256 vestingTotalAmount, uint256 vestingWithdrawnAmount, uint256 amountToWithdraw, uint256 lockedAmount) vestingUserView)[] userViews)";

/**
 * Protocol-wide native-coin sentinel (`Globals.sol::ETHEREUM_ADDRESS`).
 * `TokenSaleProposalBuy` keys exchange rates by this address and checks
 * `tokenToBuyWith != ETHEREUM_ADDRESS` for the native path — passing the
 * zero address on-chain reverts with "TSP: incorrect token". We accept the
 * zero address as caller input for convenience, but calldata must always
 * carry ETHEREUM_ADDRESS.
 */
export const ETHEREUM_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export function isNativeSentinel(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ZeroAddress || a === ETHEREUM_ADDRESS.toLowerCase();
}
