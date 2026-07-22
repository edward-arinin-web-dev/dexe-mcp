import { z } from "zod";
import { Contract, Interface, isAddress, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { safeErrorMessage } from "../lib/redact.js";
import { renderUntrusted } from "../lib/sanitize.js";
import { GET_TIER_VIEWS_FRAGMENT, GET_USER_VIEWS_FRAGMENT } from "./otc.js";
import { DEFAULTS } from "../config.js";
import { chainIdParam } from "../lib/params.js";

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

// Authoritative TokenSaleProposal read ABI. `getTierViews` uses the NESTED
// TierView shape (Bug #25) shared from otc.ts — a private flat copy here used
// to decode garbage / revert (BAD_DATA) against live tiers.
const TOKEN_SALE_READ_ABI = [
  "function latestTierId() view returns (uint256)",
  GET_TIER_VIEWS_FRAGMENT,
  GET_USER_VIEWS_FRAGMENT,
] as const;

const DISTRIBUTION_READ_ABI = [
  "function isClaimed(uint256 proposalId, address voter) view returns (bool)",
  "function getPotentialReward(uint256 proposalId, address voter) view returns (uint256)",
] as const;

// Mirrors the deployed IStakingProposal structs exactly: StakingInfoView = 9
// fields, TierUserInfo = 8 fields (contracts/interfaces/gov/proposals/IStakingProposal.sol).
// W39: a too-narrow ABI silently corrupts the decoded numbers — getActiveStakings
// (dynamic, has `string metadata`) throws and gets swallowed as empty, while
// getUserInfo (all-static) in-bounds head-aliases real values onto the wrong
// names with NO error. Keep these in lockstep with the deployed structs.
export const STAKING_READ_ABI = [
  "function stakingsCount() view returns (uint256)",
  "function getActiveStakings() view returns (tuple(uint256 id, string metadata, address rewardToken, uint256 totalRewardsAmount, uint256 startedAt, uint256 deadline, bool isActive, uint256 totalStaked, uint256 owedToProtocol)[] stakings)",
  "function getUserInfo(address user) view returns (tuple(uint256 tierId, bool isActive, address rewardToken, uint256 startedAt, uint256 deadline, uint256 currentStake, uint256 currentRewards, uint256 tierCurrentStakes)[] tiersUserInfo)",
] as const;

const USER_REGISTRY_READ_ABI = [
  "function documentHash() view returns (bytes32)",
  "function agreed(address user) view returns (bool)",
] as const;

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  registerMulticall(server, rpc);
  registerTreasury(server, rpc);
  registerTokenHolders(server, rpc);
  registerDaoStats(server, rpc);
  registerNftsByWallet(server, rpc);
  registerValidators(server, rpc);
  registerSettings(server, rpc);
  registerExpertStatus(server, rpc);
  // Phase C — participation reads
  registerTokenSaleTiers(server, rpc);
  registerTokenSaleUser(server, rpc);
  registerDistributionStatus(server, rpc);
  registerStakingInfo(server, rpc);
  // Privacy policy
  registerPrivacyPolicyStatus(server, rpc);
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
        chainId: chainIdParam,
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
    async ({ chainId, calls }) => {
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
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
          `read_multicall failed: ${safeErrorMessage(err)}`,
        );
      }
    },
  );
}

// EVM native-coin sentinel used by the DeXe backend balance API (0xEeee…eEeE).
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

interface BackendBalanceRow {
  token_address?: string;
  symbol?: string | null;
  name?: string | null;
  decimals?: string | number | null;
  balance?: string | null;
  usd_price?: string | number | null;
}

/**
 * Fetch ALL token balances for an address from the DeXe backend
 * (`api-proxy-cache/<chain>/wallet-balances/<addr>`) — the exact endpoint the
 * app.dexe.io treasury view uses. Auto-discovers every token (no need to pass
 * addresses) and returns Moralis USD prices. Follows `next_page_token`.
 */
