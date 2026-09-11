import { z } from "zod";
import { Interface, ZeroAddress, toUtf8String } from "ethers";
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
  stateName,
} from "../adapter.js";
import { governorProvider, governorReadError, rpcNote } from "../rpc.js";
import { buildExecute, decodeGovernorWrite, type QueueExecuteArgs } from "../encoder.js";
import { safeErrorMessage } from "../../lib/redact.js";

const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function decodeRevert(data: string | undefined): string | null {
  if (!data || data === "0x") return null;
  if (data.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      const iface = new Interface(["function Error(string)"]);
      const [reason] = iface.decodeFunctionData("Error", data) as unknown as [string];
      return reason;
    } catch {
      try {
        return toUtf8String("0x" + data.slice(10 + 64 + 64));
      } catch {
        return data;
      }
    }
  }
  if (data.startsWith(PANIC_SELECTOR)) {
    try {
      const code = BigInt("0x" + data.slice(10));
      const known: Record<string, string> = {
        "1": "assert(false)",
        "17": "arithmetic overflow/underflow",
        "18": "division or modulo by zero",
        "33": "invalid enum conversion",
        "34": "invalid storage byte array access",
        "49": "pop() on empty array",
        "50": "array index out of bounds",
        "65": "out-of-memory allocation",
        "81": "call to uninitialized internal function",
      };
      const hint = known[code.toString()];
      return `Panic(0x${code.toString(16)})${hint ? ` — ${hint}` : ""}`;
    } catch {
      return `Panic(${data.slice(10)})`;
    }
  }
  return data;
}

const governorIdSchema = z
  .string()
  .min(1)
  .describe("Governor id (e.g. 'uniswap', 'compound', 'optimism') or 0x-prefixed governor contract address.");

const uintLikeSchema = z.union([z.string(), z.number()]);

export function registerGovernorSimulateTools(server: McpServer, rpc: RpcProvider): void {
  registerSimulateProposal(server, rpc);
  registerSimulateVoteImpact(server, rpc);
}

function registerSimulateProposal(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_simulate_proposal",
    {
      title: "Dry-run Governor.execute() via eth_call",
      description:
        "Encodes Governor.execute() for the given proposal (Bravo: proposalId; OZ: targets/values/calldatas + description or hash) and performs eth_call against the configured RPC. Returns {success, revertReason, decodedCall, currentState}. Note: this is a single-block dry-run, NOT a full fork-and-time-warp; proposals still in Queued state with unmet timelock ETA will return a revert with the timelock error. For full execution sim, run against a forked node with time advanced past the ETA.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string().optional().describe("Required on Bravo. For OZ, optional — provided for state lookup."),
        targets: z.array(z.string()).optional().describe("OZ only."),
        values: z.array(uintLikeSchema).optional().describe("OZ only."),
        calldatas: z.array(z.string()).optional().describe("OZ only."),
        description: z.string().optional().describe("OZ only. Auto-hashed."),
        descriptionHash: z.string().optional().describe("OZ only. Use when description is unknown."),
        from: z
          .string()
          .optional()
          .describe("Caller for eth_call. Defaults to 0x0 — execute() is anyone-callable on both families."),
        msgValue: uintLikeSchema.optional(),
      },
    },
    async (args) => {
      let cfg: GovernorConfig | undefined;
      let usedFallback = false;
      try {
        cfg = resolveGovernor(args.governor);
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        usedFallback = pr.fallback;
        const note = rpcNote(pr);
        const provider = pr.ok;
        const queueExec: QueueExecuteArgs = {
          proposalId: args.proposalId,
          targets: args.targets,
          values: args.values,
          calldatas: args.calldatas,
          description: args.description,
          descriptionHash: args.descriptionHash,
        };
        const built = buildExecute(cfg, queueExec, args.msgValue as string | undefined);
        const txReq = {
          to: built.to,
          from: args.from ?? ZeroAddress,
          value: "0x" + BigInt(built.value).toString(16),
          data: built.data,
        };

        let currentState: { index: number; name: string } | null = null;
        if (args.proposalId) {
          try {
            const c = governorContract(provider, cfg);
            const idx = Number(await c.getFunction("state").staticCall(BigInt(args.proposalId)));
            currentState = { index: idx, name: stateName(idx) };
          } catch {
            currentState = null;
          }
        }

        try {
          await provider.call(txReq);
          return ok({
            governor: cfg.id,
            governorVersion: cfg.governorVersion,
            success: true,
            currentState,
            executeCalldata: built,
            ...note,
          });
        } catch (e: any) {
          const reason = decodeRevert(e?.data ?? e?.info?.error?.data ?? e?.error?.data);
          return ok({
            governor: cfg.id,
            governorVersion: cfg.governorVersion,
            success: false,
            revertReason: reason ?? (safeErrorMessage(e)),
            currentState,
            executeCalldata: built,
            ...note,
          });
        }
      } catch (e) {
        const detail = cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e);
        const hint = cfg && args.proposalId ? legacyIdHint(cfg, args.proposalId) : "";
        return err(`dexe_gov_simulate_proposal failed: ${detail}${hint}`);
      }
    },
  );
}

function registerSimulateVoteImpact(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_simulate_vote_impact",
    {
      title: "Project proposal outcome after a hypothetical vote",
      description:
        "Reads current vote tallies + quorum, then projects what the outcome would be if `weight` units of voting power were cast with `support` (0=Against, 1=For, 2=Abstain). Pure projection — no on-chain side effects. Returns currentTallies, projectedTallies, quorumMet, willPass. Quorum counting follows the governor's COUNTING_MODE (`quorum.counting`): Bravo and CompoundGovernor count For only, vanilla OZ counts For+Abstain, Optimism counts For+Against+Abstain. `willPass` ignores any per-proposal-type approvalThreshold or voting module — see `caveats` when present.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z.string(),
        support: z.number().int().min(0).max(2),
        weight: z.string().describe("Hypothetical vote weight in wei (decimal string)."),
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

// Re-export so build.test can verify decode integration in one place.
export { decodeGovernorWrite };
