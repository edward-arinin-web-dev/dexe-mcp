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

const governorIdSchema = z
  .string()
  .min(1)
  .describe("Governor id (e.g. 'uniswap') or 0x-prefixed governor contract address.");

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
        "Returns {to, value, data, selector} for the configured Governor's propose method. OZ v4+ uses (targets, values, calldatas, description); Bravo uses (targets, values, signatures, calldatas, description). On Bravo, signatures defaults to [''...] when omitted.",
      inputSchema: {
        governor: governorIdSchema,
        targets: z.array(z.string()).min(1),
        values: z.array(uintLikeSchema).min(1).describe("ETH value per target as decimal string or number."),
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
        "Returns {to, value, data, selector}. support: 0=Against, 1=For, 2=Abstain. When reason is provided, uses castVoteWithReason; otherwise castVote. Identical signature on OZ and Bravo.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().describe("Proposal id as decimal string (uint256)."),
        support: z.number().int().min(0).max(2),
        reason: z.string().optional(),
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
        "OZ v4+: pass targets/values/calldatas plus either description (we hash it) or descriptionHash. Bravo: pass proposalId only.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().optional(),
        targets: z.array(z.string()).optional(),
        values: z.array(uintLikeSchema).optional(),
        calldatas: z.array(z.string()).optional(),
        description: z.string().optional(),
        descriptionHash: z.string().optional(),
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
        "OZ v4+: pass targets/values/calldatas plus description or descriptionHash. Bravo: pass proposalId only. Optional msgValue passes through as the tx value (sum of proposal target values when calling OZ execute).",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().optional(),
        targets: z.array(z.string()).optional(),
        values: z.array(uintLikeSchema).optional(),
        calldatas: z.array(z.string()).optional(),
        description: z.string().optional(),
        descriptionHash: z.string().optional(),
        msgValue: uintLikeSchema.optional().describe("Tx value in wei. Defaults to 0."),
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
        "Returns {to, value, data, selector}. `to` is the voting token (NOT the Governor). delegatee=zero address self-revokes delegation.",
      inputSchema: {
        governor: governorIdSchema,
        delegatee: z.string(),
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