async function fetchBackendBalances(
  base: string,
  chainId: number,
  holder: string,
): Promise<BackendBalanceRow[]> {
  const out: BackendBalanceRow[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    const url = new URL(
      `${base}/integrations/api-proxy-cache/${chainId}/wallet-balances/${holder}`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let json: { balances?: BackendBalanceRow[]; next_page_token?: string };
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
      json = (await res.json()) as typeof json;
    } finally {
      clearTimeout(timer);
    }
    for (const row of json.balances ?? []) out.push(row);
    pageToken = json.next_page_token ?? "";
    if (!pageToken || seen.has(pageToken)) break;
    seen.add(pageToken);
  }
  return out;
}

function registerTreasury(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_treasury",
    {
      title: "Native + ERC20 balances (with USD) for a DAO or arbitrary address",
      description:
        "Treasury / wallet balances for any address. By default auto-discovers EVERY token via the DeXe backend (same source as app.dexe.io) and returns USD prices + a total. Falls back to on-chain RPC multicall on testnet (chain 97), when the backend is unset/unreachable, or when explicit `tokens` are passed. Pass a GovPool address to read a DAO treasury.",
      inputSchema: {
        holder: z.string().describe("Address whose balances we read"),
        tokens: z
          .array(z.string())
          .default([])
          .describe("Optional explicit ERC20 addresses; forces on-chain RPC read of just these"),
        chainId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Chain to query (defaults to the configured default chain)"),
      },
      outputSchema: {
        holder: z.string(),
        chainId: z.number(),
        source: z.enum(["backend", "rpc"]),
        native: z.string(),
        totalUsd: z.number().nullable(),
        tokens: z.array(
          z.object({
            token: z.string(),
            symbol: z.string().nullable(),
            name: z.string().nullable(),
            decimals: z.number().nullable(),
            balance: z.string().nullable(),
            usdPrice: z.number().nullable(),
            usdValue: z.number().nullable(),
          }),
        ),
      },
    },
    async ({ holder, tokens = [], chainId: chainIdArg }) => {
      if (!isAddress(holder)) return errorResult(`Invalid holder: ${holder}`);
      const chainId = rpc.resolveChainId(chainIdArg);
      const backendBase = (process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl).replace(
        /\/+$/,
        "",
      );
      // Backend covers only chains it caches (mainnets). Testnet 97 and explicit
      // token reads must go on-chain.
      const useBackend = chainId !== 97 && tokens.length === 0;

      if (useBackend) {
        try {
          const rows = await fetchBackendBalances(backendBase!, chainId, holder);
          const tokensOut = rows.map((b) => {
            const decimals = b.decimals != null && b.decimals !== "" ? Number(b.decimals) : null;
            const balance = b.balance ?? null;
            const usdPrice = b.usd_price != null && b.usd_price !== "" ? Number(b.usd_price) : null;
            let usdValue: number | null = null;
            if (balance != null && decimals != null && usdPrice != null) {
              usdValue = (Number(balance) / 10 ** decimals) * usdPrice;
            }
            return {
              token: (b.token_address ?? "").toLowerCase(),
              symbol: b.symbol ?? null,
              name: b.name ?? null,
              decimals,
              balance,
              usdPrice,
              usdValue,
            };
          });
          const nativeRow = tokensOut.find((t) => t.token === NATIVE_SENTINEL);
          const native = nativeRow?.balance ?? "0";
          const priced = tokensOut.filter((t) => t.usdValue != null);
          const totalUsd = priced.length
            ? priced.reduce((s, t) => s + (t.usdValue ?? 0), 0)
            : null;
          const structured = { holder, chainId, source: "backend" as const, native, totalUsd, tokens: tokensOut };
          const top = [...tokensOut]
            .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
            .slice(0, 15);
          const text =
            `Treasury for ${holder} (chain ${chainId}, source: backend)\n` +
            `  tokens: ${tokensOut.length}` +
            (totalUsd != null ? `   total: $${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "") +
            `\n` +
            top
              .map((t) => {
                const amt =
                  t.balance != null && t.decimals != null
                    ? (Number(t.balance) / 10 ** t.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })
                    : (t.balance ?? "?");
                const usd = t.usdValue != null ? ` = $${t.usdValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
                return `  ${(t.symbol != null ? renderUntrusted(t.symbol) : "?").padEnd(10)} ${amt}${usd}`;
              })
              .join("\n") +
            (tokensOut.length > top.length ? `\n  … +${tokensOut.length - top.length} more` : "");
          return { content: [{ type: "text" as const, text }], structuredContent: structured };
        } catch (err) {
          // Fall through to the on-chain path; report why the backend was skipped.
          return errorResult(
            `read_treasury backend fetch failed (${safeErrorMessage(err)}). ` +
              `Retry with explicit \`tokens\` for an on-chain read, or check DEXE_BACKEND_API_URL.`,
          );
        }
      }

      // On-chain path: testnet, explicit tokens, or no backend configured.
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
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
          name: null as string | null,
          decimals: res[i * 3 + 2]?.success ? Number(res[i * 3 + 2]!.value as bigint) : null,
          usdPrice: null as number | null,
          usdValue: null as number | null,
        }));
        const structured = { holder, chainId, source: "rpc" as const, native, totalUsd: null, tokens: tokensOut };
        const text =
          `Treasury for ${holder} (chain ${chainId}, source: rpc)\n  native: ${native}\n` +
          tokensOut
            .map(
              (t) =>
                `  ${t.symbol != null ? renderUntrusted(t.symbol) : "?"} (${t.token}): ${t.balance ?? "?"}${t.decimals != null ? ` (decimals=${t.decimals})` : ""}`,
            )
            .join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(
          `read_treasury failed: ${safeErrorMessage(err)}`,
        );
      }
    },
  );
}

