import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { voteTypeFromString, VOTE_TYPE_NAMES } from "../lib/govEnums.js";
import { chainIdParam, govPoolParam, PROPOSAL_ID_DESC } from "../lib/params.js";
import { safeErrorMessage } from "../lib/redact.js";
import { toActionableError } from "../lib/errors.js";
import { GOV_POWER_DECIMALS, formatUnitsWithSymbol } from "../lib/units.js";

const GOV_POOL_HELPERS_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getUserVotes(uint256 proposalId, address voter, uint8 voteType) view returns (tuple(bool isVoteFor, uint256 totalVoted, uint256 tokensVoted, uint256 totalRawVoted, uint256[] nftsVoted))",
  "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256 rawVotesFor, uint256 rawVotesAgainst, uint256 voterRawVoted, bool isVoteFor)",
] as const;

const USER_KEEPER_ABI = [
  "function tokenBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
  "function nftBalance(address voter, uint8 voteType) view returns (uint256 balance, uint256 ownedBalance)",
] as const;

export function registerVoteTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  registerUserPower(server, rpc);
  registerGetVotes(server, rpc);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function registerUserPower(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_vote_user_power",
    {
      title: "User staking + delegation power across VoteTypes",
      description:
        "Read-only. Reads `tokenBalance` and `nftBalance` on GovUserKeeper for every VoteType " +
        "(Personal/Micropool/Delegated/Treasury) in one multicall. tokenBalance includes the un-deposited wallet balance; " +
        "deposited power = tokenBalance - tokenOwned.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        user: z.string().describe("User wallet address"),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        user: z.string(),
        userKeeper: z.string(),
        power: z.record(
          z.object({
            tokenBalance: z.string(),
            tokenOwned: z.string(),
            // GovUserKeeper.tokenBalance returns 18-DECIMAL-NORMALIZED power
            // (`balanceOf(voter).to18(token)`), NOT the gov token's own units —
            // formatting these with a 6-decimal gov token's decimals would
            // overstate them by 1e12. No `tokenSymbol` for the same reason:
            // these are power units, not a token quantity.
            tokenBalanceFormatted: z.string().optional(),
            tokenOwnedFormatted: z.string().optional(),
            // Counts, not amounts. Deliberately left raw.
            nftBalance: z.string(),
            nftOwned: z.string(),
          }),
        ),
      },
    },
    async ({ govPool, user, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool: ${govPool}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const gp = new Interface(GOV_POOL_HELPERS_ABI as unknown as string[]);
        const uk = new Interface(USER_KEEPER_ABI as unknown as string[]);

        const [helpersR] = await multicall(provider, [
          { target: govPool, iface: gp, method: "getHelperContracts", args: [] },
        ]);
        if (!helpersR?.success) return errorResult("getHelperContracts reverted");
        const userKeeper = (helpersR.value as unknown as { userKeeper: string }).userKeeper;

        const calls: Call[] = [];
        for (let vt = 0; vt < VOTE_TYPE_NAMES.length; vt++) {
          calls.push({
            target: userKeeper,
            iface: uk,
            method: "tokenBalance",
            args: [user, vt],
            allowFailure: true,
          });
          calls.push({
            target: userKeeper,
            iface: uk,
            method: "nftBalance",
            args: [user, vt],
            allowFailure: true,
          });
        }
        const results = await multicall(provider, calls);

        const power: Record<string, {
          tokenBalance: string;
          tokenOwned: string;
          tokenBalanceFormatted: string;
          tokenOwnedFormatted: string;
          nftBalance: string;
          nftOwned: string;
        }> = {};
        for (let vt = 0; vt < VOTE_TYPE_NAMES.length; vt++) {
          const tb = results[vt * 2];
          const nb = results[vt * 2 + 1];
          const tbv = tb?.success
            ? (tb.value as unknown as [bigint, bigint] | { balance: bigint; ownedBalance: bigint })
            : null;
          const nbv = nb?.success
            ? (nb.value as unknown as [bigint, bigint] | { balance: bigint; ownedBalance: bigint })
            : null;
          const pick = (
            v: [bigint, bigint] | { balance: bigint; ownedBalance: bigint } | null,
          ): [string, string] => {
            if (!v) return ["0", "0"];
            if (Array.isArray(v)) return [v[0].toString(), v[1].toString()];
            return [v.balance.toString(), v.ownedBalance.toString()];
          };
          const [tBal, tOwn] = pick(tbv);
          const [nBal, nOwn] = pick(nbv);
          power[VOTE_TYPE_NAMES[vt]!] = {
            tokenBalance: tBal,
            tokenOwned: tOwn,
            tokenBalanceFormatted: formatUnitsWithSymbol(tBal, GOV_POWER_DECIMALS),
            tokenOwnedFormatted: formatUnitsWithSymbol(tOwn, GOV_POWER_DECIMALS),
            nftBalance: nBal,
            nftOwned: nOwn,
          };
        }

        const structured = {
          govPool,
          user,
          userKeeper,
          powerDecimals: GOV_POWER_DECIMALS,
          power,
        };
        const lines = VOTE_TYPE_NAMES.map((name) => {
          const p = power[name]!;
          return (
            `  ${name.padEnd(14)} token=${p.tokenBalanceFormatted} (owned=${p.tokenOwnedFormatted})` +
            `  nft=${p.nftBalance} (owned=${p.nftOwned})  [raw ${p.tokenBalance}/${p.tokenOwned}]`
          );
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Voting power for ${user} on ${govPool}\nUserKeeper: ${userKeeper}\n` +
                `Token amounts are 18-decimal-normalized voting power, not the gov token's own units.\n` +
                lines.join("\n"),
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_vote_user_power").message,
        );
      }
    },
  );
}

