import { z } from "zod";
import { isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import { resolveGovernor, type GovernorConfig } from "../loader.js";
import { governorContract, isBravo, legacyIdHint, stateName } from "../adapter.js";
import { governorProvider, governorReadError, rpcNote } from "../rpc.js";
import { safeErrorMessage } from "../../lib/redact.js";

/**
 * Governor lookups beyond tools/read.ts: `dexe_gov_get_state` and
 * `dexe_gov_has_voted`. The calldata / hash helpers that used to share this
 * file are write tools, in ./extrasWrite.ts.
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

const addressArg = (desc: string) =>
  z.string().refine((s) => isAddress(s), { message: "must be a 0x-prefixed 20-byte address" }).describe(desc);

const proposalIdArg = z
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
  .describe(PID_GOV);

export function registerGovernorExtraTools(server: McpServer, rpc: RpcProvider): void {
  registerGetState(server, rpc);
  registerHasVoted(server, rpc);
}

function registerGetState(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_get_state",
    {
      title: "Read Governor.state() — minimal proposal-state lookup",
      description:
        "Read-only. `Governor.state(proposalId)` as {index, name} — one eth_call when the state is all you need.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: proposalIdArg,
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
        const idx = Number(await c.getFunction("state").staticCall(BigInt(proposalId)));
        return ok({
          governor: cfg.id,
          governorVersion: cfg.governorVersion,
          proposalId,
          state: { index: idx, name: stateName(idx) },
          ...rpcNote(pr),
        });
      } catch (e) {
        const detail = cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e);
        const hint = cfg ? legacyIdHint(cfg, proposalId) : "";
        return err(`dexe_gov_get_state failed: ${detail}${hint}`);
      }
    },
  );
}

function registerHasVoted(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_has_voted",
    {
      title: "Read whether an account has voted on a proposal",
      description:
        "Read-only. Whether the account already voted. OZ reads hasVoted(proposalId, account); Bravo has no hasVoted, so it reads getReceipt(proposalId, voter).hasVoted.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: proposalIdArg,
        account: addressArg("0x-prefixed account address."),
      },
    },
    async ({ governor, proposalId, account }) => {
      let cfg: GovernorConfig | undefined;
      let usedFallback = false;
      try {
        cfg = resolveGovernor(governor);
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        usedFallback = pr.fallback;
        const provider = pr.ok;
        const c = governorContract(provider, cfg);
        let voted: boolean;
        let method: string;
        if (isBravo(cfg)) {
          const receipt = await c.getFunction("getReceipt").staticCall(BigInt(proposalId), account);
          voted = Boolean(receipt.hasVoted);
          method = "getReceipt";
        } else {
          voted = await c.getFunction("hasVoted").staticCall(BigInt(proposalId), account);
          method = "hasVoted";
        }
        return ok({
          governor: cfg.id,
          proposalId,
          account,
          hasVoted: voted,
          method,
          ...rpcNote(pr),
        });
      } catch (e) {
        const detail = cfg ? governorReadError(e, cfg, usedFallback) : safeErrorMessage(e);
        const hint = cfg ? legacyIdHint(cfg, proposalId) : "";
        return err(`dexe_gov_has_voted failed: ${detail}${hint}`);
      }
    },
  );
}