/**
 * Generic GET against the DeXe backend (`DEXE_BACKEND_API_URL`, defaults to
 * https://api.dexe.io — the same host the app.dexe.io UI uses). Always resolves
 * a base URL (env override or baked default) so backend reads work zero-config.
 */
async function backendGetJson<T>(path: string, timeoutMs = 8000): Promise<T> {
  const base = (process.env.DEXE_BACKEND_API_URL?.trim() || DEFAULTS.backendApiUrl).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`backend HTTP ${res.status} for ${path}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function registerTokenHolders(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_token_holders",
    {
      title: "Top holders of an ERC20 token (with balances)",
      description:
        "Lists holders + raw balances for any ERC20 via the DeXe backend (same source as app.dexe.io holder lists). Sorted by balance desc. Backend-only — mainnets, not testnet 97.",
      inputSchema: {
        token: z.string().describe("ERC20 token contract address"),
        chainId: z.number().int().positive().optional().describe("Chain (default: configured default)"),
        pageSize: z.number().int().positive().max(1000).default(100).describe("Max holders to return"),
      },
      outputSchema: {
        token: z.string(),
        chainId: z.number(),
        count: z.number(),
        nextPageToken: z.string(),
        holders: z.array(z.object({ holder: z.string(), balance: z.string() })),
      },
    },
    async ({ token, chainId: chainIdArg, pageSize = 100 }) => {
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      const chainId = rpc.resolveChainId(chainIdArg);
      try {
        const json = await backendGetJson<{
          next_page_token?: string;
          holders_balances?: Record<string, string>;
        }>(`/integrations/api-proxy-cache/${chainId}/token-holders-balances/${token}?page_size=${pageSize}`);
        const holders = Object.entries(json.holders_balances ?? {})
          .map(([holder, balance]) => ({ holder, balance }))
          .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
        const structured = {
          token,
          chainId,
          count: holders.length,
          nextPageToken: json.next_page_token ?? "",
          holders,
        };
        const text =
          `Holders of ${token} (chain ${chainId}): ${holders.length}\n` +
          holders
            .slice(0, 20)
            .map((h, i) => `  ${String(i + 1).padStart(2)}. ${h.holder}  ${h.balance}`)
            .join("\n") +
          (holders.length > 20 ? `\n  … +${holders.length - 20} more` : "");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(`read_token_holders failed: ${safeErrorMessage(err)}`);
      }
    },
  );
}

function registerDaoStats(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_dao_stats",
    {
      title: "DAO TVL + activity stats time series",
      description:
        "Time series of DAO stats (tvl_usd, member counts, proposal counts, delegations) from the DeXe tracker — the app.dexe.io profile chart source. `period` is a human duration like '24 hours', '7 days', '1 months'. Backend-only — mainnets.",
      inputSchema: {
        govPool: z.string().describe("GovPool / DAO address"),
        chainId: z.number().int().positive().optional().describe("Chain (default: configured default)"),
        period: z.string().default("7 days").describe("Duration window, e.g. '24 hours', '7 days', '1 months'"),
        maxPoints: z
          .number()
          .int()
          .min(2)
          .max(2000)
          .default(30)
          .describe(
            "Cap on returned data points; longer series are evenly downsampled (first and last points always kept). The tracker emits ~hourly points — '1 months' is ~740 raw points / ~650 KB, far beyond a usable context window.",
          ),
      },
      outputSchema: {
        govPool: z.string(),
        chainId: z.number(),
        period: z.string(),
        points: z.number().describe("Raw point count returned by the tracker"),
        returnedPoints: z.number().describe("Points in `data` after downsampling"),
        downsampled: z.boolean(),
        data: z.array(z.record(z.unknown())),
      },
    },
    async ({ govPool, chainId: chainIdArg, period = "7 days", maxPoints = 30 }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      const chainId = rpc.resolveChainId(chainIdArg);
      try {
        const json = await backendGetJson<{
          data?: Array<{ id?: number; attributes?: Record<string, unknown> }>;
          status?: string;
        }>(`/integrations/tracker/${chainId}/pools/gov/${govPool}/stats/${encodeURIComponent(period)}`);
        const rows = (json.data ?? []).map((d) => d.attributes ?? {});
        let sampled = rows;
        if (rows.length > maxPoints) {
          sampled = [];
          const step = (rows.length - 1) / (maxPoints - 1);
          for (let i = 0; i < maxPoints; i++) sampled.push(rows[Math.round(i * step)]!);
        }
        const structured = {
          govPool,
          chainId,
          period,
          points: rows.length,
          returnedPoints: sampled.length,
          downsampled: sampled.length < rows.length,
          data: sampled,
        };
        const latest = rows[rows.length - 1] as Record<string, unknown> | undefined;
        const text =
          `DAO stats ${govPool} (chain ${chainId}, period '${period}'): ${rows.length} point(s)` +
          (structured.downsampled ? ` → ${sampled.length} returned (downsampled; raise maxPoints for more)` : "") +
          "\n" +
          (latest
            ? `  latest → tvl_usd: ${latest.tvl_usd ?? "?"}, active_members: ${latest.active_members_count ?? "?"}, ` +
              `external_proposals: ${latest.external_proposals_count ?? "?"}`
            : "  (no data — DAO may have no tracked activity in this window; freshly created DAOs take a while to appear in the tracker)");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(`read_dao_stats failed: ${safeErrorMessage(err)}`);
      }
    },
  );
}

function registerNftsByWallet(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_nfts",
    {
      title: "NFTs held by an address",
      description:
        "Lists NFTs owned by any address via the DeXe backend (Moralis-backed, same source as app.dexe.io). Backend-only — mainnets, not testnet 97.",
      inputSchema: {
        holder: z.string().describe("Address whose NFTs we read"),
        chainId: z.number().int().positive().optional().describe("Chain (default: configured default)"),
        tokens: z.array(z.string()).default([]).describe("Optional NFT contract addresses to filter by"),
        pageSize: z.number().int().positive().max(1000).default(100).describe("Max NFTs to return"),
      },
      outputSchema: {
        holder: z.string(),
        chainId: z.number(),
        count: z.number(),
        nextPageToken: z.string(),
        nfts: z.array(z.record(z.unknown())),
      },
    },
    async ({ holder, chainId: chainIdArg, tokens = [], pageSize = 100 }) => {
      if (!isAddress(holder)) return errorResult(`Invalid holder: ${holder}`);
      for (const t of tokens) if (!isAddress(t)) return errorResult(`Invalid token: ${t}`);
      const chainId = rpc.resolveChainId(chainIdArg);
      try {
        const qs = new URLSearchParams({ format: "decimal", page_size: String(pageSize) });
        if (tokens.length) qs.set("token_addresses", tokens.join(","));
        const json = await backendGetJson<{
          next_page_token?: string;
          nft_data?: Array<Record<string, unknown>>;
        }>(`/integrations/api-proxy-cache/${chainId}/nfts-by-wallet/${holder}?${qs.toString()}`);
        const nfts = json.nft_data ?? [];
        const structured = {
          holder,
          chainId,
          count: nfts.length,
          nextPageToken: json.next_page_token ?? "",
          nfts,
        };
        const text =
          `NFTs for ${holder} (chain ${chainId}): ${nfts.length}\n` +
          nfts
            .slice(0, 20)
            .map((n) => {
              const name = (n.name ?? n.symbol ?? "?") as string;
              return `  ${renderUntrusted(String(name))}  #${n.token_id ?? "?"} (${n.token_address ?? "?"})`;
            })
            .join("\n") +
          (nfts.length > 20 ? `\n  … +${nfts.length - 20} more` : "");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(`read_nfts failed: ${safeErrorMessage(err)}`);
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
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        validators: z.string(),
        count: z.string(),
        candidate: z.string().nullable(),
        isValidator: z.boolean().nullable(),
      },
    },
    async ({ govPool, candidate, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (candidate && !isAddress(candidate)) return errorResult(`Invalid candidate: ${candidate}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
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
          `read_validators failed: ${safeErrorMessage(err)}`,
        );
      }
    },
  );
}

// Field order mirrors IGovSettings.ProposalSettings / RewardsInfo
// (DeXe-Protocol contracts/interfaces/gov/settings/IGovSettings.sol).
const SETTINGS_FIELDS = [
  "earlyCompletion",
  "delegatedVotingAllowed",
  "validatorsVote",
  "duration",
  "durationValidators",
  "executionDelay",
  "quorum",
  "quorumValidators",
  "minVotesForVoting",
  "minVotesForCreating",
  "rewardsInfo",
  "executorDescription",
] as const;
const REWARDS_INFO_FIELDS = ["rewardToken", "creationReward", "executionReward", "voteRewardsCoefficient"] as const;

export function labelProposalSettings(v: unknown): unknown {
  const arr = v as unknown[] | null;
  if (!Array.isArray(arr) || arr.length < SETTINGS_FIELDS.length) return arr;
  const o: Record<string, unknown> = {};
  SETTINGS_FIELDS.forEach((f, i) => {
    o[f] = arr[i];
  });
  const ri = o.rewardsInfo;
  if (Array.isArray(ri) && ri.length >= REWARDS_INFO_FIELDS.length) {
    const r: Record<string, unknown> = {};
    REWARDS_INFO_FIELDS.forEach((f, i) => {
      r[f] = ri[i];
    });
    o.rewardsInfo = r;
  }
  for (const [raw, pct] of [
    ["quorum", "quorumPct"],
    ["quorumValidators", "quorumValidatorsPct"],
  ] as const) {
    try {
      // percent × 1e25, computed in BigInt to avoid float drift; 4 decimals kept
      o[pct] = Number((BigInt(String(o[raw])) * 10000n) / 10n ** 25n) / 10000;
    } catch {
      /* non-numeric — skip derived field */
    }
  }
  return o;
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
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        settings: z.string(),
        defaultSettings: z.unknown(),
        internalSettings: z.unknown(),
      },
    },
    async ({ govPool, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
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
          defaultSettings: labelProposalSettings(jsonSafe(defR?.value ?? null)),
          internalSettings: labelProposalSettings(jsonSafe(intR?.value ?? null)),
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
          `read_settings failed: ${safeErrorMessage(err)}`,
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
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        user: z.string(),
        isExpert: z.boolean(),
        babt: z.string(),
        hasBabt: z.boolean().nullable(),
      },
    },
    async ({ govPool, user, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid govPool: ${govPool}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
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
          `read_expert_status failed: ${safeErrorMessage(err)}`,
        );
      }
    },
  );
}

// ---------- token sale reads ----------

function registerTokenSaleTiers(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_token_sale_tiers",
    {
      title: "Read token sale tier details",
      description:
        "Reads tier count via `latestTierId()` and tier details via `getTierViews(offset, limit)` from a TokenSaleProposal contract.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        offset: z.number().default(0).describe("Pagination offset"),
        limit: z.number().default(10).describe("Max tiers to return"),
        chainId: chainIdParam,
      },
    },
    async ({ tokenSaleProposal, offset = 0, limit = 10, chainId }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(TOKEN_SALE_READ_ABI as unknown as string[]);
        const [countR] = await multicall(provider, [
          { target: tokenSaleProposal, iface, method: "latestTierId", args: [], allowFailure: true },
        ]);
        const totalTiers = countR?.success ? Number(countR.value as bigint) : 0;
        if (totalTiers === 0) {
          return {
            content: [{ type: "text" as const, text: `No tiers found on ${tokenSaleProposal}` }],
            structuredContent: { tokenSaleProposal, totalTiers: 0, tiers: [] },
          };
        }
        const [tiersR] = await multicall(provider, [
          { target: tokenSaleProposal, iface, method: "getTierViews", args: [offset, limit], allowFailure: true },
        ]);
        const tiers = tiersR?.success ? jsonSafe(tiersR.value) : [];
        const structured = { tokenSaleProposal, totalTiers, offset, limit, tiers };
        return {
          content: [{ type: "text" as const, text: `TokenSale ${tokenSaleProposal}: ${totalTiers} tier(s), showing offset=${offset} limit=${limit}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(`read_token_sale_tiers failed: ${safeErrorMessage(err)}`);
      }
    },
  );
}

