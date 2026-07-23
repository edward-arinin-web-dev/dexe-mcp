import { z } from "zod";
import { markdownToSlate } from "../lib/markdownToSlate.js";
import {
  AbiCoder,
  Contract,
  Interface,
  isAddress,
  ZeroAddress,
  getAddress,
  id,
  parseUnits,
  type JsonRpcProvider,
} from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildAddressMerkleTree } from "../lib/merkleTree.js";
import { checkBlacklist, blacklistError } from "../lib/blacklist.js";
import { parseUintString } from "../lib/amount.js";
import { CHANGE_VOTE_POWER_ADVISORY } from "../lib/protocolAdvisories.js";
import { buildTimeTreasuryAdvisory } from "../lib/quorumRisk.js";
import { RpcProvider } from "../rpc.js";
import type { DexeConfig } from "../config.js";

/**
 * Phase 3c — 10 complex named wrappers. Same contract as 3a/3b:
 * every wrapper returns `{ metadata, actions: Action[] }`. Actions are fed
 * to `dexe_proposal_build_external`. Signatures verified against DeXe
 * frontend hooks at `C:/dev/investing-dashboard/src/hooks/dao/proposals/**`
 * on 2026-04-15.
 *
 * Note: `enable_staking` is NOT a distinct wrapper — the frontend reuses
 * `useGovPoolCreateProposalType`, so the catalog routes it to
 * `dexe_proposal_build_new_proposal_type`.
 */

// ---------- ABIs ----------

const DISTRIBUTION_PROPOSAL_ABI = [
  "function execute(uint256 proposalId, address token, uint256 amount)",
] as const;

// Canonical TokenSaleProposal signatures — verified against
// `dexe_get_methods TokenSaleProposal` (selectors createTiers=0x6a6effda,
// addToWhitelist=0xce6c2d91, recover=0xc59b695a) and the interface at
// `contracts/interfaces/gov/proposals/ITokenSaleProposal.sol`.
export const TOKEN_SALE_PROPOSAL_ABI = [
  "function createTiers(tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint64 saleStartTime, uint64 saleEndTime, uint64 claimLockDuration, address saleTokenAddress, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 vestingPercentage, uint64 vestingDuration, uint64 cliffPeriod, uint64 unlockStep) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails)[] tiers)",
  "function addToWhitelist(tuple(uint256 tierId, address[] users, string uri)[] requests)",
  "function recover(uint256[] tierIds)",
] as const;

// `ParticipationDetails.data` payload encodings. Mirrors the per-type
// branching in `TokenSaleProposalCreate.sol::_setParticipationInfo` —
// sizes/shapes are checked on-chain, so getting these wrong reverts.
type ParticipationSpec =
  | { type: "DAOVotes"; requiredVotes: string }
  | { type: "Whitelist"; users: readonly string[]; uri?: string }
  | { type: "BABT" }
  | { type: "TokenLock"; token: string; amount: string }
  | { type: "NftLock"; nft: string; amount: string }
  | { type: "MerkleWhitelist"; users: readonly string[]; uri?: string; root?: string };

const PARTICIPATION_TYPE_INDEX: Record<ParticipationSpec["type"], number> = {
  DAOVotes: 0,
  Whitelist: 1,
  BABT: 2,
  TokenLock: 3,
  NftLock: 4,
  MerkleWhitelist: 5,
};

const participationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DAOVotes"), requiredVotes: z.string() }),
  z.object({
    type: z.literal("Whitelist"),
    users: z.array(z.string()).default([]),
    uri: z.string().default(""),
  }),
  z.object({ type: z.literal("BABT") }),
  z.object({
    type: z.literal("TokenLock"),
    token: z.string(),
    amount: z.string(),
  }),
  z.object({
    type: z.literal("NftLock"),
    nft: z.string(),
    amount: z.string(),
  }),
  z.object({
    type: z.literal("MerkleWhitelist"),
    users: z.array(z.string()).default([]),
    uri: z.string().default(""),
    root: z
      .string()
      .optional()
      .describe(
        "Optional pre-computed merkle root. If omitted but `users` is set, the tool computes it.",
      ),
  }),
]);

export const STAKING_PROPOSAL_ABI = [
  "function createStaking(address rewardToken, uint256 rewardAmount, uint256 startedAt, uint256 deadline, string metadata)",
] as const;

export const GOV_POOL_EXT_ABI = [
  "function changeVotePower(address newVotePower)",
  "function editDescriptionURL(string descriptionURL)",
  "function setNftMultiplierAddress(address nftMultiplier)",
] as const;

export const ERC20_GOV_ABI = [
  "function blacklist(address[] users, bool isBlacklisted)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export const ERC721_MULTIPLIER_ABI = [
  "function setTokenURI(uint256 tokenId, string uri)",
  "function mint(address to, uint256 multiplier, uint64 duration, string uri_)",
  "function changeToken(uint256 tokenId, uint256 multiplier, uint64 duration)",
] as const;

// ERC721Multiplier multiplier scale = PRECISION = 10**25. So 1.5x = 1.5e25.
export const ERC721_MULTIPLIER_PRECISION = 10n ** 25n;
export const UINT64_MAX = (1n << 64n) - 1n;
// Sanity ceiling for a multiplier value: 100x scaled by PRECISION = 1e27. Any
// value above this is almost certainly an un-scaled/over-scaled mistake (bug #31
// class). PRECISION=1e25, so 1.5x = 15000000000000000000000000.
export const ERC721_MULTIPLIER_MAX = ERC721_MULTIPLIER_PRECISION * 100n; // 1e27

// ERC721Multiplier is `onlyOwner`-gated and its owner MUST be the GovPool
// (AbstractERC721Multiplier uses IGovPool(owner())). We probe owner() before
// building mint/change_token/set_token_uri so a mis-owned or undeployed
// contract is refused up-front instead of stranding the proposal in
// SucceededFor when GovPool.execute → mint reverts onlyOwner (bug #31).
const ERC721_MULTIPLIER_OWNER_ABI = ["function owner() view returns (address)"] as const;
const GOV_POOL_MULTIPLIER_ADDR_ABI = [
  "function getNftMultiplierAddress() view returns (address)",
] as const;
const BEACON_IMPL_ABI = ["function implementation() view returns (address)"] as const;

// Bug #31-class selector guard. A proposal whose stored calldata targets a
// selector the multiplier does NOT implement falls through to the fallback and
// reverts with EMPTY data at execute — unexecutable forever (SucceededFor). We
// scan the RUNTIME bytecode that will execute for the dispatch selector's PUSH4
// immediate before building the action. The needles are the 4-byte selectors
// (lowercase, no 0x). mint = 0xaf2d2333 (verified live 2026-07). changeToken is
// computed — never hardcode a selector we could derive.
const MINT_SELECTOR_HEX = id("mint(address,uint256,uint64,string)").slice(2, 10); // af2d2333
const CHANGE_TOKEN_SELECTOR_HEX = id("changeToken(uint256,uint256,uint64)").slice(2, 10); // 4ccc2757
// EIP-1967 standard slots (transparent/UUPS impl + beacon).
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** Low 20 bytes of a 32-byte storage word → checksummed address (0x0 on junk). */
function addressFromStorageSlot(raw: string): string {
  if (!raw || raw === "0x") return ZeroAddress;
  const hex = raw.slice(2).padStart(64, "0");
  try {
    return getAddress("0x" + hex.slice(-40));
  } catch {
    return ZeroAddress;
  }
}

/**
 * Does the runtime code that will execute at `target` dispatch `selectorHex`?
 * Resolves proxies: (a) direct bytecode, (b) EIP-1967 implementation slot,
 * (c) EIP-1967 beacon slot → beacon.implementation(). Bytecode-scan is a
 * heuristic — a dispatch selector always appears as a PUSH4 immediate, and a
 * false POSITIVE (selector byte-string appearing as data) only means we DON'T
 * refuse, which is the safe direction. Returns:
 *   true  — selector found in some layer,
 *   false — conclusively absent after clean reads of every layer (→ refuse),
 *   null  — an RPC error prevented a conclusive answer (→ degrade, never block).
 */
