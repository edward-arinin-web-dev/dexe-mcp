import { z } from "zod";
import { isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import {
  governorContract,
  votesContract,
  readProposal,
  readQuorum,
  readVotingPower,
} from "../adapter.js";
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

const addressArg = (desc: string) =>
  z.string().refine((s) => isAddress(s), { message: "must be a 0x-prefixed 20-byte address" }).describe(desc);

const proposalIdArg = (desc: string) =>
  z
    .string()
    .refine(
      (s) => {
        try {
          BigInt(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be a uint256 (decimal or 0x-hex) string" },
    )
    .describe(desc);

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
        proposalId: proposalIdArg(
          "Proposal id as decimal string (Governor uses uint256, often the bytes32 keccak hash interpreted as uint256).",
        ),
      },
    },
    async ({ governor, proposalId }) => {
      try {
        const cfg = resolveGovernor(governor);
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const c = governorContract(provider, cfg);
        const pid = BigInt(proposalId);
        const readout = await readProposal(c, cfg, pid);
        return ok({
          governor: cfg.id,
          governorAddress: cfg.governorAddress,
          chainId: cfg.chainId,
          governorVersion: cfg.governorVersion,
          proposalId,
          ...readout,
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
        account: addressArg("0x-prefixed account address."),
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
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const c = votesContract(provider, cfg);
        const { power, method } = await readVotingPower(c, cfg, account, blockNumber);
        return ok({
          governor: cfg.id,
          account,
          blockNumber: blockNumber ?? "latest",
          votingToken: cfg.votingToken,
          votingPower: { raw: power.toString(), decimals: cfg.votingToken.decimals },
          method,
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
        "Returns the quorum threshold at a snapshot block. Bravo (UNI/COMP) → fixed quorumVotes(); vanilla OZ → quorum(blockNumber); OP-style governors (quorumSource=votable-supply, whose quorum() is keyed by proposalId) → votableSupply(block) * quorumNumerator/quorumDenominator. When blockNumber is omitted, uses the latest block. The `method` field reports which path was used; `configured` echoes the numerator/denominator for cross-check.",
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
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const c = governorContract(provider, cfg);
        const block = blockNumber ?? (await provider.getBlockNumber());
        const { quorum, method } = await readQuorum(c, cfg, block);
        return ok({
          governor: cfg.id,
          governorVersion: cfg.governorVersion,
          blockNumber: block,
          quorum: quorum.toString(),
          method,
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
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
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
