import { z } from "zod";
import { Interface, isAddress, keccak256, toUtf8Bytes } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "../../rpc.js";
import { resolveGovernor } from "../loader.js";
import { governorContract, isBravo, stateName } from "../adapter.js";
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

const governorIdSchema = z
  .string()
  .min(1)
  .describe("Governor id (e.g. 'uniswap') or 0x-prefixed governor contract address.");

const uintLikeSchema = z.union([z.string(), z.number()]);

const addressArg = (desc: string) =>
  z.string().refine((s) => isAddress(s), { message: "must be a 0x-prefixed 20-byte address" }).describe(desc);

const proposalIdArg = z.string().refine(
  (s) => {
    try {
      BigInt(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a uint256 (decimal or 0x-hex) string" },
);

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
        "Returns {index, name} for the proposal's current state. Shorthand for the state field of dexe_gov_get_proposal — useful when you only need the state and want a single eth_call.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: proposalIdArg,
      },
    },
    async ({ governor, proposalId }) => {
      try {
        const cfg = resolveGovernor(governor);
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const c = governorContract(provider, cfg);
        const idx = Number(await c.getFunction("state").staticCall(BigInt(proposalId)));
        return ok({
          governor: cfg.id,
          governorVersion: cfg.governorVersion,
          proposalId,
          state: { index: idx, name: stateName(idx) },
        });
      } catch (e) {
        return err(`dexe_gov_get_state failed: ${(e as Error).message}`);
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
        "Returns true when the account has already cast a vote on this proposal. OZ reads hasVoted(proposalId, account); Bravo (Uniswap/Compound) has no hasVoted — read via getReceipt(proposalId, voter).hasVoted.",
      inputSchema: {
        governor: governorIdSchema,
        proposalId: proposalIdArg,
        account: addressArg("0x-prefixed account address."),
      },
    },
    async ({ governor, proposalId, account }) => {
      try {
        const cfg = resolveGovernor(governor);
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
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
        });
      } catch (e) {
        return err(`dexe_gov_has_voted failed: ${(e as Error).message}`);
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
        "OZ v4+: pass targets/values/calldatas + description or descriptionHash. Bravo: pass proposalId only. Returns {to, value, data, selector}.",
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
        "Parses raw 0x-prefixed calldata against the configured Governor's write ABI (family-aware). Returns {method, args}. Useful for auditing a transaction in a wallet before signing, or round-tripping output of dexe_gov_build_* tools.",
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
        "Returns the 32-byte descriptionHash that OZ Governor queue/execute/cancel use. Lets clients pre-compute the hash, store it, and skip rehashing on every call.",
      inputSchema: {
        description: z.string(),
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
        "OZ v4+ only. Computes the on-chain proposalId for a (targets, values, calldatas, descriptionHash) tuple before submission. Lets clients verify the propose calldata matches an expected id. Errors clearly on Bravo (hashProposal is not part of Bravo's ABI).",
      inputSchema: {
        governor: governorIdSchema,
        targets: z.array(z.string()),
        values: z.array(uintLikeSchema),
        calldatas: z.array(z.string()),
        description: z.string().optional(),
        descriptionHash: z.string().optional(),
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
        const pr = rpc.tryProvider(cfg.chainId);
        if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
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
        });
      } catch (e) {
        return err(`dexe_gov_hash_proposal failed: ${(e as Error).message}`);
      }
    },
  );
}