async function multiplierExposesSelector(
  provider: JsonRpcProvider,
  target: string,
  selectorHex: string,
): Promise<boolean | null> {
  const needle = selectorHex.toLowerCase();
  const scan = async (addr: string): Promise<boolean> => {
    const code = await provider.getCode(addr);
    return !!code && code.toLowerCase().includes(needle);
  };
  // (a) direct bytecode — if even this read fails we can prove nothing.
  let targetCode: string;
  try {
    targetCode = (await provider.getCode(target)) || "";
    if (targetCode.toLowerCase().includes(needle)) return true;
  } catch {
    return null;
  }
  let rpcError = false;
  // (a2) EIP-1167 minimal-proxy clone: the runtime hardcodes the implementation
  // in bytecode (363d3d373d3d3d363d73<20-byte impl>5af43d82803e903d91602b57fd5bf3),
  // so neither the direct scan nor the EIP-1967 storage slots resolve it. Decode
  // the embedded impl and scan it — otherwise a valid clone false-refuses.
  const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(targetCode);
  if (clone) {
    try {
      if (await scan(`0x${clone[1]}`)) return true;
    } catch {
      rpcError = true;
    }
  }
  // (b) EIP-1967 implementation slot (transparent / UUPS proxy).
  try {
    const impl = addressFromStorageSlot(await provider.getStorage(target, EIP1967_IMPL_SLOT));
    if (impl !== ZeroAddress && (await scan(impl))) return true;
  } catch {
    rpcError = true;
  }
  // (c) EIP-1967 beacon slot → beacon.implementation() (the shape DeXe uses).
  try {
    const beacon = addressFromStorageSlot(await provider.getStorage(target, EIP1967_BEACON_SLOT));
    if (beacon !== ZeroAddress) {
      const c = new Contract(
        beacon,
        BEACON_IMPL_ABI as unknown as string[],
        provider,
      ) as unknown as { implementation: () => Promise<string> };
      const impl = await c.implementation();
      if (isAddress(impl) && impl !== ZeroAddress && (await scan(impl))) return true;
    }
  } catch {
    rpcError = true;
  }
  // No layer exposed the selector. Only refuse if every read was clean —
  // an RPC hiccup anywhere means we can't prove absence, so degrade.
  return rpcError ? null : false;
}

export interface MultiplierPrecheck {
  refuse?: string;
  warnings: string[];
}

/**
 * Bug #31 guard. Before building an action that executes against the ERC721
 * multiplier contract, verify (when an RPC is available) that:
 *   a. there is code at `multiplierContract` on the target chain, and
 *   a2. (mint/change_token only, via `selectorCheck`) the runtime bytecode that
 *      will execute actually dispatches the target selector — mint's canonical
 *      selector is 0xaf2d2333; a stored calldata selector the contract does not
 *      implement falls through to the fallback and reverts with EMPTY data at
 *      execute, stranding the proposal in SucceededFor forever (bug #31 class,
 *      the exact way the original uint256-duration mint 0xbb7fde71 stuck), and
 *   b. its `owner()` is the GovPool (else GovPool.execute → mint reverts
 *      onlyOwner and the proposal sits in SucceededFor forever), and
 *   c. (mint/change_token only) GovPool.getNftMultiplierAddress() already points
 *      at this contract — otherwise the NFT will not be the DAO's ACTIVE
 *      multiplier until setNftMultiplierAddress is called (WARNING, not refusal).
 *
 * Degrades to a no-op (no refusal, no warnings) whenever no RPC is configured or
 * a probe reverts — the builders must still work fully offline.
 */
export async function precheckMultiplierContract(
  config: DexeConfig,
  params: {
    govPool?: string;
    multiplierContract: string;
    checkCurrentAddress: boolean;
    /** When set, also verify the runtime bytecode dispatches the mode's selector
     *  (mint → 0xaf2d2333, change_token → changeToken(uint256,uint256,uint64)).
     *  Omit for set_token_uri to preserve prior behavior. */
    selectorCheck?: "mint" | "change_token";
  },
  chainId?: number,
): Promise<MultiplierPrecheck> {
  const warnings: string[] = [];
  if (!config.rpcUrl) return { warnings };
  let provider: JsonRpcProvider;
  try {
    const pr = new RpcProvider(config).tryProvider(chainId);
    if ("error" in pr) return { warnings };
    provider = pr.ok;
  } catch {
    return { warnings };
  }
  const chainLabel = chainId ?? "default";
  // (a) code presence
  try {
    const code = await provider.getCode(params.multiplierContract);
    if (!code || code === "0x") {
      return {
        warnings,
        refuse:
          `reward_multiplier: no contract at ${params.multiplierContract} on chain ${chainLabel}. ` +
          `Deploy an ERC721Multiplier owned by the GovPool first (then setNftMultiplierAddress), or fix the address.`,
      };
    }
  } catch {
    // RPC hiccup on getCode → cannot prove anything; degrade silently.
    return { warnings };
  }
  // (a2) selector existence — the runtime bytecode that GovPool.execute jumps
  // into must actually dispatch the mode's selector (bug #31 class). Only a
  // conclusive `false` (every proxy layer read cleanly, selector absent) refuses;
  // any RPC error along the way degrades silently.
  if (params.selectorCheck) {
    const needle =
      params.selectorCheck === "change_token" ? CHANGE_TOKEN_SELECTOR_HEX : MINT_SELECTOR_HEX;
    const exposes = await multiplierExposesSelector(
      provider,
      params.multiplierContract,
      needle,
    );
    if (exposes === false) {
      const sig =
        params.selectorCheck === "change_token"
          ? `changeToken(uint256,uint256,uint64) (selector 0x${CHANGE_TOKEN_SELECTOR_HEX})`
          : "mint(address,uint256,uint64,string) (selector 0xaf2d2333)";
      return {
        warnings,
        refuse:
          `reward_multiplier: ${params.multiplierContract} does not expose ${sig} — ` +
          `executing this proposal would revert with empty data and the proposal would be stuck in ` +
          `SucceededFor forever (bug #31 class). Verify the address is an ERC721Multiplier.`,
      };
    }
  }
  // (b) ownership — GovPool must own the multiplier
  if (params.govPool && isAddress(params.govPool)) {
    try {
      const c = new Contract(
        params.multiplierContract,
        ERC721_MULTIPLIER_OWNER_ABI as unknown as string[],
        provider,
      ) as unknown as { owner: () => Promise<string> };
      const owner = await c.owner();
      if (owner.toLowerCase() !== params.govPool.toLowerCase()) {
        return {
          warnings,
          refuse:
            `reward_multiplier: multiplier contract ${params.multiplierContract} is not owned by this GovPool ` +
            `(${params.govPool}); its owner() is ${owner}. GovPool.execute → mint will revert onlyOwner. ` +
            `Deploy an ERC721Multiplier owned by the GovPool (or transfer ownership) and call ` +
            `setNftMultiplierAddress first.`,
        };
      }
    } catch {
      // owner() missing/reverted → cannot verify; warn but don't block.
      warnings.push(
        `reward_multiplier: could not read owner() on ${params.multiplierContract} — cannot verify it is ` +
          `owned by the GovPool. If GovPool.execute reverts onlyOwner, the contract is not GovPool-owned.`,
      );
    }
  }
  // (c) active-address alignment (mint/change_token)
  if (params.checkCurrentAddress && params.govPool && isAddress(params.govPool)) {
    try {
      const g = new Contract(
        params.govPool,
        GOV_POOL_MULTIPLIER_ADDR_ABI as unknown as string[],
        provider,
      ) as unknown as { getNftMultiplierAddress: () => Promise<string> };
      const current = await g.getNftMultiplierAddress();
      if (current.toLowerCase() !== params.multiplierContract.toLowerCase()) {
        warnings.push(
          `reward_multiplier: GovPool.getNftMultiplierAddress() is ` +
            `${current === ZeroAddress ? "unset (0x0)" : current}, not ${params.multiplierContract}. ` +
            `The token will not count toward voting power until setNftMultiplierAddress(${params.multiplierContract}) runs.`,
        );
      }
    } catch {
      // getNftMultiplierAddress unavailable → skip the alignment hint.
    }
  }
  return { warnings };
}

/**
 * UX coercion helper (numeric-as-string). LLM callers routinely pass ids and
 * timestamps as raw JS numbers (`settingsIds: [0]`, `startedAt: 1730000000`),
 * which `z.string()` rejected with "Expected string, received number". This
 * accepts EITHER a string (passed through untouched — zero change to existing
 * behavior/wire format) or an integer number, normalizing to a decimal string.
 * Floats and non-safe/non-finite numbers are rejected so ids/timestamps keep
 * integer semantics; the string branch is never loosened.
 */
