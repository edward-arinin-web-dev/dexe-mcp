import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { buildPayload, type TxPayload } from "../lib/calldata.js";

/**
 * Phase 4 — user-facing write calldata builders.
 *
 * Every tool returns `{ payload: TxPayload }` — a signable single tx. For
 * atomic combos (deposit+delegate, execute+claim), use
 * `dexe_vote_build_multicall` which wraps inner calldata into
 * GovPool.multicall(bytes[] calls).
 *
 * Arg-order gotchas (verified against frontend hooks, 2026-04-15):
 *   GovPool.vote(proposalId, isVoteFor, amount, nftIds)          ← (pid, bool, amt, nfts)
 *   GovValidators.voteInternalProposal(proposalId, amount, isVoteFor)   ← (pid, amt, bool) — different!
 *   GovValidators.voteExternalProposal(proposalId, amount, isVoteFor)
 *   GovPool.claimRewards(proposalIds[], user)
 *   GovPool.claimMicropoolRewards(proposalIds[], delegator, delegatee)
 *
 * User-level delegate/undelegate live on GovPool (not GovUserKeeper).
 * Treasury-level delegation is a proposal (see Phase 3b).
 */

const GOV_POOL_WRITE_ABI = [
  "function deposit(uint256 amount, uint256[] nftIds) payable",
  "function withdraw(address receiver, uint256 amount, uint256[] nftIds)",
  "function delegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function undelegate(address delegatee, uint256 amount, uint256[] nftIds)",
  "function vote(uint256 proposalId, bool isVoteFor, uint256 voteAmount, uint256[] voteNftIds)",
  "function cancelVote(uint256 proposalId)",
  "function moveProposalToValidators(uint256 proposalId)",
  "function execute(uint256 proposalId)",
  "function claimRewards(uint256[] proposalIds, address user)",
  "function claimMicropoolRewards(uint256[] proposalIds, address delegator, address delegatee)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
] as const;

const GOV_VALIDATORS_WRITE_ABI = [
  "function voteInternalProposal(uint256 proposalId, uint256 amount, bool isVoteFor)",
  "function voteExternalProposal(uint256 proposalId, uint256 amount, bool isVoteFor)",
  "function cancelVoteInternalProposal(uint256 proposalId)",
  "function cancelVoteExternalProposal(uint256 proposalId)",
] as const;

const ERC20_WRITE_ABI = ["function approve(address spender, uint256 amount) returns (bool)"] as const;

const TOKEN_SALE_WRITE_ABI = [
  "function buy(uint256 tierId, address tokenToBuyWith, uint256 amount, bytes32[] proof) payable",
  "function claim(uint256[] tierIds)",
  "function vestingWithdraw(uint256[] tierIds)",
] as const;

const DISTRIBUTION_WRITE_ABI = [
  "function claim(address voter, uint256[] proposalIds)",
] as const;

const NFT_MULTIPLIER_WRITE_ABI = [
  "function lock(uint256 tokenId)",
  "function unlock()",
] as const;

const USER_REGISTRY_WRITE_ABI = [
  "function agreeToPrivacyPolicy(bytes signature)",
  "function changeProfileAndAgreeToPrivacyPolicy(string profileURL, bytes signature)",
  "function documentHash() view returns (bytes32)",
  "function agreed(address user) view returns (bool)",
] as const;

const STAKING_WRITE_ABI = [
  "function claim(uint256 id)",
  "function claimAll()",
  "function reclaim(uint256 id)",
] as const;