function registerTokenSaleUser(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_token_sale_user",
    {
      title: "Read user participation status in token sale tiers",
      description:
        "Reads `getUserViews(user, tierIds)` from a TokenSaleProposal — returns per-tier purchase status, claimable amounts, and vesting info.",
      inputSchema: {
        tokenSaleProposal: z.string().describe("TokenSaleProposal contract address"),
        user: z.string().describe("User address to query"),
        tierIds: z.array(z.string()).min(1).describe("Tier IDs to check"),
        chainId: chainIdParam,
      },
    },
    async ({ tokenSaleProposal, user, tierIds, chainId }) => {
      if (!isAddress(tokenSaleProposal)) return errorResult(`Invalid tokenSaleProposal: ${tokenSaleProposal}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(TOKEN_SALE_READ_ABI as unknown as string[]);
        const [viewsR] = await multicall(provider, [
          {
            target: tokenSaleProposal,
            iface,
            method: "getUserViews",
            args: [user, tierIds.map((id) => BigInt(id)), tierIds.map(() => [])],
            allowFailure: true,
          },
        ]);
        const userViews = viewsR?.success ? jsonSafe(viewsR.value) : [];
        const structured = { tokenSaleProposal, user, tierIds, userViews };
        return {
          content: [{ type: "text" as const, text: `TokenSale user views for ${user}: ${tierIds.length} tier(s) queried` }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(`read_token_sale_user failed: ${safeErrorMessage(err)}`);
      }
    },
  );
}

// ---------- distribution reads ----------

function registerDistributionStatus(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_distribution_status",
    {
      title: "Check claimable amounts for distribution proposals",
      description:
        "For each proposal ID, reads `isClaimed(proposalId, voter)` and `getPotentialReward(proposalId, voter)` from a DistributionProposal contract.",
      inputSchema: {
        distributionProposal: z.string().describe("DistributionProposal contract address"),
        voter: z.string().describe("Voter address to check"),
        proposalIds: z.array(z.string()).min(1).describe("Proposal IDs to check"),
        chainId: chainIdParam,
      },
    },
    async ({ distributionProposal, voter, proposalIds, chainId }) => {
      if (!isAddress(distributionProposal)) return errorResult(`Invalid distributionProposal: ${distributionProposal}`);
      if (!isAddress(voter)) return errorResult(`Invalid voter: ${voter}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(DISTRIBUTION_READ_ABI as unknown as string[]);
        const calls: Call[] = [];
        for (const pid of proposalIds) {
          const id = BigInt(pid);
          calls.push({ target: distributionProposal, iface, method: "isClaimed", args: [id, voter], allowFailure: true });
          calls.push({ target: distributionProposal, iface, method: "getPotentialReward", args: [id, voter], allowFailure: true });
        }
        const res = await multicall(provider, calls);
        const distributions = proposalIds.map((pid, i) => ({
          proposalId: pid,
          isClaimed: res[i * 2]?.success ? Boolean(res[i * 2]!.value) : null,
          potentialReward: res[i * 2 + 1]?.success ? (res[i * 2 + 1]!.value as bigint).toString() : null,
        }));
        const structured = { distributionProposal, voter, distributions };
        const text = distributions
          .map((d) => `  proposal ${d.proposalId}: claimed=${d.isClaimed}, reward=${d.potentialReward ?? "?"}`)
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Distribution status for ${voter}:\n${text}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(`read_distribution_status failed: ${safeErrorMessage(err)}`);
      }
    },
  );
}

