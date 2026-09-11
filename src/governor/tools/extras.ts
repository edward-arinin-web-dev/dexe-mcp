import { z } from "zod";
import { Interface, isAddress, keccak256, toUtf8Bytes } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import { resolveGovernor, type GovernorConfig } from "../loader.js";
import { governorContract, isBravo, legacyIdHint, stateName } from "../adapter.js";
import { governorProvider, governorReadError, rpcNote } from "../rpc.js";
import { safeErrorMessage } from "../../lib/redact.js";
import {
  buildCancel,
  decodeGovernorWrite,
  GOVERNOR_OZ_WRITE_ABI,
  GOVERNOR_BRAVO_WRITE_ABI,
  type QueueExecuteArgs,
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
  registerBuildCancel(server);
  registerDecodeCalldata(server);
  registerHashDescription(server);
  registerHashProposal(server, rpc);
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

function registerBuildCancel(server: McpServer): void {
  server.registerTool(
    "dexe_gov_build_cancel",
    {
      title: "Encode Governor.cancel calldata",
      description:
        "Builds calldata; does not broadcast. `Governor.cancel`. OZ v4+: pass targets/values/calldatas + description or descriptionHash. Bravo: pass proposalId only.",
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
        const built = buildCancel(cfg, args as QueueExecuteArgs);
        return ok({ governor: cfg.id, governorVersion: cfg.governorVersion, ...built });
      } catch (e) {
        return err(`dexe_gov_build_cancel failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerDecodeCalldata(server: McpServer): void {
  server.registerTool(
    "dexe_gov_decode_calldata",
    {
      title: "Decode any Governor write calldata back to its named args",
      description:
        "Read-only, local. Parses 0x-hex calldata against the configured Governor's write ABI (family-aware) into {method, args} — audit a tx before signing, or round-trip a dexe_gov_build_* payload.",
      inputSchema: {
        governor: governorIdSchema,
        data: z.string().describe("0x-prefixed calldata."),
      },
    },
    async ({ governor, data }) => {
      try {
        const cfg = resolveGovernor(governor);
        const decoded = decodeGovernorWrite(cfg, data);
        // bigints → strings for JSON safety
        const argsOut = decoded.args.map((v) =>
          typeof v === "bigint"
            ? v.toString()
            : Array.isArray(v)
              ? v.map((x: any) => (typeof x === "bigint" ? x.toString() : x))
              : v,
        );
        return ok({
          governor: cfg.id,
          governorVersion: cfg.governorVersion,
          family: isBravo(cfg) ? "bravo" : "oz",
          method: decoded.method,
          args: argsOut,
        });
      } catch (e) {
        return err(`dexe_gov_decode_calldata failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerHashDescription(server: McpServer): void {
  server.registerTool(
    "dexe_gov_hash_description",
    {
      title: "Compute keccak256(toUtf8Bytes(description))",
      description:
        "Read-only, local. keccak256(toUtf8Bytes(description)) — the 32-byte descriptionHash OZ queue/execute/cancel take.",
      inputSchema: {
        description: z.string().describe("The proposal description text to hash."),
      },
    },
    async ({ description }) => {
      try {
        return ok({ description, descriptionHash: keccak256(toUtf8Bytes(description)) });
      } catch (e) {
        return err(`dexe_gov_hash_description failed: ${(e as Error).message}`);
      }
    },
  );
}

function registerHashProposal(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_gov_hash_proposal",
    {
      title: "Call OZ Governor.hashProposal — preview the deterministic proposalId",
      description:
        "Read-only. OZ v4+ only: `Governor.hashProposal` gives the deterministic proposalId for a (targets, values, calldatas, descriptionHash) tuple before submission. Bravo has no hashProposal and is refused with that reason.",
      inputSchema: {
        governor: governorIdSchema,
        targets: z.array(z.string()).describe("Contract address per action."),
        values: z.array(uintLikeSchema).describe("Native value per action, RAW base units (wei)."),
        calldatas: z.array(z.string()).describe("0x-hex calldata per action."),
        description: z.string().optional().describe("The proposal description; hashed for you."),
        descriptionHash: z.string().optional().describe("Use when the description text is unknown."),
      },
    },
    async ({ governor, targets, values, calldatas, description, descriptionHash }) => {
      try {
        const cfg = resolveGovernor(governor);
        if (isBravo(cfg)) {
          return err(
            `dexe_gov_hash_proposal: ${cfg.id} is Bravo (${cfg.governorVersion}); Bravo does not expose hashProposal. Use Bravo's on-chain proposalCount + propose-returned id instead.`,
          );
        }
        const pr = governorProvider(rpc, cfg);
        if ("error" in pr) return err(pr.error);
        const provider = pr.ok;
        const c = governorContract(provider, cfg);
        const dh = descriptionHash
          ?? (description !== undefined ? keccak256(toUtf8Bytes(description)) : undefined);
        if (!dh) throw new Error("either description or descriptionHash is required");
        const vals = values.map((v) => BigInt(v as string));
        const id: bigint = await c.getFunction("hashProposal").staticCall(targets, vals, calldatas, dh);
        return ok({
          governor: cfg.id,
          proposalIdHex: "0x" + id.toString(16),
          proposalIdDecimal: id.toString(),
          descriptionHash: dh,
          ...rpcNote(pr),
        });
      } catch (e) {
        return err(`dexe_gov_hash_proposal failed: ${safeErrorMessage(e)}`);
      }
    },
  );
}