export const numericIntString = z.union([z.string(), z.number()]).transform((v, ctx) => {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an integer (no fractional part)" });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "number too large to represent exactly — pass it as a string to preserve precision",
      });
      return z.NEVER;
    }
    return String(v);
  }
  return v;
});

/**
 * Like {@link numericIntString} but for token AMOUNTS, which may legitimately be
 * fractional human units ('12.5'). Accepts a string (untouched) or a finite
 * number, normalizing to a decimal string. Downstream amount parsing (raw
 * digits vs human units) is unchanged.
 */
export const numericAmountString = z.union([z.string(), z.number()]).transform((v, ctx) => {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a finite number" });
      return z.NEVER;
    }
    // Fractional human units (12.5) stay accepted, but an INTEGER beyond 2^53 has
    // already lost precision as a JS number: String(12345678901234567890) yields
    // '12345678901234567000' (rounded) and String(1e21) yields '1e+21' — both
    // produce wrong raw-wei calldata downstream. Reject and demand the string form,
    // mirroring numericIntString.
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "number too large to represent exactly — pass it as a string to preserve precision",
      });
      return z.NEVER;
    }
    return String(v);
  }
  return v;
});

export const GOV_SETTINGS_FULL_ABI = [
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] settings)",
  "function changeExecutors(address[] executors, uint256[] settingsIds)",
] as const;

// ---------- shared shapes ----------

type Action = { executor: string; value: string; data: string };

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function payloadOutputSchema() {
  return {
    metadata: z.unknown(),
    actions: z.array(
      z.object({ executor: z.string(), value: z.string(), data: z.string() }),
    ),
  };
}

function wrapperResult(params: {
  metadata: unknown;
  actions: Action[];
  title: string;
  detail: string;
  /** Non-blocking governance-safety notes, mirrored into text + structuredContent. */
  advisories?: string[];
}) {
  const advisoryBlock =
    params.advisories && params.advisories.length
      ? `\n\nWARNINGS:\n${params.advisories.map((a) => `- ${a}`).join("\n")}`
      : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${params.title}\n${params.detail}\n\nNext:\n` +
          `1) dexe_ipfs_upload_proposal_metadata with the metadata object → get CID\n` +
          `2) dexe_proposal_build_external with descriptionURL=<CID>, actionsOnFor=actions (${params.actions.length} action${params.actions.length === 1 ? "" : "s"})` +
          advisoryBlock,
      },
    ],
    structuredContent: {
      metadata: params.metadata,
      actions: params.actions,
      ...(params.advisories && params.advisories.length
        ? { governanceAdvisories: params.advisories }
        : {}),
    },
  };
}

// ---------- register ----------

export function registerProposalBuildComplexTools(
  server: McpServer,
  _ctx: ToolContext,
): void {
  registerTokenDistribution(server);
  registerTokenSale(server);
  registerTokenSaleMulti(server);
  registerTokenSaleWhitelist(server);
  registerTokenSaleRecover(server);
  registerCreateStakingTier(server);
  registerChangeMathModel(server);
  registerModifyDaoProfile(server);
  registerBlacklistManagement(server);
  registerRewardMultiplier(server, _ctx);
  registerApplyToDao(server, _ctx);
  registerNewProposalType(server);
}

// ---------- 1. token_distribution ----------

function registerTokenDistribution(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_distribution",
    {
      title: "Wrapper: batch token distribution via DistributionProposal",
      description:
        "Builds a 'Token Distribution' external proposal. Encodes `DistributionProposal.execute(proposalId, token, amount)`. For ERC20 tokens, automatically prepends an `ERC20.approve` action. For native tokens (isNative=true), sets the action value instead. `proposalId` is the DAO's latest proposalId + 1.",
      inputSchema: {
        distributionProposal: z
          .string()
          .describe("DistributionProposal address (from catalog / registry lookup)"),
        proposalId: z
          .string()
          .describe("Expected proposalId for this distribution (usually latestProposalId + 1)"),
        token: z.string(),
        amount: z.string(),
        isNative: z.boolean().default(false).describe("True for native token (BNB/ETH) — sends value instead of approve"),
        proposalName: z.string().default("Token Distribution"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      distributionProposal,
      proposalId,
      token,
      amount,
      isNative = false,
      proposalName = "Token Distribution",
      proposalDescription = "",
    }) => {
      if (!isAddress(distributionProposal)) return errorResult(`Invalid distributionProposal: ${distributionProposal}`);
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      try {
        const distIface = new Interface(DISTRIBUTION_PROPOSAL_ABI as unknown as string[]);
        const executeData = distIface.encodeFunctionData("execute", [
          BigInt(proposalId),
          token,
          BigInt(amount),
        ]);
        const actions: Action[] = [];
        if (isNative) {
          actions.push({ executor: distributionProposal, value: amount, data: executeData });
        } else {
          const erc20Iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
          const approveData = erc20Iface.encodeFunctionData("approve", [distributionProposal, BigInt(amount)]);
          actions.push({ executor: token, value: "0", data: approveData });
          actions.push({ executor: distributionProposal, value: "0", data: executeData });
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "tokenDistribution",
          isMeta: false,
          changes: {
            proposedChanges: { tokenAddress: token, tokenAmount: amount, proposalId },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Token Distribution → ${amount} of ${token} via proposal #${proposalId}`,
          detail: `Target: DistributionProposal(${distributionProposal}).execute (${actions.length} actions)`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 2. token_sale ----------

// Vesting settings shape — keys match the contract's VestingSettings struct
// order (vestingPercentage, vestingDuration, cliffPeriod, unlockStep).
const vestingSchema = z
  .object({
    vestingPercentage: z.string().default("0"),
    vestingDuration: z.string().default("0"),
    cliffPeriod: z.string().default("0"),
    unlockStep: z.string().default("0"),
  })
  .default({
    vestingPercentage: "0",
    vestingDuration: "0",
    cliffPeriod: "0",
    unlockStep: "0",
  });

// On-chain `TokenSaleProposalBuy` formula:
//   saleTokenAmount = purchaseAmount * PRECISION / exchangeRate
// where PRECISION = 10**25 (see contracts/core/Globals.sol).
//
// Callers MUST either:
//   - pass `exchangeRates` as raw 25-precision wei (paid_per_sold * 10^25), OR
//   - pass `purchaseRatios` as decimal strings (e.g. "0.10" meaning
//     0.10 purchase tokens buy 1 sale token) — auto-scaled to PRECISION.
//
// Any raw rate below `RATE_SUSPICION_FLOOR` is rejected with a clear hint,
// because it almost certainly means the caller forgot the PRECISION scale
// (a 0.10-USDT-per-token sale was misencoded as 1e17 instead of 1e24 in
// production on 2026-05-04).
export const PRECISION_DECIMALS = 25;
const RATE_SUSPICION_FLOOR = 10n ** 18n;

export const tierSchema = z
  .object({
    name: z.string(),
    description: z.string().default(""),
    totalTokenProvided: z.string(),
    saleStartTime: z.string().describe("Unix seconds"),
    saleEndTime: z.string().describe("Unix seconds"),
    claimLockDuration: z.string().default("0"),
    saleTokenAddress: z.string(),
    purchaseTokenAddresses: z.array(z.string()).min(1),
    exchangeRates: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "Raw 25-precision rate wei (PRECISION = 10^25). On-chain: saleAmount = purchaseAmount * 1e25 / rate. " +
          "For \"0.10 purchase per 1 sale\" pass \"1000000000000000000000000\" (= 0.10 × 10^25). " +
          "Prefer `purchaseRatios` for human-readable input.",
      ),
    purchaseRatios: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "Human decimal ratio of purchase tokens per 1 sale token (e.g. \"0.10\" = 0.10 USDT buys 1 HELIO). " +
          "Auto-scaled to PRECISION = 10^25. Mutually exclusive with `exchangeRates`.",
      ),
    minAllocationPerUser: z.string().default("0"),
    maxAllocationPerUser: z.string().default("0"),
    vestingSettings: vestingSchema,
    participation: z
      .array(participationSchema)
      .default([])
      .describe(
        "Participation requirements (joined with AND on-chain). Leave empty for an open tier.",
      ),
  })
  .refine(
    (t) => Boolean(t.exchangeRates) !== Boolean(t.purchaseRatios),
    {
      message:
        "Provide exactly one of `exchangeRates` (raw 25-precision wei) or `purchaseRatios` (human decimals).",
      path: ["exchangeRates"],
    },
  );

