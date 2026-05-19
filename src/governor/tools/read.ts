import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import { governorContract, votesContract, stateName } from "../adapter.js";
import { loadGovernorConfigs, resolveGovernor } from "../loader.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const governorIdSchema = z
  .string()
  .min(1)
  .describe("Governor id (e.g. 'uniswap') or 0x-prefixed governor contract address.");

export function registerGovernorReadTools(server: McpServer, rpc: RpcProvider): void {
  registerListGovernors(server);
  registerGetProposal(server, rpc);
  registerGetVotingPower(server, rpc);
  registerGetQuorum(server, rpc);
  registerGetProposalThreshold(server, rpc);
}

function registerListGovernors(server: McpServer): void {
  server.registerTool(
    "dexe_gov_list_governors",
    {
      title: "List configured external Governor DAOs",
      description:
        "Returns all DAOs registered under src/governor/configs/. Each entry is the static config (chainId, governor address, voting token, voting params, timelock). Read-only, no RPC.",
      inputSchema: {},
    },
    async () => {
      try {
        const all = [...loadGovernorConfigs().values()];
        return ok(all);
      } catch (e) {
        return err(`failed to load governor configs: ${(e as Error).message}`);
      }
    },
  );
}

function registerGetProposal(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_get_proposal",
    {
      title: "Read OpenZeppelin Governor proposal state + tallies",
      description:
        "Returns ProposalState (string + numeric enum), proposalSnapshot block, proposalDeadline block, and proposalVotes (for/against/abstain) for the given proposalId on a configured Governor.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z
          .string()
          .describe("Proposal id as decimal string (Governor uses uint256, often the bytes32 keccak hash interpreted as uint256)."),
      },
    },
    async ({ governor, proposalId }) => {
      try {
        const cfg = resolveGovernor(governor);
        const provider = rpc.requireProvider(cfg.chainId);
        const c = governorContract(provider, cfg);
        const pid = BigInt(proposalId);
        const [stateIdx, snapshot, deadline, votes] = await Promise.all([
          c.getFunction("state").staticCall(pid),
          c.getFunction("proposalSnapshot").staticCall(pid),
          c.getFunction("proposalDeadline").staticCall(pid),
          c.getFunction("proposalVotes").staticCall(pid),
        ]);
        const s = Number(stateIdx);
        return ok({
          governor: cfg.id,
          governorAddress: cfg.governorAddress,
          chainId: cfg.chainId,
          proposalId,
          state: { index: s, name: stateName(s) },
          snapshotBlock: snapshot.toString(),
          deadlineBlock: deadline.toString(),
          votes: {
            against: votes[0].toString(),
            for: votes[1].toString(),
            abstain: votes[2].toString(),
          },
        });
      } catch (e) {
        return err(`dexe_gov_get_proposal failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerGetVotingPower(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_get_voting_power",
    {
      title: "Read IVotes voting power for an account",
      description:
        "Calls IVotes.getPastVotes(account, blockNumber) on the configured Governor's voting token. Falls back to IVotes.getVotes(account) when blockNumber is omitted. Decimals reported alongside raw wei value.",
      inputSchema: {
        governor: governorIdSchema,
        account: z.string().describe("0x-prefixed account address."),
        blockNumber: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Snapshot block. When omitted, current voting power via getVotes(account) is returned."),
      },
    },
    async ({ governor, account, blockNumber }) => {
      try {
        const cfg = resolveGovernor(governor);
        const provider = rpc.requireProvider(cfg.chainId);
        const c = votesContract(provider, cfg);
        const raw: bigint = blockNumber === undefined
          ? await c.getFunction("getVotes").staticCall(account)
          : await c.getFunction("getPastVotes").staticCall(account, blockNumber);
        return ok({
          governor: cfg.id,
          account,
          blockNumber: blockNumber ?? "latest",
          votingToken: cfg.votingToken,
          votingPower: { raw: raw.toString(), decimals: cfg.votingToken.decimals },
          method: blockNumber === undefined ? "getVotes" : "getPastVotes",
        });
      } catch (e) {
        return err(`dexe_gov_get_voting_power failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerGetQuorum(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_get_quorum",
    {
      title: "Read Governor quorum threshold at a snapshot block",
      description:
        "Calls Governor.quorum(blockNumber). When blockNumber is omitted, uses the latest block. Also returns the config-derived quorumNumerator/quorumDenominator for cross-check.",
      inputSchema: {
        governor: governorIdSchema,
        blockNumber: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Snapshot block; latest when omitted."),
      },
    },
    async ({ governor, blockNumber }) => {
      try {
        const cfg = resolveGovernor(governor);
        const provider = rpc.requireProvider(cfg.chainId);
        const c = governorContract(provider, cfg);
        const block = blockNumber ?? (await provider.getBlockNumber());
        const quorum: bigint = await c.getFunction("quorum").staticCall(block);
        return ok({
          governor: cfg.id,
          blockNumber: block,
          quorum: quorum.toString(),
          configured: {
            numerator: cfg.votingParams.quorumNumerator,
            denominator: cfg.votingParams.quorumDenominator,
          },
        });
      } catch (e) {
        return err(`dexe_gov_get_quorum failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerGetProposalThreshold(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_get_proposal_threshold",
    {
      title: "Read Governor proposalThreshold()",
      description:
        "Calls Governor.proposalThreshold() — minimum voting power required to submit a proposal. Returns raw uint256 and config-derived value (when present) for cross-check.",
      inputSchema: {
        governor: governorIdSchema,
      },
    },
    async ({ governor }) => {
      try {
        const cfg = resolveGovernor(governor);
        const provider = rpc.requireProvider(cfg.chainId);
        const c = governorContract(provider, cfg);
        const threshold: bigint = await c.getFunction("proposalThreshold").staticCall();
        return ok({
          governor: cfg.id,
          proposalThreshold: { raw: threshold.toString(), decimals: cfg.votingToken.decimals },
          configured: cfg.votingParams.proposalThreshold ?? null,
        });
      } catch (e) {
        return err(`dexe_gov_get_proposal_threshold failed: ${(e as Error).message}`);
      }
    },
  );
}
