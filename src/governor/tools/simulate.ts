import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import { resolveGovernor, type GovernorConfig } from "../loader.js";
import {
  governorContract,
  legacyIdHint,
  projectVoteImpact,
  quorumCountingOf,
  readProposal,
  readQuorum,
} from "../adapter.js";
import { governorProvider, governorReadError, rpcNote } from "../rpc.js";
import { safeErrorMessage } from "../../lib/redact.js";

/**
 * `dexe_gov_simulate_vote_impact`: a pure "what if X votes" projection over the
 * live tallies. The `execute()` dry-run that used to share this file is a
 * pre-check of a write, in ./simulateWrite.ts.
 */

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** OZ/Bravo ids are keccak-derived uint256s, not the 1-indexed DeXe counters. */
export const PID_GOV = "Proposal id from hashProposal, decimal or 0x-hex.";

export const governorIdSchema = z
  .string()
  .min(1)
  .describe("Governor id: 'uniswap' | 'compound' | 'optimism', or that DAO's own address. Nothing else resolves.");

export function registerGovernorSimulateTools(server: McpServer, rpc: RpcProvider): void {
  registerSimulateVoteImpact(server, rpc);
}

function registerSimulateVoteImpact(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_simulate_vote_impact",
    {
      title: "Project proposal outcome after a hypothetical vote",
      description:
        "Read-only. Reads the live tallies + quorum and projects the outcome if `weight` of voting power were cast with `support`. Returns currentTallies, projectedTallies, quorumMet, willPass. Quorum counting follows the governor's COUNTING_MODE (`quorum.counting`): Bravo and CompoundGovernor count For only, vanilla OZ counts For+Abstain, Optimism counts all three. `willPass` ignores any per-proposal-type approvalThreshold or voting module — see `caveats` when present.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().describe(PID_GOV),
        support: z.number().int().min(0).max(2).describe("0 = Against, 1 = For, 2 = Abstain."),
        weight: z.string().describe("Hypothetical vote weight, RAW base units (wei), decimal string."),
      },
    },
    async ({ governor, proposalId, support, weight }) => {
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
        const { quorum, method: quorumMethod } = await readQuorum(
          c,
          cfg,
          Number(readout.snapshotBlock),
        );
        const w = BigInt(weight);
        const cur = {
          against: BigInt(readout.votes.against),
          for: BigInt(readout.votes.for),
          abstain: BigInt(readout.votes.abstain),
        };
        const counting = quorumCountingOf(cfg);
        const { projected: proj, quorumMet, willPass } = projectVoteImpact(
          counting,
          cur,
          support,
          w,
          quorum,
        );

        // `willPass` models quorum + (for > against) only. Governors that layer
        // a per-proposal-type approvalThreshold or a voting module on top of
        // that are not modelled, and the boolean would otherwise read as
        // authoritative. Advisory text, never a refusal.
        const caveats: string[] = [];
        if (cfg.quorumSource === "votable-supply") {
          caveats.push(
            "willPass models only quorum + (for > against). This governor applies a per-proposal-type " +
              "approvalThreshold (Optimism: 5100 bps Default, 7600 bps Supermajority) and may route the " +
              "proposal through a voting module (Optimistic type: quorum 0, module-defined passage), " +
              "neither of which is modelled here. The quorum value is the " +
              "votableSupply(snapshot) * numerator/denominator approximation, not the governor's own " +
              "quorum(proposalId). Cross-check on Tally/Agora before acting.",
          );
        }

        return ok({
          governor: cfg.id,
          governorVersion: cfg.governorVersion,
          proposalId,
          currentState: readout.state,
          quorum: { required: quorum.toString(), method: quorumMethod, counting },
          currentTallies: {
            against: cur.against.toString(),
            for: cur.for.toString(),
            abstain: cur.abstain.toString(),
          },
          hypothetical: { support, weight },
          projectedTallies: {
            against: proj.against.toString(),
            for: proj.for.toString(),
            abstain: proj.abstain.toString(),
          },
          projection: { quorumMet, willPass },
          ...(caveats.length > 0 ? { caveats } : {}),
          ...rpcNote(pr),
        });
      } catch (e) {
        const detail = cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e);
        const hint = cfg ? legacyIdHint(cfg, proposalId) : "";
        return err(`dexe_gov_simulate_vote_impact failed: ${detail}${hint}`);
      }
    },
  );
}