const USER_KEEPER_ABI = [
  "function stakeTokens(uint256 tierId, uint256 amount)",
] as const;

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function payloadResult(payload: TxPayload) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${payload.description}\n  to   : ${payload.to}\n  value: ${payload.value}\n  data : ${payload.data.slice(0, 66)}…`,
      },
    ],
    structuredContent: { payload: { ...payload } as Record<string, unknown> },
  };
}

function payloadOutputSchema() {
  return {
    payload: z.object({
      to: z.string(),
      data: z.string(),
      value: z.string(),
      chainId: z.number(),
      description: z.string(),
    }),
  };
}

// ---------- register ----------

export function registerVoteBuildTools(server: McpServer, ctx: ToolContext): void {
  registerErc20Approve(server, ctx);
  registerDeposit(server, ctx);
  registerWithdraw(server, ctx);
  registerDelegate(server, ctx);
  registerUndelegate(server, ctx);
  registerVote(server, ctx);
  registerCancelVote(server, ctx);
  registerValidatorVote(server, ctx);
  registerValidatorCancelVote(server, ctx);
  registerMoveToValidators(server, ctx);
  registerExecute(server, ctx);
  registerClaimRewards(server, ctx);
  registerClaimMicropoolRewards(server, ctx);
  // NFT multiplier
  registerNftMultiplierLock(server, ctx);
  registerNftMultiplierUnlock(server, ctx);
  // Phase A — token sale + distribution participation
  registerTokenSaleBuy(server, ctx);
  registerTokenSaleClaim(server, ctx);
  registerTokenSaleVestingWithdraw(server, ctx);
  registerDistributionClaim(server, ctx);
  // Phase B — staking participation
  registerStakingStake(server, ctx);
  registerStakingClaim(server, ctx);
  registerStakingClaimAll(server, ctx);
  registerStakingReclaim(server, ctx);
  // Privacy policy
  registerPrivacyPolicySign(server, ctx);
  registerPrivacyPolicyAgree(server, ctx);
  registerMulticall(server, ctx);
}

// ---------- ERC20 approve ----------

function registerErc20Approve(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_erc20_approve",
    {
      title: "Build ERC20.approve(spender, amount) calldata",
      description:
        "Prepares an ERC20 approval tx. Prepend this before `dexe_vote_build_deposit` when staking an ERC20 token — DAO treasury uses GovPool as the spender. For native-coin staking (BNB/ETH) no approve is needed; just pass `value` on deposit.",
      inputSchema: {
        token: z.string(),
        spender: z.string().describe("Typically the GovPool address"),
        amount: z.string().describe("Wei amount; use max uint256 to grant unlimited"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ token, spender, amount }) => {
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      if (!isAddress(spender)) return errorResult(`Invalid spender: ${spender}`);
      try {
        const iface = new Interface(ERC20_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: token,
          iface,
          method: "approve",
          args: [spender, BigInt(amount)],
          chainId: ctx.config.chainId,
          contractLabel: "ERC20",
          description: `ERC20(${token}).approve(${spender}, ${amount})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- deposit ----------

