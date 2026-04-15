import { z } from "zod";
import { Interface, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { voteTypeFromString, VOTE_TYPE_NAMES } from "../lib/govEnums.js";

const GOV_POOL_HELPERS_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getUserVotes(uint256 proposalId, address voter, uint8 voteType) view returns (tuple(bool isVoteFor, uint256 totalVoted, uint256 tokensVoted, uint256 totalRawVoted, uint256[] nftsVoted))",
  "function getTotalVotes(uint256 proposalId, address voter, uint8 voteType) view returns (uint256 totalVoted, uint256 totalRawVoted, uint256 votesForNow, bool isVoteFor)",
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
        "Reads `tokenBalance` and `nftBalance` on GovUserKeeper for every VoteType (Personal/Micropool/Delegated/Treasury). One multicall round-trip.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        user: z.string().describe("User wallet address"),
      },
      outputSchema: {
        govPool: z.string(),
        user: z.string(),
        userKeeper: z.string(),
        power: z.record(
          z.object({
            tokenBalance: z.string(),
            tokenOwned: z.string(),
            nftBalance: z.string(),
            nftOwned: z.string(),
          }),
        ),
      },
    },
    async ({ govPool, user }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool: ${govPool}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const provider = rpc.requireProvider();
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
            nftBalance: nBal,
            nftOwned: nOwn,
          };
        }

        const structured = { govPool, user, userKeeper, power };
        const lines = VOTE_TYPE_NAMES.map((name) => {
          const p = power[name]!;
          return `  ${name.padEnd(14)} token=${p.tokenBalance} (owned=${p.tokenOwned})  nft=${p.nftBalance} (owned=${p.nftOwned})`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Voting power for ${user} on ${govPool}\nUserKeeper: ${userKeeper}\n${lines.join("\n")}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `vote_user_power failed: ${err instanceof Error ? err.message : String(err)}`,
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
        "Reads `GovPool.getUserVotes(proposalId, voter, voteType)` and returns the VoteInfoView. Defaults to PersonalVote.",
      inputSchema: {
        govPool: z.string(),
        proposalId: z.union([z.string(), z.number()]),
        voter: z.string(),
        voteType: z
          .enum(["PersonalVote", "MicropoolVote", "DelegatedVote", "TreasuryVote"])
          .default("PersonalVote"),
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
        nftsVoted: z.array(z.string()),
      },
    },
    async ({ govPool, proposalId, voter, voteType = "PersonalVote" }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(voter)) return errorResult(`Invalid voter: ${voter}`);
      try {
        const provider = rpc.requireProvider();
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
          nftsVoted: v.nftsVoted.map((n) => n.toString()),
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Vote by ${voter} on proposal ${id} (${voteType}):\n` +
                `  isVoteFor     : ${v.isVoteFor}\n` +
                `  totalVoted    : ${v.totalVoted}\n` +
                `  tokensVoted   : ${v.tokensVoted}\n` +
                `  totalRawVoted : ${v.totalRawVoted}\n` +
                `  nftsVoted     : [${structured.nftsVoted.join(", ")}]`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `vote_get_votes failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
