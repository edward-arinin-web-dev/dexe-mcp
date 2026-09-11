import { z } from "zod";
import { isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import {
  governorContract,
  legacyIdHint,
  quorumCountingOf,
  votesContract,
  readProposal,
  readQuorum,
  readVotingPower,
} from "../adapter.js";
import { loadGovernorConfigs, resolveGovernor, type GovernorConfig } from "../loader.js";
import { governorProvider, governorReadError, rpcNote } from "../rpc.js";
import { safeErrorMessage } from "../../lib/redact.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** OZ/Bravo ids are keccak-derived uint256s, not the 1-indexed DeXe counters. */
const PID_GOV = "Proposal id from hashProposal, decimal or 0x-hex.";

const governorIdSchema = z
  .string()
  .min(1)
  .describe("Governor id: 'uniswap' | 'compound' | 'optimism', or that DAO's own address. Nothing else resolves.");

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
        "Read-only, local. Every bundled external-Governor config: its chain, governor address, voting token, voting params and timelock. A static snapshot — a DAO can change its params by proposal.",
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
        "Read-only. ProposalState (name + enum index), snapshot block, deadline block and proposalVotes (for/against/abstain) for one proposal on a configured Governor.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: proposalIdArg(PID_GOV),
      },
    },
    async ({ governor, proposalId }) => {
      let cfg: GovernorConfig | undefined;
      let usedFallback = false;
      try {
        cfg = resolveGovernor(governor);
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        usedFallback = pr.fallback;
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
          ...rpcNote(pr),
        });
      } catch (e) {
        const detail = cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e);
        const hint = cfg ? legacyIdHint(cfg, proposalId) : "";
        return err(`dexe_gov_get_proposal failed: ${detail}${hint}`);
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
        "Read-only. `IVotes.getPastVotes(account, blockNumber)` on the Governor's voting token, or `getVotes(account)` when blockNumber is omitted. Raw wei plus the token's decimals.",
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
      let cfg: GovernorConfig | undefined;
      let usedFallback = false;
      try {
        cfg = resolveGovernor(governor);
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        usedFallback = pr.fallback;
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
          ...rpcNote(pr),
        });
      } catch (e) {
        return err(
          `dexe_gov_get_voting_power failed: ${cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e)}`,
        );
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
        "Read-only. Quorum threshold at a snapshot block (latest when omitted). Bravo (UNI/COMP) reads fixed quorumVotes(); vanilla OZ reads quorum(blockNumber); OP-style governors, whose quorum() is keyed by proposalId, use votableSupply(block) * quorumNumerator/quorumDenominator. `method` reports the path taken, `configured` echoes the numerator/denominator to cross-check.",
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
      let cfg: GovernorConfig | undefined;
      let usedFallback = false;
      try {
        cfg = resolveGovernor(governor);
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        usedFallback = pr.fallback;
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
          counting: quorumCountingOf(cfg),
          configured: {
            numerator: cfg.votingParams.quorumNumerator,
            denominator: cfg.votingParams.quorumDenominator,
          },
          ...rpcNote(pr),
        });
      } catch (e) {
        return err(
          `dexe_gov_get_quorum failed: ${cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e)}`,
        );
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
        "Read-only. `Governor.proposalThreshold()` — the voting power needed to submit a proposal. Returns the live uint256 plus the bundled config value, and whether they still agree.",
      inputSchema: {
        governor: governorIdSchema,
      },
    },
    async ({ governor }) => {
      let cfg: GovernorConfig | undefined;
      let usedFallback = false;
      try {
        cfg = resolveGovernor(governor);
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        usedFallback = pr.fallback;
        const provider = pr.ok;
        const c = governorContract(provider, cfg);
        const threshold: bigint = await c.getFunction("proposalThreshold").staticCall();
        const configured = cfg.votingParams.proposalThreshold ?? null;
        return ok({
          governor: cfg.id,
          proposalThreshold: { raw: threshold.toString(), decimals: cfg.votingToken.decimals },
          configured,
          // The fixture is a static snapshot; a DAO can change its threshold by
          // proposal. Say so explicitly instead of printing two numbers that
          // silently disagree (the Uniswap fixture was 2.5x off for months).
          configuredMatchesChain: configured === null ? null : configured === threshold.toString(),
          ...rpcNote(pr),
        });
      } catch (e) {
        return err(
          `dexe_gov_get_proposal_threshold failed: ${cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e)}`,
        );
      }
    },
  );
}