function registerDeposit(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_deposit",
    {
      title: "Stake tokens/NFTs into a DAO to gain voting power",
      description:
        "Builds `GovPool.deposit(amount, nftIds)`. **payable** — for native-coin staking, pass `value` (wei). For ERC20 staking, pass `value=0` and ensure an ERC20 approve is already submitted.",
      inputSchema: {
        govPool: z.string(),
        amount: z.string().describe("Token amount in wei"),
        nftIds: z.array(z.string()).default([]),
        value: z
          .string()
          .default("0")
          .describe("Native coin (wei) for native-staking DAOs; 0 for ERC20"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, amount, nftIds = [], value = "0" }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "deposit",
          args: [BigInt(amount), nftIds.map((n) => BigInt(n))],
          value,
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.deposit(${amount} wei, ${nftIds.length} NFTs)${value !== "0" ? ` + ${value} native` : ""}`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- withdraw ----------

function registerWithdraw(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_withdraw",
    {
      title: "Unstake tokens/NFTs from a DAO",
      description: "Builds `GovPool.withdraw(receiver, amount, nftIds)`.",
      inputSchema: {
        govPool: z.string(),
        receiver: z.string(),
        amount: z.string(),
        nftIds: z.array(z.string()).default([]),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, receiver, amount, nftIds = [] }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(receiver)) return errorResult(`Invalid receiver: ${receiver}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "withdraw",
          args: [receiver, BigInt(amount), nftIds.map((n) => BigInt(n))],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.withdraw → ${receiver} (${amount} wei, ${nftIds.length} NFTs)`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- delegate (user-level) ----------

function registerDelegate(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_delegate",
    {
      title: "Delegate YOUR staked voting power to a delegatee",
      description:
        "Builds `GovPool.delegate(delegatee, amount, nftIds)`. This is the user-level delegation; for DAO treasury delegation use the `dexe_proposal_build_delegate_to_expert` wrapper instead.",
      inputSchema: {
        govPool: z.string(),
        delegatee: z.string(),
        amount: z.string(),
        nftIds: z.array(z.string()).default([]),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, delegatee, amount, nftIds = [] }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(delegatee)) return errorResult(`Invalid delegatee: ${delegatee}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "delegate",
          args: [delegatee, BigInt(amount), nftIds.map((n) => BigInt(n))],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.delegate → ${delegatee} (${amount} wei, ${nftIds.length} NFTs)`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- undelegate ----------

function registerUndelegate(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_undelegate",
    {
      title: "Undelegate voting power from a delegatee",
      description: "Builds `GovPool.undelegate(delegatee, amount, nftIds)`.",
      inputSchema: {
        govPool: z.string(),
        delegatee: z.string(),
        amount: z.string(),
        nftIds: z.array(z.string()).default([]),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, delegatee, amount, nftIds = [] }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(delegatee)) return errorResult(`Invalid delegatee: ${delegatee}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "undelegate",
          args: [delegatee, BigInt(amount), nftIds.map((n) => BigInt(n))],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.undelegate ← ${delegatee} (${amount} wei, ${nftIds.length} NFTs)`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- vote ----------

function registerVote(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_vote",
    {
      title: "Vote on an external proposal",
      description:
        "Builds `GovPool.vote(proposalId, isVoteFor, amount, nftIds)`. Arg order: (proposalId, isVoteFor, amount, nftIds). Must have staked/delegated voting power beforehand.",
      inputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
        isVoteFor: z.boolean(),
        amount: z.string(),
        nftIds: z.array(z.string()).default([]),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, proposalId, isVoteFor, amount, nftIds = [] }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "vote",
          args: [BigInt(proposalId), isVoteFor, BigInt(amount), nftIds.map((n) => BigInt(n))],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.vote(#${proposalId}, ${isVoteFor ? "FOR" : "AGAINST"}, ${amount} wei, ${nftIds.length} NFTs)`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- cancel vote ----------

function registerCancelVote(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_cancel_vote",
    {
      title: "Cancel your vote on an external proposal",
      description: "Builds `GovPool.cancelVote(proposalId)`.",
      inputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, proposalId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "cancelVote",
          args: [BigInt(proposalId)],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.cancelVote(#${proposalId})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- validator vote ----------

function registerValidatorVote(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_validator_vote",
    {
      title: "Validator vote on internal or external proposal",
      description:
        "Builds `GovValidators.vote{Internal,External}Proposal(proposalId, amount, isVoteFor)`. **Arg order differs from GovPool.vote** — here amount comes before isVoteFor. Requires validator stake.",
      inputSchema: {
        govValidators: z.string(),
        scope: z.enum(["internal", "external"]),
        proposalId: z.string(),
        amount: z.string(),
        isVoteFor: z.boolean(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govValidators, scope, proposalId, amount, isVoteFor }) => {
      if (!isAddress(govValidators)) return errorResult(`Invalid govValidators: ${govValidators}`);
      try {
        const iface = new Interface(GOV_VALIDATORS_WRITE_ABI as unknown as string[]);
        const method = scope === "internal" ? "voteInternalProposal" : "voteExternalProposal";
        const payload = buildPayload({
          to: govValidators,
          iface,
          method,
          args: [BigInt(proposalId), BigInt(amount), isVoteFor],
          chainId: ctx.config.chainId,
          contractLabel: "GovValidators",
          description: `GovValidators.${method}(#${proposalId}, ${amount}, ${isVoteFor ? "FOR" : "AGAINST"})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- validator cancel vote ----------

function registerValidatorCancelVote(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_validator_cancel_vote",
    {
      title: "Validator: cancel your vote on internal/external proposal",
      description:
        "Builds `GovValidators.cancelVote{Internal,External}Proposal(proposalId)`.",
      inputSchema: {
        govValidators: z.string(),
        scope: z.enum(["internal", "external"]),
        proposalId: z.string(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govValidators, scope, proposalId }) => {
      if (!isAddress(govValidators)) return errorResult(`Invalid govValidators: ${govValidators}`);
      try {
        const iface = new Interface(GOV_VALIDATORS_WRITE_ABI as unknown as string[]);
        const method = scope === "internal" ? "cancelVoteInternalProposal" : "cancelVoteExternalProposal";
        const payload = buildPayload({
          to: govValidators,
          iface,
          method,
          args: [BigInt(proposalId)],
          chainId: ctx.config.chainId,
          contractLabel: "GovValidators",
          description: `GovValidators.${method}(#${proposalId})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- move to validators ----------

function registerMoveToValidators(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_move_to_validators",
    {
      title: "Escalate a passing proposal to the validators tier",
      description: "Builds `GovPool.moveProposalToValidators(proposalId)`.",
      inputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, proposalId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "moveProposalToValidators",
          args: [BigInt(proposalId)],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.moveProposalToValidators(#${proposalId})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- execute ----------

function registerExecute(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_execute",
    {
      title: "Execute a passed proposal",
      description: "Builds `GovPool.execute(proposalId)`.",
      inputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, proposalId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "execute",
          args: [BigInt(proposalId)],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.execute(#${proposalId})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- claim rewards ----------

function registerClaimRewards(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_claim_rewards",
    {
      title: "Claim voter rewards for executed proposals",
      description: "Builds `GovPool.claimRewards(proposalIds, user)`.",
      inputSchema: {
        govPool: z.string(),
        proposalIds: z.array(z.string()).min(1),
        user: z.string(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, proposalIds, user }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "claimRewards",
          args: [proposalIds.map((p) => BigInt(p)), user],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.claimRewards([${proposalIds.join(",")}], ${user})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- claim micropool rewards ----------

function registerClaimMicropoolRewards(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_claim_micropool_rewards",
    {
      title: "Claim micropool (delegated) rewards",
      description:
        "Builds `GovPool.claimMicropoolRewards(proposalIds, delegator, delegatee)`. Called by the delegator to collect their share of rewards earned by their delegatee's votes.",
      inputSchema: {
        govPool: z.string(),
        proposalIds: z.array(z.string()).min(1),
        delegator: z.string(),
        delegatee: z.string(),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, proposalIds, delegator, delegatee }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(delegator)) return errorResult(`Invalid delegator: ${delegator}`);
      if (!isAddress(delegatee)) return errorResult(`Invalid delegatee: ${delegatee}`);
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "claimMicropoolRewards",
          args: [proposalIds.map((p) => BigInt(p)), delegator, delegatee],
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.claimMicropoolRewards([${proposalIds.join(",")}], ${delegator} → ${delegatee})`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- NFT multiplier ----------

function registerNftMultiplierLock(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_nft_multiplier_lock",
    {
      title: "Lock an NFT multiplier to boost voting power",
      description:
        "Builds calldata for `ERC721Multiplier.lock(tokenId)`. Locks a reward-multiplier NFT to apply its bonus to the caller's voting power.",
      inputSchema: {
        nftMultiplier: z.string().describe("ERC721Multiplier contract address (from dexe_dao_info → nftMultiplier)"),
        tokenId: z.string().describe("NFT token ID to lock"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ nftMultiplier, tokenId }) => {
      if (!isAddress(nftMultiplier)) return errorResult(`Invalid nftMultiplier: ${nftMultiplier}`);
      try {
        const iface = new Interface(NFT_MULTIPLIER_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: nftMultiplier,
          iface,
          method: "lock",
          args: [BigInt(tokenId)],
          chainId: ctx.config.chainId,
          contractLabel: "ERC721Multiplier",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerNftMultiplierUnlock(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_nft_multiplier_unlock",
    {
      title: "Unlock the NFT multiplier to reclaim it",
      description:
        "Builds calldata for `ERC721Multiplier.unlock()`. Removes the locked reward-multiplier NFT, returning it to the caller and removing the voting power bonus.",
      inputSchema: {
        nftMultiplier: z.string().describe("ERC721Multiplier contract address (from dexe_dao_info → nftMultiplier)"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ nftMultiplier }) => {
      if (!isAddress(nftMultiplier)) return errorResult(`Invalid nftMultiplier: ${nftMultiplier}`);
      try {
        const iface = new Interface(NFT_MULTIPLIER_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: nftMultiplier,
          iface,
          method: "unlock",
          args: [],
          chainId: ctx.config.chainId,
          contractLabel: "ERC721Multiplier",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- token sale participation ----------

function registerTokenSaleBuy(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_token_sale_buy",
    {
      title: "Buy tokens from a token sale tier",
      description:
        "Builds calldata for `TokenSaleProposal.buy(tierId, tokenToBuyWith, amount, proof)`. Pass `value` for native-coin purchases. Pass Merkle `proof` if the tier is whitelisted (empty array otherwise).",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        tierId: z.string().describe("Tier ID to buy from"),
        tokenToBuyWith: z.string().describe("Payment token address (zero address for native coin)"),
        amount: z.string().describe("Payment amount in wei"),
        proof: z.array(z.string()).default([]).describe("Merkle proof bytes32[] (empty if no whitelist)"),
        value: z.string().default("0").describe("Native-coin value in wei (for native purchases)"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ tokenSaleProposal, tierId, tokenToBuyWith, amount, proof = [], value = "0" }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      if (!isAddress(tokenToBuyWith)) return errorResult(`Invalid tokenToBuyWith: ${tokenToBuyWith}`);
      try {
        const iface = new Interface(TOKEN_SALE_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: tokenSaleProposal,
          iface,
          method: "buy",
          args: [BigInt(tierId), tokenToBuyWith, BigInt(amount), proof],
          value: BigInt(value),
          chainId: ctx.config.chainId,
          contractLabel: "TokenSaleProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerTokenSaleClaim(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_token_sale_claim",
    {
      title: "Claim purchased tokens from token sale tiers",
      description:
        "Builds calldata for `TokenSaleProposal.claim(tierIds)`. Call after the tier's claim lock duration has passed.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        tierIds: z.array(z.string()).min(1).describe("Tier IDs to claim from"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ tokenSaleProposal, tierIds }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      try {
        const iface = new Interface(TOKEN_SALE_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: tokenSaleProposal,
          iface,
          method: "claim",
          args: [tierIds.map((id) => BigInt(id))],
          chainId: ctx.config.chainId,
          contractLabel: "TokenSaleProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerTokenSaleVestingWithdraw(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_token_sale_vesting_withdraw",
    {
      title: "Withdraw vested tokens from token sale tiers",
      description:
        "Builds calldata for `TokenSaleProposal.vestingWithdraw(tierIds)`. For tiers with vesting schedules — withdraws the currently unlocked portion.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        tierIds: z.array(z.string()).min(1).describe("Tier IDs to withdraw vested tokens from"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ tokenSaleProposal, tierIds }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      try {
        const iface = new Interface(TOKEN_SALE_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: tokenSaleProposal,
          iface,
          method: "vestingWithdraw",
          args: [tierIds.map((id) => BigInt(id))],
          chainId: ctx.config.chainId,
          contractLabel: "TokenSaleProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- distribution participation ----------

function registerDistributionClaim(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_distribution_claim",
    {
      title: "Claim share from distribution proposals",
      description:
        "Builds calldata for `DistributionProposal.claim(voter, proposalIds)`. Claims the voter's proportional share from executed distribution proposals.",
      inputSchema: {
        distributionProposal: z.string().describe("DistributionProposal contract address"),
        voter: z.string().describe("Address of the voter claiming their share"),
        proposalIds: z.array(z.string()).min(1).describe("Proposal IDs to claim from"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ distributionProposal, voter, proposalIds }) => {
      if (!isAddress(distributionProposal)) return errorResult(`Invalid distributionProposal: ${distributionProposal}`);
      if (!isAddress(voter)) return errorResult(`Invalid voter: ${voter}`);
      try {
        const iface = new Interface(DISTRIBUTION_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: distributionProposal,
          iface,
          method: "claim",
          args: [voter, proposalIds.map((id) => BigInt(id))],
          chainId: ctx.config.chainId,
          contractLabel: "DistributionProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- staking participation ----------

function registerStakingStake(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_staking_stake",
    {
      title: "Stake tokens in a staking tier",
      description:
        "Builds calldata for `GovUserKeeper.stakeTokens(tierId, amount)`. Deposits tokens into the specified staking tier to earn rewards. Target is the GovUserKeeper contract (not StakingProposal).",
      inputSchema: {
        userKeeper: z.string().describe("GovUserKeeper contract address"),
        tierId: z.string().describe("Staking tier ID"),
        amount: z.string().describe("Amount to stake in wei"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ userKeeper, tierId, amount }) => {
      if (!isAddress(userKeeper)) return errorResult(`Invalid userKeeper: ${userKeeper}`);
      try {
        const iface = new Interface(USER_KEEPER_ABI as unknown as string[]);
        const payload = buildPayload({
          to: userKeeper,
          iface,
          method: "stakeTokens",
          args: [BigInt(tierId), BigInt(amount)],
          chainId: ctx.config.chainId,
          contractLabel: "GovUserKeeper",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerStakingClaim(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_staking_claim",
    {
      title: "Claim staking rewards from a tier",
      description:
        "Builds calldata for `StakingProposal.claim(id)`. Claims accumulated rewards from the specified staking tier without unstaking.",
      inputSchema: {
        stakingProposal: z.string().describe("StakingProposal contract address"),
        stakingId: z.string().describe("Staking tier ID to claim rewards from"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ stakingProposal, stakingId }) => {
      if (!isAddress(stakingProposal)) return errorResult(`Invalid stakingProposal: ${stakingProposal}`);
      try {
        const iface = new Interface(STAKING_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: stakingProposal,
          iface,
          method: "claim",
          args: [BigInt(stakingId)],
          chainId: ctx.config.chainId,
          contractLabel: "StakingProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerStakingClaimAll(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_staking_claim_all",
    {
      title: "Claim all staking rewards across all tiers",
      description:
        "Builds calldata for `StakingProposal.claimAll()`. Claims accumulated rewards from every active staking tier in one transaction.",
      inputSchema: {
        stakingProposal: z.string().describe("StakingProposal contract address"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ stakingProposal }) => {
      if (!isAddress(stakingProposal)) return errorResult(`Invalid stakingProposal: ${stakingProposal}`);
      try {
        const iface = new Interface(STAKING_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: stakingProposal,
          iface,
          method: "claimAll",
          args: [],
          chainId: ctx.config.chainId,
          contractLabel: "StakingProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function registerStakingReclaim(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_staking_reclaim",
    {
      title: "Unstake (reclaim) tokens from a staking tier",
      description:
        "Builds calldata for `StakingProposal.reclaim(id)`. Withdraws staked tokens and any pending rewards from the specified tier.",
      inputSchema: {
        stakingProposal: z.string().describe("StakingProposal contract address"),
        stakingId: z.string().describe("Staking tier ID to unstake from"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ stakingProposal, stakingId }) => {
      if (!isAddress(stakingProposal)) return errorResult(`Invalid stakingProposal: ${stakingProposal}`);
      try {
        const iface = new Interface(STAKING_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: stakingProposal,
          iface,
          method: "reclaim",
          args: [BigInt(stakingId)],
          chainId: ctx.config.chainId,
          contractLabel: "StakingProposal",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- privacy policy ----------

function registerPrivacyPolicySign(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_privacy_policy_sign",
    {
      title: "Build EIP712 typed data for privacy policy agreement",
      description:
        "Returns the EIP712 typed data that must be signed before calling `agreeToPrivacyPolicy`. The agent wallet signs this with `signTypedData`, then passes the signature to `dexe_vote_build_privacy_policy_agree`. One-time global action per user (not per-DAO).",
      inputSchema: {
        userRegistry: z.string().describe("UserRegistry contract address"),
        documentHash: z.string().describe("Privacy policy document hash (bytes32). Read from UserRegistry.documentHash() or use DEXE_PRIVACY_POLICY_HASH env var."),
      },
    },
    async ({ userRegistry, documentHash }) => {
      if (!isAddress(userRegistry)) return errorResult(`Invalid userRegistry: ${userRegistry}`);
      if (!documentHash.startsWith("0x") || documentHash.length !== 66) {
        return errorResult(`documentHash must be a bytes32 hex string (0x + 64 hex chars), got: ${documentHash}`);
      }
      const typedData = {
        domain: {
          name: "USER_REGISTRY",
          version: "1",
          chainId: ctx.config.chainId,
          verifyingContract: userRegistry,
        },
        types: {
          Agreement: [{ name: "documentHash", type: "bytes32" }],
        },
        primaryType: "Agreement" as const,
        message: {
          documentHash,
        },
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `EIP712 typed data for privacy policy agreement on ${userRegistry} (chainId=${ctx.config.chainId}). Sign with wallet's signTypedData, then pass signature to dexe_vote_build_privacy_policy_agree.`,
          },
        ],
        structuredContent: { typedData },
      };
    },
  );
}

function registerPrivacyPolicyAgree(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_privacy_policy_agree",
    {
      title: "Submit privacy policy agreement signature on-chain",
      description:
        "Builds calldata for `UserRegistry.agreeToPrivacyPolicy(signature)`. Pass the EIP712 signature obtained from signing the typed data (from `dexe_vote_build_privacy_policy_sign`). Optionally combine with profile URL update via `profileURL` param.",
      inputSchema: {
        userRegistry: z.string().describe("UserRegistry contract address"),
        signature: z.string().describe("EIP712 signature bytes (0x-prefixed hex)"),
        profileURL: z.string().optional().describe("Optional IPFS URL for user profile — if set, calls changeProfileAndAgreeToPrivacyPolicy instead"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ userRegistry, signature, profileURL }) => {
      if (!isAddress(userRegistry)) return errorResult(`Invalid userRegistry: ${userRegistry}`);
      if (!signature.startsWith("0x")) return errorResult(`Signature must be 0x-prefixed hex`);
      try {
        const iface = new Interface(USER_REGISTRY_WRITE_ABI as unknown as string[]);
        const method = profileURL ? "changeProfileAndAgreeToPrivacyPolicy" : "agreeToPrivacyPolicy";
        const args = profileURL ? [profileURL, signature] : [signature];
        const payload = buildPayload({
          to: userRegistry,
          iface,
          method,
          args,
          chainId: ctx.config.chainId,
          contractLabel: "UserRegistry",
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ---------- multicall wrapper ----------

function registerMulticall(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_vote_build_multicall",
    {
      title: "Atomic multicall on GovPool (batch multiple writes in one tx)",
      description:
        "Wraps N inner calldatas into `GovPool.multicall(calls)`. Pass the `data` fields from other build tools (e.g. deposit + delegate, execute + claim). Each inner call executes against GovPool itself — only use for GovPool methods.",
      inputSchema: {
        govPool: z.string(),
        calls: z.array(z.string()).min(2).describe("Array of 0x-hex calldatas to batch"),
        value: z.string().default("0").describe("Total native-coin value across the batch"),
      },
      outputSchema: payloadOutputSchema(),
    },
    async ({ govPool, calls, value = "0" }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      for (const c of calls) {
        if (!c.startsWith("0x")) return errorResult(`call must be 0x-prefixed hex: ${c.slice(0, 16)}…`);
      }
      try {
        const iface = new Interface(GOV_POOL_WRITE_ABI as unknown as string[]);
        const payload = buildPayload({
          to: govPool,
          iface,
          method: "multicall",
          args: [calls],
          value,
          chainId: ctx.config.chainId,
          contractLabel: "GovPool",
          description: `GovPool.multicall(${calls.length} calls)`,
        });
        return payloadResult(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