export type TierSpec = z.infer<typeof tierSchema>;
type ParticipationDetail = { type: number; data: string };
type WhitelistRequest = { tierId: bigint; users: string[]; uri: string };

const dataCoder = AbiCoder.defaultAbiCoder();

function encodeParticipationData(spec: ParticipationSpec): {
  detail: ParticipationDetail;
  /** When `MerkleWhitelist` derives its root from `users`, return the input
   *  list so callers can publish it for buyers (and we can record it in
   *  proposal metadata). */
  derived?: { root: string; users: string[] };
  /** When `Whitelist`, the user list to feed into a follow-up
   *  `addToWhitelist(...)` action. */
  whitelistUsers?: string[];
  whitelistUri?: string;
} {
  const typeIdx = PARTICIPATION_TYPE_INDEX[spec.type];
  switch (spec.type) {
    case "DAOVotes": {
      const data = dataCoder.encode(["uint256"], [BigInt(spec.requiredVotes)]);
      return { detail: { type: typeIdx, data } };
    }
    case "Whitelist": {
      // Plain whitelist: NFT-mint mode. Empty data; users are added via
      // `addToWhitelist` in a follow-up action.
      const users = (spec.users ?? []).map((u) => {
        if (!isAddress(u)) throw new Error(`Invalid whitelist user: ${u}`);
        return getAddress(u);
      });
      return {
        detail: { type: typeIdx, data: "0x" },
        whitelistUsers: users,
        whitelistUri: spec.uri ?? "",
      };
    }
    case "BABT": {
      return { detail: { type: typeIdx, data: "0x" } };
    }
    case "TokenLock": {
      if (!isAddress(spec.token)) throw new Error(`Invalid TokenLock token: ${spec.token}`);
      const data = dataCoder.encode(
        ["address", "uint256"],
        [getAddress(spec.token), BigInt(spec.amount)],
      );
      return { detail: { type: typeIdx, data } };
    }
    case "NftLock": {
      if (!isAddress(spec.nft)) throw new Error(`Invalid NftLock nft: ${spec.nft}`);
      const data = dataCoder.encode(
        ["address", "uint256"],
        [getAddress(spec.nft), BigInt(spec.amount)],
      );
      return { detail: { type: typeIdx, data } };
    }
    case "MerkleWhitelist": {
      let root = spec.root;
      let users: string[] | undefined;
      if (!root) {
        if (!spec.users || spec.users.length === 0) {
          throw new Error("MerkleWhitelist needs either `root` or non-empty `users`.");
        }
        users = spec.users.map((u) => {
          if (!isAddress(u)) throw new Error(`Invalid MerkleWhitelist user: ${u}`);
          return getAddress(u);
        });
        root = buildAddressMerkleTree(users).root;
      }
      const data = dataCoder.encode(["bytes32", "string"], [root, spec.uri ?? ""]);
      return {
        detail: { type: typeIdx, data },
        derived: { root, users: users ?? [] },
      };
    }
  }
}

export function buildTierTuple(tier: TierSpec): {
  tuple: unknown[];
  whitelistUsers: string[];
  whitelistUri: string;
  derivedRoots: { root: string; users: string[] }[];
} {
  if (!isAddress(tier.saleTokenAddress)) {
    throw new Error(`Invalid saleTokenAddress for tier "${tier.name}".`);
  }
  for (const pt of tier.purchaseTokenAddresses) {
    if (!isAddress(pt)) throw new Error(`Tier "${tier.name}": invalid purchase token ${pt}.`);
    // TokenSaleProposal's native path is keyed by Globals.sol::ETHEREUM_ADDRESS —
    // a zero-address purchase token creates a tier nobody can buy from
    // (buy() reverts "TSP: incorrect token" for any unlisted token).
    if (pt.toLowerCase() === ZeroAddress) {
      throw new Error(
        `Tier "${tier.name}": zero-address purchase token. For native BNB use the protocol ` +
          `sentinel 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (ETHEREUM_ADDRESS) — the contract ` +
          `keys exchange rates by it; a zero-address entry is unbuyable.`,
      );
    }
  }

  // Normalize rates to raw 25-precision wei. Either branch produces a
  // bigint[] aligned with purchaseTokenAddresses.
  let rates: bigint[];
  if (tier.purchaseRatios) {
    if (tier.purchaseTokenAddresses.length !== tier.purchaseRatios.length) {
      throw new Error(
        `Tier "${tier.name}": purchaseTokenAddresses and purchaseRatios must be parallel arrays.`,
      );
    }
    rates = tier.purchaseRatios.map((r, i) => {
      let scaled: bigint;
      try {
        scaled = parseUnits(r, PRECISION_DECIMALS);
      } catch (err) {
        throw new Error(
          `Tier "${tier.name}": purchaseRatios[${i}] = "${r}" is not a valid decimal.`,
        );
      }
      if (scaled === 0n) {
        throw new Error(
          `Tier "${tier.name}": purchaseRatios[${i}] = "${r}" resolves to 0 — rate cannot be zero.`,
        );
      }
      return scaled;
    });
  } else {
    if (!tier.exchangeRates) {
      throw new Error(
        `Tier "${tier.name}": one of \`exchangeRates\` or \`purchaseRatios\` is required.`,
      );
    }
    if (tier.purchaseTokenAddresses.length !== tier.exchangeRates.length) {
      throw new Error(
        `Tier "${tier.name}": purchaseTokenAddresses and exchangeRates must be parallel arrays.`,
      );
    }
    rates = tier.exchangeRates.map((r, i) => {
      const v = BigInt(r);
      if (v === 0n) {
        throw new Error(`Tier "${tier.name}": exchangeRates[${i}] = 0 — rate cannot be zero.`);
      }
      if (v < RATE_SUSPICION_FLOOR) {
        throw new Error(
          `Tier "${tier.name}": exchangeRates[${i}] = ${r} looks unscaled. ` +
            `On-chain formula uses PRECISION = 10^25: saleAmount = purchaseAmount * 1e25 / rate. ` +
            `For "K purchase tokens per 1 sale token" pass K × 10^25, ` +
            `or use \`purchaseRatios\` with a decimal string instead.`,
        );
      }
      return v;
    });
  }

  const participationDetails: ParticipationDetail[] = [];
  let whitelistUsers: string[] = [];
  let whitelistUri = "";
  const derivedRoots: { root: string; users: string[] }[] = [];

  for (const spec of tier.participation ?? []) {
    const encoded = encodeParticipationData(spec);
    participationDetails.push(encoded.detail);
    if (encoded.whitelistUsers && encoded.whitelistUsers.length > 0) {
      whitelistUsers = whitelistUsers.concat(encoded.whitelistUsers);
      whitelistUri = encoded.whitelistUri ?? whitelistUri;
    }
    if (encoded.derived) derivedRoots.push(encoded.derived);
  }

  // Eval-run finding (2026-07-23): the contract only validates
  // saleStartTime <= saleEndTime — NOT that the window is in the future — so a
  // tier with a past window is created "successfully" but is dead on arrival
  // (every buy reverts "TSP: token sale is over"). A weak model guessing a
  // stale year (observed: Jan-2024 timestamps in 2026) hits exactly this.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const saleStart = BigInt(tier.saleStartTime);
  const saleEnd = BigInt(tier.saleEndTime);
  if (saleStart > saleEnd) {
    throw new Error(
      `Tier "${tier.name}": saleStartTime (${tier.saleStartTime}) is after saleEndTime (${tier.saleEndTime}) — the contract reverts.`,
    );
  }
  if (saleEnd <= nowSec) {
    throw new Error(
      `Tier "${tier.name}": saleEndTime ${tier.saleEndTime} (${new Date(Number(saleEnd) * 1000).toISOString()}) is in the ` +
        `PAST — current unix time is ~${nowSec}. The tier would be created dead-on-arrival (every buy reverts ` +
        `"TSP: token sale is over"). Use future timestamps computed from the current time — never guess the date — ` +
        `and leave headroom for the proposal's voting period before the sale window opens.`,
    );
  }

  // H-10: the contract reads vestingPercentage as percent × PRECISION
  // (TokenSaleProposalBuy uses MathHelper.percentage, which divides by
  // PERCENTAGE_100 = 100 × PRECISION). A raw "50" is ~0% vesting on-chain, so
  // scale it the same way exchangeRates are scaled, and reject out-of-range %.
  const vestingPct = tier.vestingSettings.vestingPercentage;
  const vestingPctNum = Number(vestingPct);
  if (!Number.isFinite(vestingPctNum) || vestingPctNum < 0 || vestingPctNum > 100) {
    throw new Error(
      `Tier "${tier.name}": vestingSettings.vestingPercentage = "${vestingPct}" must be a ` +
        `human percent in [0, 100] (e.g. "50" for 50%); it is scaled by PRECISION on-chain.`,
    );
  }
  const vestingPercentageScaled = parseUnits(vestingPct, PRECISION_DECIMALS);

  const tuple: unknown[] = [
    [tier.name, tier.description],
    BigInt(tier.totalTokenProvided),
    BigInt(tier.saleStartTime),
    BigInt(tier.saleEndTime),
    BigInt(tier.claimLockDuration),
    getAddress(tier.saleTokenAddress),
    tier.purchaseTokenAddresses.map((p) => getAddress(p)),
    rates,
    BigInt(tier.minAllocationPerUser),
    BigInt(tier.maxAllocationPerUser),
    [
      vestingPercentageScaled,
      BigInt(tier.vestingSettings.vestingDuration),
      BigInt(tier.vestingSettings.cliffPeriod),
      BigInt(tier.vestingSettings.unlockStep),
    ],
    participationDetails.map((d) => [d.type, d.data]),
  ];

  return { tuple, whitelistUsers, whitelistUri, derivedRoots };
}

