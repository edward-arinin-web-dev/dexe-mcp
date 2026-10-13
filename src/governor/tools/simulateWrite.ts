import { z } from "zod";
import { Interface, ZeroAddress, toUtf8String } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  governorContract,
  governorIdSchema,
  governorProvider,
  governorReadError,
  legacyIdHint,
  PID_GOV,
  resolveGovernor,
  rpcNote,
  RpcProvider,
  safeErrorMessage,
  stateName,
  type GovernorConfig,
} from "@dexe-network/dexe-mcp/core";
import { buildExecute, decodeGovernorWrite, type QueueExecuteArgs } from "../encoder.js";

/**
 * `dexe_gov_simulate_proposal`: an `eth_call` dry-run of `Governor.execute()`,
 * i.e. a pre-check of a write. The vote-impact projection is in ./simulate.ts.
 */

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

const uintLikeSchema = z.union([z.string(), z.number()]);

export function registerGovernorSimulateWriteTools(server: McpServer, rpc: RpcProvider): void {
  registerSimulateProposal(server, rpc);
}

function registerSimulateProposal(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_simulate_proposal",
    {
      title: "Dry-run Governor.execute() via eth_call",
      description:
        "Read-only. eth_call dry-run of Governor.execute() (Bravo: proposalId; OZ: targets/values/calldatas + description or hash), returning {success, revertReason, decodedCall, currentState}. Single-block only, not a fork-and-time-warp: a Queued proposal whose timelock ETA has not elapsed reverts with the timelock error.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: z
          .string()
          .optional()
          .describe("Required on Bravo; on OZ optional, used for the state lookup. " + PID_GOV),
        targets: z.array(z.string()).optional().describe("OZ only. Contract address per action."),
        values: z.array(uintLikeSchema).optional().describe("OZ only. Native value per action, RAW base units (wei)."),
        calldatas: z.array(z.string()).optional().describe("OZ only. 0x-hex calldata per action."),
        description: z.string().optional().describe("OZ only. Auto-hashed."),
        descriptionHash: z.string().optional().describe("OZ only. Use when description is unknown."),
        from: z
          .string()
          .optional()
          .describe("Caller for eth_call. Defaults to 0x0 — execute() is anyone-callable on both families."),
        msgValue: uintLikeSchema.optional().describe("Tx value for the eth_call, RAW base units (wei). Defaults to 0."),
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

// Re-export so build.test can verify decode integration in one place.
export { decodeGovernorWrite };