// ---------- staking reads ----------

function registerStakingInfo(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_staking_info",
    {
      title: "Read staking tier details and user info",
      description:
        "Reads `stakingsCount()` and `getActiveStakings()` from a StakingProposal. Pass either the StakingProposal address directly OR a `govPool` — the tool resolves the StakingProposal via GovPool.getHelperContracts().userKeeper → GovUserKeeper.stakingProposalAddress() (the same way create_staking_tier does). Optionally reads `getUserInfo(user)` for a specific user's staked amounts and pending rewards.",
      inputSchema: {
        stakingProposal: z
          .string()
          .optional()
          .describe(
            "StakingProposal contract address. Omit and pass `govPool` to auto-resolve it (zero result = staking not deployed yet).",
          ),
        govPool: z
          .string()
          .optional()
          .describe("GovPool address — auto-resolves the StakingProposal when `stakingProposal` is omitted."),
        user: z.string().optional().describe("Optional user address to get their staking details"),
        chainId: chainIdParam,
      },
    },
    async ({ stakingProposal, govPool, user, chainId }) => {
      if (user && !isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        // Resolve the StakingProposal address from a GovPool when not given directly.
        if (!stakingProposal) {
          if (!govPool || !isAddress(govPool)) {
            return errorResult("Provide `stakingProposal` OR a valid `govPool` to resolve it from.");
          }
          const helperIface = new Interface([
            "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
          ]);
          const keeperIface = new Interface(["function stakingProposalAddress() view returns (address)"]);
          const hres = await multicall(provider, [
            { target: govPool, iface: helperIface, method: "getHelperContracts", args: [], allowFailure: true },
          ]);
          const userKeeper = hres[0]?.success ? ((hres[0]!.value as unknown[])[1] as string) : undefined;
          if (!userKeeper) return errorResult(`Could not read getHelperContracts() on govPool ${govPool}.`);
          const sres = await multicall(provider, [
            { target: userKeeper, iface: keeperIface, method: "stakingProposalAddress", args: [], allowFailure: true },
          ]);
          const resolved = sres[0]?.success ? (sres[0]!.value as string) : undefined;
          if (!resolved || resolved === ZeroAddress) {
            return errorResult(
              `This DAO has no StakingProposal deployed yet (userKeeper.stakingProposalAddress() = ${resolved ?? "unreadable"}). ` +
                "Deploy it first via GovUserKeeper.deployStakingProposal(), then re-read.",
            );
          }
          stakingProposal = resolved;
        }
        if (!isAddress(stakingProposal)) return errorResult(`Invalid stakingProposal: ${stakingProposal}`);
        const iface = new Interface(STAKING_READ_ABI as unknown as string[]);
        const baseCalls: Call[] = [
          { target: stakingProposal, iface, method: "stakingsCount", args: [], allowFailure: true },
          { target: stakingProposal, iface, method: "getActiveStakings", args: [], allowFailure: true },
        ];
        if (user) {
          baseCalls.push({ target: stakingProposal, iface, method: "getUserInfo", args: [user], allowFailure: true });
        }
        const res = await multicall(provider, baseCalls);
        const count = res[0]?.success ? Number(res[0].value as bigint) : 0;
        const warnings: string[] = [];
        if (!res[0]?.success) {
          // Same W39 rule as getActiveStakings below: a decode/call failure must
          // never read as a truthful "0 tiers".
          warnings.push(
            `stakingsCount() did not decode (${res[0]?.error ?? "unknown"}); the count 0 is a fallback, not a read value.`,
          );
        }
        const stakingsOk = !!res[1]?.success;
        if (!stakingsOk) {
          // W39: surface a decode failure explicitly instead of returning a
          // silent empty list that reads as "no stakings".
          warnings.push(
            `getActiveStakings() did not decode (${res[1]?.error ?? "unknown"}); values omitted rather than reported as empty.`,
          );
        }
        const activeStakings = stakingsOk ? (res[1]!.value as unknown[]).map(namedResult) : [];
        let userInfo: unknown = null;
        if (user) {
          if (res[2]?.success) {
            userInfo = (res[2].value as unknown[]).map(namedResult);
          } else {
            warnings.push(`getUserInfo(${user}) did not decode (${res[2]?.error ?? "unknown"}).`);
          }
        }
        const structured = {
          stakingProposal,
          stakingsCount: count,
          activeStakings,
          user: user ?? null,
          userInfo,
          ...(warnings.length ? { warnings } : {}),
        };
        let text = `Staking ${stakingProposal}: ${count} tier(s)` + (user ? `, user ${user} info included` : "");
        if (warnings.length) text += "\n⚠ " + warnings.join("\n⚠ ");
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(`read_staking_info failed: ${safeErrorMessage(err)}`);
      }
    },
  );
}

