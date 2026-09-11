import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveGovernor } from "../loader.js";
import {
  buildDelegate,
  buildExecute,
  buildPropose,
  buildQueue,
  buildVoteCast,
} from "../encoder.js";

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

const uintLikeSchema = z.union([z.string(), z.number()]);

export function registerGovernorBuildTools(server: McpServer): void {
  registerPropose(server);
  registerVoteCast(server);
  registerQueue(server);
  registerExecute(server);
  registerDelegate(server);
}

function registerPropose(server: McpServer): void {
  server.registerTool(
    "dexe_gov_build_propose",
    {
      title: "Encode Governor.propose calldata",
      description:
        "Builds calldata; does not broadcast. `Governor.propose`: OZ v4+ takes (targets, values, calldatas, description), Bravo takes (targets, values, signatures, calldatas, description) and defaults signatures to empty strings.",
      inputSchema: {
        governor: governorIdSchema,
        targets: z.array(z.string()).min(1).describe("Contract address called by each action."),
        values: z.array(uintLikeSchema).min(1).describe("Native value per target, RAW base units (wei), decimal string or number."),
        calldatas: z.array(z.string()).min(1).describe("0x-prefixed bytes per target."),
        description: z.string().describe("Human-readable proposal description; hashed for queue/execute on OZ."),
        signatures: z
          .array(z.string())
          .optional()
          .describe("Bravo only. Per-target function signature strings. Defaults to empty strings when omitted."),
      },
    },
    async ({ governor, targets, values, calldatas, description, signatures }) => {
      try {
        const cfg = resolveGovernor(governor);
        const built = buildPropose(cfg, { targets, values, calldatas, description, signatures });
        return ok({ governor: cfg.id, governorVersion: cfg.governorVersion, ...built });
      } catch (e) {
        return err(`dexe_gov_build_propose failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerVoteCast(server: McpServer): void {
  server.registerTool(
    "dexe_gov_build_vote_cast",
    {
      title: "Encode Governor.castVote / castVoteWithReason calldata",
      description:
        "Builds calldata; does not broadcast. `Governor.castVote`, or `castVoteWithReason` when `reason` is set. Identical signature on OZ and Bravo.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().describe(PID_GOV),
        support: z.number().int().min(0).max(2).describe("0 = Against, 1 = For, 2 = Abstain."),
        reason: z.string().optional().describe("Optional public reason string stored with the vote."),
      },
    },
    async ({ governor, proposalId, support, reason }) => {
      try {
        const cfg = resolveGovernor(governor);
        const built = buildVoteCast(cfg, proposalId, support as 0 | 1 | 2, reason);
        return ok({ governor: cfg.id, governorVersion: cfg.governorVersion, ...built });
      } catch (e) {
        return err(`dexe_gov_build_vote_cast failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerQueue(server: McpServer): void {
  server.registerTool(
    "dexe_gov_build_queue",
    {
      title: "Encode Governor.queue calldata",
      description:
        "Builds calldata; does not broadcast. `Governor.queue`. OZ v4+: pass targets/values/calldatas plus description (hashed for you) or descriptionHash. Bravo: pass proposalId only.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().optional().describe("Bravo only. " + PID_GOV),
        targets: z.array(z.string()).optional().describe("OZ only. Contract address per action."),
        values: z.array(uintLikeSchema).optional().describe("OZ only. Native value per action, RAW base units (wei)."),
        calldatas: z.array(z.string()).optional().describe("OZ only. 0x-hex calldata per action."),
        description: z.string().optional().describe("OZ only. The proposal description; hashed for you."),
        descriptionHash: z.string().optional().describe("OZ only. Use when the description text is unknown."),
      },
    },
    async (args) => {
      try {
        const cfg = resolveGovernor(args.governor);
        const built = buildQueue(cfg, args);
        return ok({ governor: cfg.id, governorVersion: cfg.governorVersion, ...built });
      } catch (e) {
        return err(`dexe_gov_build_queue failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerExecute(server: McpServer): void {
  server.registerTool(
    "dexe_gov_build_execute",
    {
      title: "Encode Governor.execute calldata",
      description:
        "Builds calldata; does not broadcast. `Governor.execute`. OZ v4+: pass targets/values/calldatas plus description or descriptionHash. Bravo: pass proposalId only.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().optional().describe("Bravo only. " + PID_GOV),
        targets: z.array(z.string()).optional().describe("OZ only. Contract address per action."),
        values: z.array(uintLikeSchema).optional().describe("OZ only. Native value per action, RAW base units (wei)."),
        calldatas: z.array(z.string()).optional().describe("OZ only. 0x-hex calldata per action."),
        description: z.string().optional().describe("OZ only. The proposal description; hashed for you."),
        descriptionHash: z.string().optional().describe("OZ only. Use when the description text is unknown."),
        msgValue: uintLikeSchema
          .optional()
          .describe("Tx value, RAW base units (wei) — the sum of the OZ target values. Defaults to 0."),
      },
    },
    async (args) => {
      try {
        const cfg = resolveGovernor(args.governor);
        const built = buildExecute(cfg, args, args.msgValue as string | undefined);
        return ok({ governor: cfg.id, governorVersion: cfg.governorVersion, ...built });
      } catch (e) {
        return err(`dexe_gov_build_execute failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerDelegate(server: McpServer): void {
  server.registerTool(
    "dexe_gov_build_delegate",
    {
      title: "Encode IVotes.delegate calldata on the configured voting token",
      description:
        "Builds calldata; does not broadcast. `IVotes.delegate` — `to` is the voting token, NOT the Governor. The zero address revokes the delegation.",
      inputSchema: {
        governor: governorIdSchema,
        delegatee: z.string().describe("Address receiving the delegated voting power; zero revokes."),
      },
    },
    async ({ governor, delegatee }) => {
      try {
        const cfg = resolveGovernor(governor);
        const built = buildDelegate(cfg, delegatee);
        return ok({ governor: cfg.id, votingToken: cfg.votingToken, ...built });
      } catch (e) {
        return err(`dexe_gov_build_delegate failed: ${(e as Error).message}`);
      }
    },
  );
}