export function buildSaleApprovals(
  tiers: readonly TierSpec[],
  tokenSaleProposal: string,
): Action[] {
  // Sum total token provided per sale token (matches frontend's saleTokensMap
  // reducer in `useGovPoolCreateTokenSaleProposal.ts`).
  const totals = new Map<string, bigint>();
  for (const tier of tiers) {
    const key = getAddress(tier.saleTokenAddress);
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(tier.totalTokenProvided));
  }
  const erc20Iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
  const actions: Action[] = [];
  for (const [token, amount] of totals.entries()) {
    actions.push({
      executor: token,
      value: "0",
      data: erc20Iface.encodeFunctionData("approve", [tokenSaleProposal, amount]),
    });
  }
  return actions;
}

/**
 * Pure builder for a multi-tier Token Sale proposal envelope. Used by both
 * the `dexe_proposal_build_token_sale_multi` registrar and the OTC composite
 * tools in `src/tools/otc.ts`.
 */
export function buildTokenSaleMultiActions(input: {
  tokenSaleProposal: string;
  tiers: readonly TierSpec[];
  latestTierId?: string;
  proposalName?: string;
  proposalDescription?: string;
}): {
  metadata: Record<string, unknown>;
  actions: Action[];
  derivedMerkleRoots: { root: string; users: string[] }[];
  whitelistRequests: { tierId: string; users: string[]; uri: string }[];
  tierNames: string;
} {
  const {
    tokenSaleProposal,
    tiers,
    latestTierId = "0",
    proposalName = "Token Sale",
    proposalDescription = "",
  } = input;
  if (!isAddress(tokenSaleProposal)) {
    throw new Error(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
  }
  const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
  const built = tiers.map((t) => buildTierTuple(t));

  const whitelistRequests: WhitelistRequest[] = [];
  const baseTierId = BigInt(latestTierId);
  built.forEach((w, i) => {
    if (w.whitelistUsers.length > 0) {
      whitelistRequests.push({
        tierId: baseTierId + 1n + BigInt(i),
        users: w.whitelistUsers,
        uri: w.whitelistUri,
      });
    }
  });

  const tierTuples = built.map((b) => b.tuple);
  const createData = iface.encodeFunctionData("createTiers", [tierTuples]);

  const actions: Action[] = [];
  actions.push(...buildSaleApprovals(tiers, tokenSaleProposal));
  actions.push({ executor: tokenSaleProposal, value: "0", data: createData });
  if (whitelistRequests.length > 0) {
    const wlData = iface.encodeFunctionData("addToWhitelist", [
      whitelistRequests.map((r) => [r.tierId, r.users, r.uri]),
    ]);
    actions.push({ executor: tokenSaleProposal, value: "0", data: wlData });
  }

  const derivedMerkleRoots = built.flatMap((b) => b.derivedRoots);
  const metadata: Record<string, unknown> = {
    proposalName,
    proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
    category: "tokenSale",
    isMeta: false,
    changes: {
      proposedChanges: { tiers, derivedMerkleRoots },
      currentChanges: {},
    },
  };

  return {
    metadata,
    actions,
    derivedMerkleRoots,
    whitelistRequests: whitelistRequests.map((r) => ({
      tierId: r.tierId.toString(),
      users: r.users,
      uri: r.uri,
    })),
    tierNames: tiers.map((t) => t.name).join(", "),
  };
}

function registerTokenSaleMulti(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_sale_multi",
    {
      title: "Build a multi-tier Token Sale proposal (createTiers + optional addToWhitelist)",
      description:
        "Wraps `TokenSaleProposal.createTiers([...])` for one or more tiers. Each tier may declare zero or more participation requirements (DAOVotes, Whitelist, BABT, TokenLock, NftLock, MerkleWhitelist) — the data payload is encoded per-type to match `TokenSaleProposalCreate.sol`. ERC20 approves are summed and deduped per sale token. For tiers using plain `Whitelist`, the matching `addToWhitelist` action is appended automatically when users are supplied.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        tiers: z.array(tierSchema).min(1),
        latestTierId: z
          .string()
          .default("0")
          .describe(
            "Current `latestTierId()` on TokenSaleProposal. Defaults to 0 — bump when extending an existing sale so addToWhitelist tier ids are correct.",
          ),
        proposalName: z.string().default("Token Sale"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async (input) => {
      try {
        const built = buildTokenSaleMultiActions(input);
        return wrapperResult({
          metadata: built.metadata,
          actions: built.actions,
          title: `Token Sale tiers → ${built.tierNames}`,
          detail: `Target: TokenSaleProposal(${input.tokenSaleProposal}).createTiers (${input.tiers.length} tier${input.tiers.length === 1 ? "" : "s"}${
            built.whitelistRequests.length > 0
              ? ` + addToWhitelist(${built.whitelistRequests.length})`
              : ""
          })`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerTokenSale(server: McpServer): void {
  // Back-compat shim around the multi-tier builder. Same single-tier API as
  // before, plus an optional `participation` field. Delegates encoding to
  // `buildTierTuple` so calldata stays canonical.
  server.registerTool(
    "dexe_proposal_build_token_sale",
    {
      title: "Wrapper: launch a token-sale tier via TokenSaleProposal.createTiers",
      description:
        "Builds a Token Sale proposal with a single tier. Forwards to `dexe_proposal_build_token_sale_multi` internally. For multi-tier sales or merkle whitelists, call `_multi` directly.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        tier: tierSchema,
        latestTierId: z.string().default("0"),
        proposalName: z.string().default("Token Sale"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      tokenSaleProposal,
      tier,
      latestTierId = "0",
      proposalName = "Token Sale",
      proposalDescription = "",
    }) => {
      if (!isAddress(tokenSaleProposal)) {
        return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      }
      try {
        const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
        const built = buildTierTuple(tier);

        const actions: Action[] = [];
        actions.push(...buildSaleApprovals([tier], tokenSaleProposal));
        actions.push({
          executor: tokenSaleProposal,
          value: "0",
          data: iface.encodeFunctionData("createTiers", [[built.tuple]]),
        });
        if (built.whitelistUsers.length > 0) {
          const baseTierId = BigInt(latestTierId);
          const wlData = iface.encodeFunctionData("addToWhitelist", [
            [[baseTierId + 1n, built.whitelistUsers, built.whitelistUri]],
          ]);
          actions.push({ executor: tokenSaleProposal, value: "0", data: wlData });
        }

        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "tokenSale",
          isMeta: false,
          changes: {
            proposedChanges: { tier, derivedMerkleRoots: built.derivedRoots },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Token Sale tier → ${tier.name}`,
          detail: `Target: TokenSaleProposal(${tokenSaleProposal}).createTiers (1 tier${
            built.whitelistUsers.length > 0 ? " + addToWhitelist" : ""
          })`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerTokenSaleWhitelist(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_sale_whitelist",
    {
      title: "Build an addToWhitelist proposal for existing token-sale tiers",
      description:
        "Builds an external proposal calling `TokenSaleProposal.addToWhitelist([{tierId, users, uri}, ...])`. Use this to extend the whitelist of a tier that's already live (plain `Whitelist` participation type only — merkle tiers are gated by their root, not this list).",
      inputSchema: {
        tokenSaleProposal: z.string(),
        requests: z
          .array(
            z.object({
              tierId: z.string(),
              users: z.array(z.string()).min(1),
              uri: z.string().default(""),
            }),
          )
          .min(1),
        proposalName: z.string().default("Whitelist Token Sale Tier"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      tokenSaleProposal,
      requests,
      proposalName = "Whitelist Token Sale Tier",
      proposalDescription = "",
    }) => {
      if (!isAddress(tokenSaleProposal)) {
        return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      }
      try {
        const normalised = requests.map((r) => {
          for (const u of r.users) {
            if (!isAddress(u)) throw new Error(`Invalid whitelist user: ${u}`);
          }
          return [
            BigInt(r.tierId),
            r.users.map((u) => getAddress(u)),
            r.uri ?? "",
          ];
        });
        const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("addToWhitelist", [normalised]);
        const actions: Action[] = [{ executor: tokenSaleProposal, value: "0", data }];

        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "tokenSale",
          isMeta: false,
          changes: {
            proposedChanges: { requests },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `addToWhitelist (${requests.length} request${requests.length === 1 ? "" : "s"})`,
          detail: `Target: TokenSaleProposal(${tokenSaleProposal}).addToWhitelist`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 3. token_sale_recover ----------

function registerTokenSaleRecover(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_token_sale_recover",
    {
      title: "Wrapper: recover unsold tokens from token-sale tiers",
      description:
        "Builds a 'Recover Token Sale' external proposal calling TokenSaleProposal.recover(tierIds).",
      inputSchema: {
        tokenSaleProposal: z.string(),
        tierIds: z.array(z.string()).min(1),
        proposalName: z.string().default("Recover Token Sale"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      tokenSaleProposal,
      tierIds,
      proposalName = "Recover Token Sale",
      proposalDescription = "",
    }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      try {
        const iface = new Interface(TOKEN_SALE_PROPOSAL_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("recover", [tierIds.map((n) => BigInt(n))]);
        const actions: Action[] = [{ executor: tokenSaleProposal, value: "0", data }];
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "recoverTokenSale",
          isMeta: false,
          changes: {
            proposedChanges: { tierIds },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Recover tiers [${tierIds.join(", ")}]`,
          detail: `Target: TokenSaleProposal(${tokenSaleProposal}).recover`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 4. create_staking_tier ----------

function registerCreateStakingTier(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_create_staking_tier",
    {
      title: "Wrapper: create a staking pool/tier via StakingProposal.createStaking",
      description:
        "Builds a 'Create Staking Tier' external proposal calling StakingProposal.createStaking(rewardToken, rewardAmount, startedAt, deadline, metadata). For ERC20 reward tokens, automatically prepends an ERC20.approve action. For native tokens (isNative=true), sets the action value instead. Address source: GovUserKeeper.stakingProposalAddress() — zero address means it isn't deployed yet (GovUserKeeper.deployStakingProposal() creates it). The dexe_proposal_create composite auto-resolves this when the param is omitted.",
      inputSchema: {
        stakingProposal: z
          .string()
          .describe("StakingProposal contract address (from GovUserKeeper.stakingProposalAddress())"),
        rewardToken: z.string(),
        rewardAmount: z.string(),
        startedAt: z.string().describe("Unix seconds"),
        deadline: z.string().describe("Unix seconds"),
        stakingMetadataUrl: z.string().describe("ipfs://<cid> of staking-specific metadata"),
        isNative: z.boolean().default(false).describe("True when reward token is native (BNB/ETH)"),
        proposalName: z.string().default("Create Staking"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      stakingProposal,
      rewardToken,
      rewardAmount,
      startedAt,
      deadline,
      stakingMetadataUrl,
      isNative = false,
      proposalName = "Create Staking",
      proposalDescription = "",
    }) => {
      if (!isAddress(stakingProposal)) return errorResult(`Invalid stakingProposal: ${stakingProposal}`);
      if (!isAddress(rewardToken)) return errorResult(`Invalid rewardToken: ${rewardToken}`);
      try {
        const iface = new Interface(STAKING_PROPOSAL_ABI as unknown as string[]);
        const createData = iface.encodeFunctionData("createStaking", [
          rewardToken,
          BigInt(rewardAmount),
          BigInt(startedAt),
          BigInt(deadline),
          stakingMetadataUrl,
        ]);
        const actions: Action[] = [];
        if (isNative) {
          actions.push({ executor: stakingProposal, value: rewardAmount, data: createData });
        } else {
          const erc20Iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
          const approveData = erc20Iface.encodeFunctionData("approve", [stakingProposal, BigInt(rewardAmount)]);
          actions.push({ executor: rewardToken, value: "0", data: approveData });
          actions.push({ executor: stakingProposal, value: "0", data: createData });
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "createStakingTier",
          isMeta: false,
          changes: {
            proposedChanges: {
              rewardToken,
              rewardAmount,
              startedAt,
              deadline,
              metadata: stakingMetadataUrl,
            },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Create Staking → ${rewardAmount} of ${rewardToken}`,
          detail: `Target: StakingProposal(${stakingProposal}).createStaking`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 5. change_math_model ----------

function registerChangeMathModel(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_change_math_model",
    {
      title: "Wrapper: swap the DAO's vote-power math contract",
      description:
        "Builds a 'Change Math Model' external proposal calling GovPool.changeVotePower(newVotePower). `newVotePower` is the address of a deployed power contract (LINEAR_POWER, POLYNOMIAL_POWER, or a custom one registered in PoolRegistry).",
      inputSchema: {
        govPool: z.string(),
        newVotePower: z.string(),
        proposalName: z.string().default("Change Vote Power"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      newVotePower,
      proposalName = "Change Vote Power",
      proposalDescription = "",
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(newVotePower)) return errorResult(`Invalid newVotePower: ${newVotePower}`);
      try {
        const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("changeVotePower", [newVotePower]);
        const actions: Action[] = [{ executor: govPool, value: "0", data }];
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "mathModel",
          isMeta: false,
          changes: {
            proposedChanges: { newVotePower },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Change Vote Power → ${newVotePower}`,
          detail: `Target: GovPool(${govPool}).changeVotePower\n\n${CHANGE_VOTE_POWER_ADVISORY}`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 6. modify_dao_profile ----------

function registerModifyDaoProfile(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_modify_dao_profile",
    {
      title: "Wrapper: update the DAO descriptionURL (name, avatar, links)",
      description:
        "Builds a 'Modify DAO Profile' external proposal calling GovPool.editDescriptionURL(url). You upload the new DAO metadata JSON to IPFS first (via dexe_ipfs_upload_dao_metadata), then pass the resulting descriptionURL (ipfs://<cid>) here.",
      inputSchema: {
        govPool: z.string(),
        newDescriptionURL: z.string().describe("ipfs://<cid> of new DAO metadata JSON"),
        proposalName: z.string().default("Modify DAO Profile"),
        proposalDescription: z.string().default(""),
        previousDescriptionURL: z.string().optional(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govPool,
      newDescriptionURL,
      proposalName = "Modify DAO Profile",
      proposalDescription = "",
      previousDescriptionURL,
    }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
        const data = iface.encodeFunctionData("editDescriptionURL", [newDescriptionURL]);
        const actions: Action[] = [{ executor: govPool, value: "0", data }];
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "daoProfileModification",
          // MUST be false: the frontend profile-diff component decodes actions
          // assuming a meta-wrapped payload when isMeta=true and blanks the
          // "Proposed changes" UI for this single-action proposal (PR #17).
          isMeta: false,
          changes: {
            proposedChanges: { descriptionUrl: newDescriptionURL },
            currentChanges: { descriptionUrl: previousDescriptionURL ?? null },
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Modify DAO Profile → ${newDescriptionURL}`,
          detail: `Target: GovPool(${govPool}).editDescriptionURL`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 7. blacklist_management ----------

function registerBlacklistManagement(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_blacklist",
    {
      title: "Wrapper: add/remove addresses from the DAO token blacklist",
      description:
        "Builds a 'Blacklist Management' external proposal. Emits up to 2 actions: one ERC20Gov.blacklist(add, true) and one ERC20Gov.blacklist(remove, false). Pass empty arrays to skip either.",
      inputSchema: {
        erc20Gov: z.string().describe("DAO ERC20Gov token contract"),
        addAddresses: z.array(z.string()).default([]),
        removeAddresses: z.array(z.string()).default([]),
        proposalName: z.string().default("Blacklist Management"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      erc20Gov,
      addAddresses = [],
      removeAddresses = [],
      proposalName = "Blacklist Management",
      proposalDescription = "",
    }) => {
      if (!isAddress(erc20Gov)) return errorResult(`Invalid erc20Gov: ${erc20Gov}`);
      for (const a of [...addAddresses, ...removeAddresses]) {
        if (!isAddress(a)) return errorResult(`Invalid blacklist address: ${a}`);
      }
      if (addAddresses.length === 0 && removeAddresses.length === 0) {
        return errorResult("Must supply at least one address to add or remove");
      }
      try {
        const iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
        const actions: Action[] = [];
        if (addAddresses.length) {
          actions.push({
            executor: erc20Gov,
            value: "0",
            data: iface.encodeFunctionData("blacklist", [addAddresses, true]),
          });
        }
        if (removeAddresses.length) {
          actions.push({
            executor: erc20Gov,
            value: "0",
            data: iface.encodeFunctionData("blacklist", [removeAddresses, false]),
          });
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "blacklistManagement",
          isMeta: false,
          changes: {
            proposedChanges: { addBlacklist: addAddresses, removeBlacklist: removeAddresses },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Blacklist: +${addAddresses.length} / -${removeAddresses.length}`,
          detail: `Target: ERC20Gov(${erc20Gov}).blacklist (${actions.length} action${actions.length === 1 ? "" : "s"})`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 8. reward_multiplier ----------

function registerRewardMultiplier(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_reward_multiplier",
    {
      title: "Wrapper: manage the DAO's reward-multiplier NFT contract",
      description:
        "Four modes: 'set_address' (GovPool.setNftMultiplierAddress — ZERO to disable), 'set_token_uri', 'mint' (ERC721Multiplier.mint(to, multiplier, duration, uri_)), 'change_token' (modify an existing NFT). UNITS: `multiplier` is PRECISION-scaled — 1e25 = 1x, so 1.5x = 15000000000000000000000000; `rewardPeriod` = lock duration in SECONDS (uint64). The ERC721Multiplier MUST be owned by the GovPool (mint is onlyOwner): pass `govPool` to refuse up-front (needs RPC) when the contract is undeployed or not GovPool-owned — else the proposal sticks in SucceededFor (bug #31).",
      inputSchema: {
        mode: z.enum(["set_address", "set_token_uri", "mint", "change_token"]),
        govPool: z
          .string()
          .optional()
          .describe("DAO GovPool. Required for set_address; enables the ownership pre-check for other modes."),
        nftMultiplierContract: z.string().optional(),
        newMultiplierAddress: z.string().optional().describe("For mode=set_address"),
        tokenId: numericIntString.optional().describe("For mode=set_token_uri or change_token"),
        uri: z.string().optional().describe("For mode=set_token_uri"),
        to: z.string().optional().describe("For mode=mint"),
        multiplier: numericIntString
          .optional()
          .describe(
            "For mode=mint or change_token. Scaled by PRECISION = 1e25 (1.5x => 15000000000000000000000000 = 1.5e25).",
          ),
        rewardPeriod: numericIntString
          .default("0")
          .describe("For mode=mint or change_token. Lock duration in SECONDS (uint64)."),
        metadataUrl: z.string().default("").describe("For mode=mint — metadata URI string"),
        proposalName: z.string().default("Reward Multiplier"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async (input) => {
      const { mode, proposalName = "Reward Multiplier", proposalDescription = "" } = input;
      try {
        const actions: Action[] = [];
        const warnings: string[] = [];
        if (mode === "set_address") {
          if (!input.govPool || !isAddress(input.govPool))
            return errorResult(`set_address requires valid govPool`);
          const addr = input.newMultiplierAddress ?? ZeroAddress;
          if (!isAddress(addr)) return errorResult(`Invalid newMultiplierAddress: ${addr}`);
          const iface = new Interface(GOV_POOL_EXT_ABI as unknown as string[]);
          actions.push({
            executor: input.govPool,
            value: "0",
            data: iface.encodeFunctionData("setNftMultiplierAddress", [addr]),
          });
        } else if (mode === "set_token_uri") {
          if (!input.nftMultiplierContract || !isAddress(input.nftMultiplierContract))
            return errorResult(`set_token_uri requires valid nftMultiplierContract`);
          if (!input.tokenId) return errorResult(`set_token_uri requires tokenId`);
          if (input.uri === undefined) return errorResult(`set_token_uri requires uri`);
          const pre = await precheckMultiplierContract(ctx.config, {
            govPool: input.govPool,
            multiplierContract: input.nftMultiplierContract,
            checkCurrentAddress: false,
          });
          if (pre.refuse) return errorResult(pre.refuse);
          warnings.push(...pre.warnings);
          const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
          actions.push({
            executor: input.nftMultiplierContract,
            value: "0",
            data: iface.encodeFunctionData("setTokenURI", [BigInt(input.tokenId), input.uri]),
          });
        } else if (mode === "change_token") {
          if (!input.nftMultiplierContract || !isAddress(input.nftMultiplierContract))
            return errorResult(`change_token requires valid nftMultiplierContract`);
          if (!input.tokenId) return errorResult(`change_token requires tokenId`);
          if (!input.multiplier) return errorResult(`change_token requires multiplier`);
          const multiplierBn = BigInt(input.multiplier);
          if (multiplierBn === 0n)
            return errorResult(
              `change_token: multiplier=0 is meaningless — pass 1.5e25 for 1.5x (PRECISION=1e25).`,
            );
          if (multiplierBn < ERC721_MULTIPLIER_PRECISION / 100n)
            return errorResult(
              `change_token: multiplier ${multiplierBn} is suspiciously small — values are scaled by PRECISION=1e25 (1.5x => 1.5e25). Did you forget the scale?`,
            );
          if (multiplierBn > ERC721_MULTIPLIER_MAX)
            return errorResult(
              `change_token: multiplier ${multiplierBn} looks over-scaled (> 100x = 1e27). PRECISION=1e25, so 1.5x = 15000000000000000000000000.`,
            );
          const durationBn = BigInt(input.rewardPeriod ?? "0");
          if (durationBn > UINT64_MAX)
            return errorResult(`change_token: rewardPeriod ${durationBn} > uint64 max ${UINT64_MAX}.`);
          const pre = await precheckMultiplierContract(ctx.config, {
            govPool: input.govPool,
            multiplierContract: input.nftMultiplierContract,
            checkCurrentAddress: true,
            selectorCheck: "change_token",
          });
          if (pre.refuse) return errorResult(pre.refuse);
          warnings.push(...pre.warnings);
          const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
          actions.push({
            executor: input.nftMultiplierContract,
            value: "0",
            data: iface.encodeFunctionData("changeToken", [
              BigInt(input.tokenId),
              multiplierBn,
              durationBn,
            ]),
          });
        } else {
          // mint — mint(address, uint256, uint64, string). The uint64 vs uint256
          // matters: ethers derives the selector from the canonical sig, so a
          // wrong-typed arg yields a different selector → silent revert with no
          // returndata when GovPool.execute calls into the multiplier.
          if (!input.nftMultiplierContract || !isAddress(input.nftMultiplierContract))
            return errorResult(`mint requires valid nftMultiplierContract`);
          if (!input.to || !isAddress(input.to)) return errorResult(`mint requires valid to`);
          if (input.to === ZeroAddress)
            return errorResult(
              `mint: recipient 'to' is the zero address — ERC721 mint to 0x0 reverts. Pass the real holder address.`,
            );
          if (!input.multiplier) return errorResult(`mint requires multiplier`);
          const multiplierBn = BigInt(input.multiplier);
          if (multiplierBn === 0n)
            return errorResult(
              `mint: multiplier=0 is meaningless — pass 1.5e25 for 1.5x (PRECISION=1e25).`,
            );
          if (multiplierBn < ERC721_MULTIPLIER_PRECISION / 100n)
            return errorResult(
              `mint: multiplier ${multiplierBn} is suspiciously small — values are scaled by PRECISION=1e25 (1.5x => 1.5e25). Did you forget the scale?`,
            );
          if (multiplierBn > ERC721_MULTIPLIER_MAX)
            return errorResult(
              `mint: multiplier ${multiplierBn} looks over-scaled (> 100x = 1e27). PRECISION=1e25, so 1.5x = 15000000000000000000000000.`,
            );
          const durationBn = BigInt(input.rewardPeriod ?? "0");
          if (durationBn === 0n)
            return errorResult(`mint: rewardPeriod must be > 0 seconds (lock duration).`);
          if (durationBn > UINT64_MAX)
            return errorResult(`mint: rewardPeriod ${durationBn} > uint64 max ${UINT64_MAX}.`);
          const pre = await precheckMultiplierContract(ctx.config, {
            govPool: input.govPool,
            multiplierContract: input.nftMultiplierContract,
            checkCurrentAddress: true,
            selectorCheck: "mint",
          });
          if (pre.refuse) return errorResult(pre.refuse);
          warnings.push(...pre.warnings);
          const iface = new Interface(ERC721_MULTIPLIER_ABI as unknown as string[]);
          actions.push({
            executor: input.nftMultiplierContract,
            value: "0",
            data: iface.encodeFunctionData("mint", [
              input.to,
              multiplierBn,
              durationBn,
              input.metadataUrl ?? "",
            ]),
          });
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "rewardMultiplier",
          isMeta: false,
          changes: {
            proposedChanges: { ...input, mode },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `Reward Multiplier (${mode})`,
          detail: `${actions.length} action${actions.length === 1 ? "" : "s"} encoded`,
          ...(warnings.length ? { advisories: warnings } : {}),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 9. apply_to_dao ----------

function registerApplyToDao(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_proposal_build_apply_to_dao",
    {
      title: "Wrapper: apply for/disburse DAO tokens to a receiver (transfer + optional mint)",
      description:
        "Builds an 'Apply to DAO' external proposal. If the DAO treasury has enough tokens, emits one ERC20.transfer action. If not, emits ERC20Gov.transfer + ERC20Gov.mint for the shortfall. Pass `treasuryBalance` (in wei) so we decide correctly. When DEXE_RPC_URL is set the receiver is checked against ERC20Gov.isBlacklisted; build aborts if blacklisted (avoids stuck SucceededFor proposals).",
      inputSchema: {
        token: z.string().describe("The token contract (ERC20 or ERC20Gov)"),
        receiver: z.string(),
        amount: z.string().describe("Total amount to grant, in wei"),
        treasuryBalance: z
          .string()
          .default("0")
          .describe("Current treasury balance of `token`. If >= amount, a single transfer is used."),
        proposalName: z.string().default("Apply to DAO"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      token,
      receiver,
      amount,
      treasuryBalance = "0",
      proposalName = "Apply to DAO",
      proposalDescription = "",
    }) => {
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      if (!isAddress(receiver)) return errorResult(`Invalid receiver: ${receiver}`);
      try {
        const bl = await checkBlacklist(ctx.config, token, receiver);
        if (bl.status === "blacklisted") return errorResult(blacklistError(token, receiver));
        const iface = new Interface(ERC20_GOV_ABI as unknown as string[]);
        const actions: Action[] = [];
        const total = parseUintString(amount, "amount");
        const have = parseUintString(treasuryBalance, "treasuryBalance");
        if (have >= total) {
          // Treasury covers it: a single transfer of the full amount.
          actions.push({
            executor: token,
            value: "0",
            data: iface.encodeFunctionData("transfer", [receiver, total]),
          });
        } else {
          // H-4: short treasury. Transfer only what the treasury actually holds
          // (transferring `total` would revert), then mint the shortfall to the
          // receiver so they still net the full grant. The previous code
          // transferred `total` unconditionally and the proposal reverted on
          // execution.
          if (have > 0n) {
            actions.push({
              executor: token,
              value: "0",
              data: iface.encodeFunctionData("transfer", [receiver, have]),
            });
          }
          const shortfall = total - have;
          actions.push({
            executor: token,
            value: "0",
            data: iface.encodeFunctionData("mint", [receiver, shortfall]),
          });
        }
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "applyToDao",
          isMeta: false,
          changes: {
            proposedChanges: { receiver, tokenAmount: amount, tokenAddress: token },
            currentChanges: { treasuryBalance },
          },
        };
        const blacklistNote =
          bl.status === "skipped" ? `Blacklist precheck skipped: ${bl.reason}` : "Recipient not blacklisted.";
        const treasuryAdvisory = buildTimeTreasuryAdvisory(actions, ctx.config.treasuryGuard);
        return wrapperResult({
          metadata,
          actions,
          title: `Apply to DAO: ${amount} of ${token} → ${receiver}`,
          detail:
            `${actions.length} action${actions.length === 1 ? "" : "s"} (transfer${actions.length > 1 ? " + mint" : ""}). ${blacklistNote}` +
            (treasuryAdvisory ? `\n\n${treasuryAdvisory}` : ""),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- 10. new_proposal_type (also: enable_staking) ----------

function registerNewProposalType(server: McpServer): void {
  server.registerTool(
    "dexe_proposal_build_new_proposal_type",
    {
      title: "Wrapper: register a new proposal settings template + bind executors",
      description:
        "Builds a 'New Proposal Type' external proposal with 2 actions: GovSettings.addSettings([newSettings]) + GovSettings.changeExecutors(executors, [newSettingId, …]). This is also the path for enabling staking (executors include StakingProposal).",
      inputSchema: {
        govSettings: z.string(),
        settings: z.object({
          earlyCompletion: z.boolean(),
          delegatedVotingAllowed: z.boolean(),
          validatorsVote: z.boolean(),
          duration: z.string(),
          durationValidators: z.string(),
          executionDelay: z.string().default("0"),
          quorum: z.string(),
          quorumValidators: z.string(),
          minVotesForVoting: z.string(),
          minVotesForCreating: z.string(),
          rewardsInfo: z.object({
            rewardToken: z.string(),
            creationReward: z.string().default("0"),
            executionReward: z.string().default("0"),
            voteRewardsCoefficient: z.string().default("0"),
          }),
          executorDescription: z.string().default(""),
        }),
        executors: z.array(z.string()).min(1),
        newSettingId: z
          .string()
          .describe(
            "Id the new setting will receive on GovSettings (= current getSettingsLength()). The agent reads this before building.",
          ),
        proposalName: z.string().default("New Proposal Type"),
        proposalDescription: z.string().default(""),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({
      govSettings,
      settings,
      executors,
      newSettingId,
      proposalName = "New Proposal Type",
      proposalDescription = "",
    }) => {
      if (!isAddress(govSettings)) return errorResult(`Invalid govSettings: ${govSettings}`);
      for (const e of executors) {
        if (!isAddress(e)) return errorResult(`Invalid executor: ${e}`);
      }
      try {
        const iface = new Interface(GOV_SETTINGS_FULL_ABI as unknown as string[]);
        const tuple = [
          settings.earlyCompletion,
          settings.delegatedVotingAllowed,
          settings.validatorsVote,
          BigInt(settings.duration),
          BigInt(settings.durationValidators),
          BigInt(settings.executionDelay),
          BigInt(settings.quorum),
          BigInt(settings.quorumValidators),
          BigInt(settings.minVotesForVoting),
          BigInt(settings.minVotesForCreating),
          [
            settings.rewardsInfo.rewardToken,
            BigInt(settings.rewardsInfo.creationReward),
            BigInt(settings.rewardsInfo.executionReward),
            BigInt(settings.rewardsInfo.voteRewardsCoefficient),
          ],
          settings.executorDescription,
        ];
        const addData = iface.encodeFunctionData("addSettings", [[tuple]]);
        const changeData = iface.encodeFunctionData("changeExecutors", [
          executors,
          executors.map(() => BigInt(newSettingId)),
        ]);
        const actions: Action[] = [
          { executor: govSettings, value: "0", data: addData },
          { executor: govSettings, value: "0", data: changeData },
        ];
        const metadata = {
          proposalName,
          proposalDescription: JSON.stringify(markdownToSlate(proposalDescription)),
          category: "createProposalType",
          isMeta: false,
          changes: {
            proposedChanges: { settings, executors, newSettingId },
            currentChanges: {},
          },
        };
        return wrapperResult({
          metadata,
          actions,
          title: `New Proposal Type (settingsId=${newSettingId}, ${executors.length} executors)`,
          detail: `Target: GovSettings(${govSettings}).addSettings + changeExecutors (2 actions)`,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