// ---------- privacy policy reads ----------

function registerPrivacyPolicyStatus(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_privacy_policy_status",
    {
      title: "Check privacy policy agreement status",
      description:
        "Reads `UserRegistry.documentHash()` and `UserRegistry.agreed(user)`. Returns the current policy hash and whether the user has agreed.",
      inputSchema: {
        userRegistry: z.string().describe("UserRegistry contract address"),
        user: z.string().describe("User address to check"),
        chainId: chainIdParam,
      },
    },
    async ({ userRegistry, user, chainId }) => {
      if (!isAddress(userRegistry)) return errorResult(`Invalid userRegistry: ${userRegistry}`);
      if (!isAddress(user)) return errorResult(`Invalid user: ${user}`);
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const iface = new Interface(USER_REGISTRY_READ_ABI as unknown as string[]);
        const [hashR, agreedR] = await multicall(provider, [
          { target: userRegistry, iface, method: "documentHash", args: [], allowFailure: true },
          { target: userRegistry, iface, method: "agreed", args: [user], allowFailure: true },
        ]);
        const documentHash = hashR?.success ? String(hashR.value) : null;
        const hasAgreed = agreedR?.success ? Boolean(agreedR.value) : null;
        const structured = { userRegistry, user, documentHash, hasAgreed };
        return {
          content: [
            {
              type: "text" as const,
              text: `Privacy policy for ${user}: agreed=${hasAgreed}, documentHash=${documentHash ?? "?"}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(`read_privacy_policy_status failed: ${safeErrorMessage(err)}`);
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

/**
 * Convert an ethers v6 Result (an Array subclass — JSON-serializes positionally
 * and loses field names) into a plain named object before jsonSafe. Falls back
 * to positional serialization for non-Result values.
 */
function namedResult(v: unknown): unknown {
  if (v && typeof (v as { toObject?: unknown }).toObject === "function") {
    return jsonSafe((v as { toObject: (deep?: boolean) => unknown }).toObject(true));
  }
  return jsonSafe(v);
}
