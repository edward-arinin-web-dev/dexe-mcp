import { z } from "zod";
import { Contract, Interface, isAddress, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";

const GOV_POOL_ABI = [
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getExpertStatus(address user) view returns (bool)",
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
] as const;

const GOV_VALIDATORS_ABI = [
  "function validatorsCount() view returns (uint256)",
  "function isValidator(address user) view returns (bool)",
] as const;

const GOV_SETTINGS_ABI = [
  "function getDefaultSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
  "function getInternalSettings() view returns (tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription))",
] as const;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
] as const;

const ERC721_HOLDER_ABI = [
  "function balanceOf(address) view returns (uint256)",
] as const;

const BABT_ABI = [
  "function balanceOf(address) view returns (uint256)",
] as const;

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  registerMulticall(server, rpc);
  registerTreasury(server, rpc);
  registerValidators(server, rpc);
  registerSettings(server, rpc);
  registerExpertStatus(server, rpc);
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function registerMulticall(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_multicall",
    {
      title: "Arbitrary batched eth_call via Multicall3",
      description:
        "Execute N independent view calls in a single RPC round-trip. Each call supplies its own ABI signature fragment, target, method, and args. Results are decoded per-call.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              target: z.string(),
              signature: z
                .string()
                .describe("Full function signature, e.g. 'function balanceOf(address) view returns (uint256)'"),
              method: z.string().describe("Method name matching the signature"),
              args: z.array(z.unknown()).default([]),
              allowFailure: z.boolean().default(true),
            }),
          )
          .min(1),
      },
      outputSchema: {
        results: z.array(
          z.object({
            success: z.boolean(),
            value: z.unknown().nullable(),
            raw: z.string(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ calls }) => {
      try {
        const provider = rpc.requireProvider();
        const batch: Call[] = calls.map((c) => {
          if (!isAddress(c.target)) throw new Error(`Invalid target: ${c.target}`);
          return {
            target: c.target,
            iface: new Interface([c.signature]),
            method: c.method,
            args: c.args.map(coerceArg),
            allowFailure: c.allowFailure,
          };
        });
        const results = await multicall(provider, batch);
        const structured = {
          results: results.map((r) => ({
            success: r.success,
            value: jsonSafe(r.value),
            raw: r.raw,
            error: r.error,
          })),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `${results.length} calls: ${results.filter((r) => r.success).length} ok, ${results.filter((r) => !r.success).length} failed`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `read_multicall failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

function registerTreasury(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_treasury",
    {
      title: "Native + ERC20 balances for a DAO or arbitrary address",
      description:
        "Reads native coin balance + one-or-more ERC20 balances (symbol, decimals, balance) in a single multicall. Pass the GovPool address to query DAO treasury.",
      inputSchema: {
        holder: z.string().describe("Address whose balances we read"),
        tokens: z.array(z.string()).default([]).describe("ERC20 contract addresses"),
      },
      outputSchema: {
        holder: z.string(),
        native: z.string(),
        tokens: z.array(
          z.object({
            token: z.string(),
            symbol: z.string().nullable(),
            decimals: z.number().nullable(),
            balance: z.string().nullable(),
          }),
        ),
      },
    },
    async ({ holder, tokens = [] }) => {
      if (!isAddress(holder)) return errorResult(`Invalid holder: ${holder}`);
      try {
        const provider = rpc.requireProvider();
        const native = (await provider.getBalance(holder)).toString();
        const iface = new Interface(ERC20_ABI as unknown as string[]);
        const calls: Call[] = [];
        for (const t of tokens) {
          if (!isAddress(t)) throw new Error(`Invalid token: ${t}`);
          calls.push({ target: t, iface, method: "balanceOf", args: [holder], allowFailure: true });
          calls.push({ target: t, iface, method: "symbol", args: [], allowFailure: true });
          calls.push({ target: t, iface, method: "decimals", args: [], allowFailure: true });
        }
        const res = await multicall(provider, calls);
        const tokensOut = tokens.map((t, i) => ({
          token: t,
          balance: res[i * 3]?.success ? (res[i * 3]!.value as bigint).toString() : null,
          symbol: res[i * 3 + 1]?.success ? (res[i * 3 + 1]!.value as string) : null,
          decimals: res[i * 3 + 2]?.success ? Number(res[i * 3 + 2]!.value as bigint) : null,
        }));
        const structured = { holder, native, tokens: tokensOut };
        const text =
          `Treasury for ${holder}\n  native: ${native}\n` +
          tokensOut
            .map(
              (t) =>
                `  ${t.symbol ?? "?"} (${t.token}): ${t.balance ?? "?"}${t.decimals != null ? ` (decimals=${t.decimals})` : ""}`,
            )
            .join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(
          `read_treasury failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

function registerValidators(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_validators",
    {
      title: "Validator count + isValidator lookup",
      description:
        "Reads `validatorsCount()` and optionally checks `isValidator(candidate)` on the DAO's GovValidators contract.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        candidate: z.string().optional().describe("Optional address to check validator status for"),
      },
      outputSchema: {
        govPool: z.string(),
        validators: z.string(),
        count: z.string(),
        candidate: z.string().nullable(),
        isValidator: z.boolean().nullable(),
      },
    },
    async ({ govPool, candidate }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (candidate && !isAddress(candidate)) return errorResult(`Invalid candidate: ${candidate}`);
      try {
        const provider = rpc.requireProvider();
        const gp = new Interface(GOV_POOL_ABI as unknown as string[]);
        const v = new Interface(GOV_VALIDATORS_ABI as unknown as string[]);
        const [helpersR] = await multicall(provider, [
          { target: govPool, iface: gp, method: "getHelperContracts", args: [] },
        ]);
        if (!helpersR?.success) return errorResult("getHelperContracts reverted");
        const validators = (helpersR.value as unknown as { validators: string }).validators;

        const calls: Call[] = [
          { target: validators, iface: v, method: "validatorsCount", args: [] },
        ];
        if (candidate) {
          calls.push({
            target: validators,
            iface: v,
            method: "isValidator",
            args: [candidate],
            allowFailure: true,
          });
        }
        const res = await multicall(provider, calls);
        const count = (res[0]!.value as bigint).toString();
        const isVal = candidate ? Boolean(res[1]?.value) : null;
        const structured = {
          govPool,
          validators,
          count,
          candidate: candidate ?? null,
          isValidator: isVal,
        };
        const text =
          `Validators contract ${validators}\n  count: ${count}` +
          (candidate ? `\n  ${candidate} isValidator: ${isVal}` : "");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(
          `read_validators failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

function registerSettings(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_settings",
    {
      title: "Default + internal proposal settings for a DAO",
      description:
        "Reads `GovSettings.getDefaultSettings()` and `getInternalSettings()` on the DAO's settings contract.",
      inputSchema: {
        govPool: z.string(),
      },
      outputSchema: {
        govPool: z.string(),
        settings: z.string(),
        defaultSettings: z.unknown(),
        internalSettings: z.unknown(),
      },
    },
    async ({ govPool }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const provider = rpc.requireProvider();
        const gp = new Interface(GOV_POOL_ABI as unknown as string[]);
        const s = new Interface(GOV_SETTINGS_ABI as unknown as string[]);
        const [helpersR] = await multicall(provider, [
          { target: govPool, iface: gp, method: "getHelperContracts", args: [] },
        ]);
        if (!helpersR?.success) return errorResult("getHelperContracts reverted");
        const settings = (helpersR.value as unknown as { settings: string }).settings;

        const [defR, intR] = await multicall(provider, [
          { target: settings, iface: s, method: "getDefaultSettings", args: [], allowFailure: true },
          { target: settings, iface: s, method: "getInternalSettings", args: [], allowFailure: true },
        ]);
        const structured = {
          govPool,
          settings,
          defaultSettings: jsonSafe(defR?.value ?? null),
          internalSettings: jsonSafe(intR?.value ?? null),
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Settings for ${govPool}\n  contract: ${settings}\n\n` +
                `default: ${JSON.stringify(structured.defaultSettings, null, 2)}\n\n` +
                `internal: ${JSON.stringify(structured.internalSettings, null, 2)}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `read_settings failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

function registerExpertStatus(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_expert_status",
    {
      title: "Expert + BABT status for a user in a DAO",
      description:
        "Reads `GovPool.getExpertStatus(user)` and, if a BABT contract is configured on the DAO, `BABT.balanceOf(user) > 0`.",
      inputSchema: {
        govPool: z.string(),
        user: z.string(),
      },
      outputSchema: {
        govPool: z.string(),
        user: z.string(),
        isExpert: z.boolean(),
        babt: z.string(),
        hasBabt: z.boolean().nullable(),
      },
    },
    async ({ govPool, user }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const provider = rpc.requireProvider();
        const gp = new Interface(GOV_POOL_ABI as unknown as string[]);
        const babt = new Interface(BABT_ABI as unknown as string[]);
        const [expertR, nftR] = await multicall(provider, [
          { target: govPool, iface: gp, method: "getExpertStatus", args: [user], allowFailure: true },
          { target: govPool, iface: gp, method: "getNftContracts", args: [], allowFailure: true },
        ]);
        const isExpert = expertR?.success ? Boolean(expertR.value) : false;
        const babtAddr = nftR?.success
          ? (nftR.value as unknown as { babt: string }).babt
          : ZeroAddress;
        let hasBabt: boolean | null = null;
        if (babtAddr && babtAddr !== ZeroAddress && isAddress(babtAddr)) {
          const [bR] = await multicall(provider, [
            { target: babtAddr, iface: babt, method: "balanceOf", args: [user], allowFailure: true },
          ]);
          if (bR?.success) hasBabt = (bR.value as bigint) > 0n;
        }
        const structured = { govPool, user, isExpert, babt: babtAddr, hasBabt };
        return {
          content: [
            {
              type: "text" as const,
              text: `Expert status for ${user} on ${govPool}: expert=${isExpert}, babt=${babtAddr}, hasBabt=${hasBabt}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(
          `read_expert_status failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

// ---------- helpers ----------

function coerceArg(a: unknown): unknown {
  // Allow stringified bigints for numeric args.
  if (typeof a === "string" && /^-?\d+$/.test(a) && a.length > 9) {
    try {
      return BigInt(a);
    } catch {
      return a;
    }
  }
  return a;
}

function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}