function registerGetVotes(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_vote_get_votes",
    {
      title: "User's votes on a specific proposal",
      description:
        "Read-only. Reads `GovPool.getUserVotes(proposalId, voter, voteType)` and returns the VoteInfoView. Defaults to PersonalVote.",
      inputSchema: {
        govPool: govPoolParam,
        proposalId: z.union([z.string(), z.number()]).describe(PROPOSAL_ID_DESC),
        voter: z.string().describe("Wallet whose votes to read."),
        voteType: z
          .enum(["PersonalVote", "MicropoolVote", "DelegatedVote", "TreasuryVote"])
          .default("PersonalVote")
          .describe("Which VoteType bucket to read."),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.string(),
        voter: z.string(),
        voteType: z.string(),
        isVoteFor: z.boolean(),
        totalVoted: z.string(),
        tokensVoted: z.string(),
        totalRawVoted: z.string(),
        // Same 18-decimal normalization as the keeper balances they derive from.
        totalVotedFormatted: z.string().optional(),
        tokensVotedFormatted: z.string().optional(),
        totalRawVotedFormatted: z.string().optional(),
        powerDecimals: z.number().optional(),
        // NFT token ids, not amounts.
        nftsVoted: z.array(z.string()),
      },
    },
    async ({ govPool, proposalId, voter, voteType = "PersonalVote", chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(voter)) return errorResult(`Invalid voter: ${voter}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(GOV_POOL_HELPERS_ABI as unknown as string[]);
        const id = BigInt(proposalId as string);
        const vtNum = voteTypeFromString(voteType);
        const [res] = await multicall(provider, [
          {
            target: govPool,
            iface,
            method: "getUserVotes",
            args: [id, voter, vtNum],
          },
        ]);
        if (!res?.success) return errorResult("getUserVotes reverted");
        const v = res.value as unknown as {
          isVoteFor: boolean;
          totalVoted: bigint;
          tokensVoted: bigint;
          totalRawVoted: bigint;
          nftsVoted: bigint[];
        };
        const structured = {
          govPool,
          proposalId: id.toString(),
          voter,
          voteType,
          isVoteFor: v.isVoteFor,
          totalVoted: v.totalVoted.toString(),
          tokensVoted: v.tokensVoted.toString(),
          totalRawVoted: v.totalRawVoted.toString(),
          totalVotedFormatted: formatUnitsWithSymbol(v.totalVoted, GOV_POWER_DECIMALS),
          tokensVotedFormatted: formatUnitsWithSymbol(v.tokensVoted, GOV_POWER_DECIMALS),
          totalRawVotedFormatted: formatUnitsWithSymbol(v.totalRawVoted, GOV_POWER_DECIMALS),
          powerDecimals: GOV_POWER_DECIMALS,
          nftsVoted: v.nftsVoted.map((n) => n.toString()),
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Vote by ${voter} on proposal ${id} (${voteType}):\n` +
                `  isVoteFor     : ${v.isVoteFor}\n` +
                `  totalVoted    : ${structured.totalVotedFormatted} (raw ${v.totalVoted})\n` +
                `  tokensVoted   : ${structured.tokensVotedFormatted} (raw ${v.tokensVoted})\n` +
                `  totalRawVoted : ${structured.totalRawVotedFormatted} (raw ${v.totalRawVoted})\n` +
                `  nftsVoted     : [${structured.nftsVoted.join(", ")}]`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_vote_get_votes").message,
        );
      }
    },
  );
}
