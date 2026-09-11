import { z } from "zod";
import { Contract, Interface, isAddress, ZeroAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { safeErrorMessage } from "../lib/redact.js";
import { renderUntrusted, untrustedResult } from "../lib/sanitize.js";
import { GET_TIER_VIEWS_FRAGMENT, GET_USER_VIEWS_FRAGMENT } from "./otc.js";
import { DEFAULTS } from "../config.js";
import { chainIdParam } from "../lib/params.js";
import { toActionableError } from "../lib/errors.js";
import { pageMeta, truncationNote } from "../lib/page.js";
import { GOV_POWER_DECIMALS, formatUnitsWithSymbol, withFormatted } from "../lib/units.js";

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
  registerProtocolStats(server);
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
        // The target is arbitrary and the ABI says "returns (string)" whenever
        // the caller asks it to, so a decoded value is whatever a hostile
        // contract chose to return.
        const structured = {
          results: results.map((r) => ({
            success: r.success,
            value: jsonSafe(r.value),
            raw: r.raw,
            error: r.error,
          })),
        };
        return untrustedResult({
          summary: `${results.length} calls: ${results.filter((r) => r.success).length} ok, ${results.filter((r) => !r.success).length} failed`,
          label: "decoded return values (contract-authored)",
          structured,
        });
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_read_multicall").message,
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
): Promise<{ rows: BackendBalanceRow[]; capped: boolean }> {
  const out: BackendBalanceRow[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  let page = 0;
  for (; page < 20; page++) {
    const url = new URL(
      `${base}/integrations/api-proxy-cache/${chainId}/wallet-balances/${holder}`,
    );
    url.searchParams.set("page_size", String(BACKEND_MAX_PAGE_SIZE));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let json: { balances?: BackendBalanceRow[]; next_page_token?: string };
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
      json = (await res.json()) as typeof json;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`backend request timed out after 8000ms — usually transient, re-run the call`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    for (const row of json.balances ?? []) out.push(row);
    pageToken = json.next_page_token ?? "";
    if (!pageToken || seen.has(pageToken)) break;
    seen.add(pageToken);
  }
  // Exiting the loop with a live cursor means the 20-page / 2000-row ceiling
  // truncated the wallet. Silently returning a short list is the same "a
  // partial page reads as complete" defect the paged tools had.
  return { rows: out, capped: page >= 20 && pageToken !== "" };
}

function registerTreasury(server: McpServer, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_read_treasury",
    {
      title: "Native + ERC20 balances (with USD) for a DAO or arbitrary address",
      description:
        "Treasury / wallet balances for any address; pass a GovPool address for a DAO treasury. Auto-discovers EVERY token via the DeXe backend (same source as app.dexe.io) with USD prices + a total. Reads on-chain instead on chain 97, when `tokens` are given, or when the backend fails — that RPC path has no token discovery and reports `degraded: true`.",
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
        // True when this answer is less complete than the tool normally returns
        // — today that means the backend fell over and the RPC path (no token
        // auto-discovery, no USD) served the request instead. The reason rides
        // in the text body, not here: `tools/list` ships every outputSchema on
        // every session, and this tool is in the default profile, so an extra
        // declared field is a permanent per-session token cost.
        degraded: z.boolean(),
        native: z.string(),
        // Human rendering beside the wei. Declared `.optional()` because
        // zod-to-json-schema emits `additionalProperties: false` and the SDK
        // client validates structuredContent against the advertised schema —
        // and because `balanceFormatted` is absent whenever decimals are
        // unknown, which a required field would turn into a tool error.
        nativeFormatted: z.string().optional(),
        totalUsd: z.number().nullable(),
        tokens: z.array(
          z.object({
            token: z.string(),
            symbol: z.string().nullable(),
            name: z.string().nullable(),
            decimals: z.number().nullable(),
            balance: z.string().nullable(),
            balanceFormatted: z.string().optional(),
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
      // Set when the backend was tried and failed; the on-chain path below then
      // serves the request and reports itself as degraded.
      let backendError: string | null = null;

      if (useBackend) {
        try {
          const { rows, capped } = await fetchBackendBalances(backendBase!, chainId, holder);
          const tokensOut = rows.map((b) => {
            const decimals = b.decimals != null && b.decimals !== "" ? Number(b.decimals) : null;
            const balance = b.balance ?? null;
            const usdPrice = b.usd_price != null && b.usd_price !== "" ? Number(b.usd_price) : null;
            let usdValue: number | null = null;
            // Number("8521112653712523724538372026") loses the low digits before
            // the division ever happens. Scale through the decimal STRING that
            // formatUnits produces instead — the USD figure stays a number, but
            // it is a number derived from the exact balance.
            if (balance != null && decimals != null && usdPrice != null) {
              try {
                usdValue = Number(formatUnitsWithSymbol(balance, decimals)) * usdPrice;
              } catch {
                usdValue = null;
              }
            }
            const row = {
              token: (b.token_address ?? "").toLowerCase(),
              symbol: b.symbol ?? null,
              name: b.name ?? null,
              decimals,
              balance,
              usdPrice,
              usdValue,
            };
            // A raw ERC20 balance is in the TOKEN's decimals, which the backend
            // reports — never the 18 that governance power uses. `decimals`
            // null means unknown, and `withFormatted` then adds nothing rather
            // than guessing.
            return withFormatted(row, ["balance"], decimals, row.symbol ?? undefined);
          });
          const nativeRow = tokensOut.find((t) => t.token === NATIVE_SENTINEL);
          const native = nativeRow?.balance ?? "0";
          const priced = tokensOut.filter((t) => t.usdValue != null);
          const totalUsd = priced.length
            ? priced.reduce((s, t) => s + (t.usdValue ?? 0), 0)
            : null;
          const structured = {
            holder,
            chainId,
            source: "backend" as const,
            // `capped` means the 20-page discovery ceiling cut the token list
            // off, so this is a partial view of the wallet — exactly what
            // `degraded` already means here.
            degraded: capped,
            native,
            nativeFormatted: formatUnitsWithSymbol(native, 18, nativeSymbol(chainId)),
            totalUsd,
            tokens: tokensOut,
          };
          const top = [...tokensOut]
            .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
            .slice(0, 15);
          const cappedNote = capped
            ? `\n  PARTIAL: token discovery stopped at the backend's 2000-row page ceiling, so this wallet ` +
              `holds MORE tokens than are listed and the USD total covers only what is shown. ` +
              `Pass \`tokens\` explicitly to read a specific holding.`
            : "";
          const summary =
            `Treasury for ${holder} (chain ${chainId}, source: backend)${cappedNote}\n` +
            `  tokens: ${tokensOut.length}` +
            (totalUsd != null ? `   total: $${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "") +
            `\n` +
            top
              .map((t) => {
                // Exact-string conversion, then a display cap — never
                // Number(wei)/1e18, which silently drops the low digits.
                const amt =
                  t.balance != null && t.decimals != null
                    ? formatUnitsWithSymbol(t.balance, t.decimals)
                    : (t.balance ?? "?");
                const usd = t.usdValue != null ? ` = $${t.usdValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
                return `  ${(t.symbol != null ? renderUntrusted(t.symbol, 40) : "?").padEnd(10)} ${amt}${usd}`;
              })
              .join("\n") +
            (tokensOut.length > top.length ? `\n  … +${tokensOut.length - top.length} more` : "");
          // Anyone can mint an ERC20 and airdrop it into a treasury, so both
          // `symbol` and `name` are attacker-chosen for any row here.
          return untrustedResult({
            summary,
            label: "token symbols/names (any address can airdrop a token)",
            structured,
          });
        } catch (err) {
          // Actually fall through to the on-chain path. The tool description,
          // docs/PLAYBOOK.md and the knowledge corpus all promise this fallback;
          // returning an error here made the promise a lie and forced the caller
          // to re-invoke with `tokens` just to get a native balance. The RPC path
          // can't enumerate arbitrary holdings, so the answer is flagged
          // `degraded` rather than passed off as a complete treasury.
          backendError = safeErrorMessage(err);
        }
      }

      // On-chain path: testnet, explicit tokens, no backend configured, or a
      // degraded fall-through from a failed backend fetch.
      try {
        const pr = rpc.tryProvider(chainId);
        if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
        const provider = pr.ok;
        const native = (await provider.getBalance(holder)).toString();
        const iface = new Interface(ERC20_ABI as unknown as string[]);
        // No explicit tokens and no backend discovery here: if the holder is a
        // GovPool, at least surface its own gov token instead of a misleading
        // empty treasury (the RPC path can't enumerate arbitrary holdings).
        let discoveryNote = "";
        if (tokens.length === 0) {
          // Why the gov-token discovery produced nothing. A throw and an empty
          // result are DIFFERENT failures and the old code printed the same
          // sentence for both — see the note below the try/catch.
          let discoveryError: string | null = null;
          let discoveryReason = "";
          try {
            const helperIface = new Interface([
              "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
            ]);
            const keeperIface = new Interface(["function tokenAddress() view returns (address)"]);
            const [helpersR] = await multicall(provider, [
              { target: holder, iface: helperIface, method: "getHelperContracts", args: [], allowFailure: true },
            ]);
            if (!helpersR?.success) {
              discoveryReason =
                `${holder} is not a DeXe GovPool (getHelperContracts reverted), so it has no gov token to discover`;
            } else {
              const userKeeper = (helpersR.value as unknown as { userKeeper: string }).userKeeper;
              const [tokenR] = await multicall(provider, [
                { target: userKeeper, iface: keeperIface, method: "tokenAddress", args: [], allowFailure: true },
              ]);
              if (!tokenR?.success) {
                discoveryReason = `this DAO's UserKeeper (${userKeeper}) did not answer tokenAddress()`;
              } else {
                const govToken = tokenR.value as string;
                if (isAddress(govToken) && govToken !== ZeroAddress) {
                  tokens = [govToken];
                  discoveryNote =
                    "\n  note: token auto-discovery is unavailable on this path — showing the DAO's own gov token only. " +
                    "Pass `tokens` explicitly to read other holdings.";
                } else {
                  discoveryReason =
                    "this DAO's UserKeeper reports no ERC20 gov token (tokenAddress() is the zero address) — " +
                    "it is NFT-governed or not initialized";
                }
              }
            }
          } catch (err) {
            // A throw here is a TRANSPORT failure, never "not a GovPool": both
            // discovery calls use allowFailure, so a non-GovPool address comes
            // back as `success: false` and cannot reach this branch. Swallowing
            // it and then printing the structural note blamed the backend's
            // mainnet-only scope for what was actually a dead RPC — the exact
            // misattribution shape 0.30.2 was burned by. Keep the reason.
            discoveryError = safeErrorMessage(err);
          }
          if (tokens.length === 0) {
            const scopeNote =
              `\n  note: token auto-discovery is unavailable on this path (${
                backendError != null ? "the backend fetch failed" : "the backend covers mainnets only"
              }) — pass \`tokens\` (ERC20 addresses) explicitly to read balances.`;
            discoveryNote =
              (discoveryError != null
                ? `\n  DISCOVERY FAILED: the gov-token discovery read failed — ${discoveryError}. ` +
                  `That is a transport error (RPC/Multicall3 unreachable), NOT evidence that ${holder} is not a ` +
                  `GovPool — a non-GovPool address returns a failed call, it does not throw. Re-run once the RPC ` +
                  `responds, or pass \`tokens\` explicitly.`
                : `\n  discovery: ${discoveryReason || "no gov token was found"}.`) + scopeNote;
          }
        }
        const calls: Call[] = [];
        for (const t of tokens) {
          if (!isAddress(t)) throw new Error(`Invalid token: ${t}`);
          calls.push({ target: t, iface, method: "balanceOf", args: [holder], allowFailure: true });
          calls.push({ target: t, iface, method: "symbol", args: [], allowFailure: true });
          calls.push({ target: t, iface, method: "decimals", args: [], allowFailure: true });
        }
        const res = await multicall(provider, calls);
        const tokensOut = tokens.map((t, i) => {
          const row = {
            token: t,
            balance: res[i * 3]?.success ? (res[i * 3]!.value as bigint).toString() : null,
            symbol: res[i * 3 + 1]?.success ? (res[i * 3 + 1]!.value as string) : null,
            name: null as string | null,
            decimals: res[i * 3 + 2]?.success ? Number(res[i * 3 + 2]!.value as bigint) : null,
            usdPrice: null as number | null,
            usdValue: null as number | null,
          };
          // decimals() is allowFailure — when it reverts the balance stays raw
          // rather than being rendered against a guessed 18.
          return withFormatted(row, ["balance"], row.decimals, row.symbol ?? undefined);
        });
        const structured = {
          holder,
          chainId,
          source: "rpc" as const,
          degraded: backendError != null,
          native,
          nativeFormatted: formatUnitsWithSymbol(native, 18, nativeSymbol(chainId)),
          totalUsd: null,
          tokens: tokensOut,
        };
        const degradedNote =
          backendError != null
            ? `\n  DEGRADED: the DeXe backend failed (${backendError}), so this is an on-chain read — ` +
              `no USD prices and no token auto-discovery. Check DEXE_BACKEND_API_URL, or re-run with explicit \`tokens\`.`
            : "";
        const summary =
          `Treasury for ${holder} (chain ${chainId}, source: rpc)\n  native: ${native}\n` +
          tokensOut
            .map(
              (t) =>
                `  ${t.symbol != null ? renderUntrusted(t.symbol, 40) : "?"} (${t.token}): ${t.balance ?? "?"}${t.decimals != null ? ` (decimals=${t.decimals})` : ""}`,
            )
            .join("\n") +
          discoveryNote +
          degradedNote;
        return untrustedResult({
          summary,
          label: "token symbols (ERC20.symbol() is whatever the token returns)",
          structured,
        });
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_read_treasury").message,
        );
      }
    },
  );
}

/**
 * The api-proxy-cache endpoints reject `page_size > 100` with a deterministic
 * HTTP 400 (`{"meta":{"PageSize":"max"}}`), verified live on chain 56 for both
 * token-holders-balances and nfts-by-wallet. The cap is also stated by the
 * backend itself inside every continuation cursor (`"limit":100`). One constant
 * for all three call sites so the schemas cannot drift from the wire contract
 * again.
 */
const BACKEND_MAX_PAGE_SIZE = 100;

/**
 * Ticker for a chain's native coin — used only to label the formatted native
 * balance. Unknown chains get no symbol rather than a wrong one; the native
 * coin is 18 decimals on every EVM chain this server supports.
 */
function nativeSymbol(chainId: number): string | undefined {
  if (chainId === 56 || chainId === 97) return "BNB";
  if (chainId === 1 || chainId === 10) return "ETH";
  return undefined;
}

/**
 * Chains the api-proxy-cache actually indexes. Chain 10 returns HTTP 400 and
 * chain 97 returns an EMPTY 200 — which reads as "this token has no holders"
 * and is the worse of the two failures. Both tools document themselves as
 * mainnet-only and neither enforced it.
 */
const BACKEND_INDEXED_CHAINS = new Set([1, 56]);

/**
 * The chain these backend-only tools were asked about.
 *
 * `resolveChainId` throws for a chain with no configured RPC — but these two
 * tools never touch an RPC, so an unconfigured chain must not masquerade as an
 * RPC problem. Fall back to the requested id so the backend guard below can
 * give the answer that is actually true ("the backend does not index it").
 */
function backendChainOf(rpc: RpcProvider, requested: number | undefined): number {
  try {
    return rpc.resolveChainId(requested);
  } catch {
    return requested ?? 0;
  }
}

/** The unsupported-chain refusal, shared by the two backend-only list tools. */
function backendChainRefusal(chainId: number, tool: string): string {
  return (
    `chain ${chainId} is not indexed by the DeXe backend — ${tool} serves Ethereum (1) and BSC (56) only. ` +
    `Chain 97 (BSC testnet) has no backend index at all, so an empty list here would NOT mean "none exist". ` +
    `Re-run with chainId 1 or 56, or read on-chain instead: dexe_read_multicall (needs ` +
    `DEXE_TOOLSETS=core,read) for balanceOf, or dexe_read_treasury with an explicit \`tokens\` list.`
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
    // The query string can carry a 300-700 char continuation cursor (a base64
    // JWT). Echoing it into every transient error dumps that blob into the model
    // context and the transcript, so errors name the endpoint, not the cursor.
    const pathForError = path.split("?")[0];
    if (res.status === 400) {
      // Deliberately NOT the literal "backend HTTP 400": that substring matches
      // the generic `backend-failed` remedy ("wait and retry", "a 401 means the
      // Bearer token expired"), every clause of which is wrong for a
      // deterministic rejection of the caller's own argument.
      throw new Error(`DeXe backend rejected the request: HTTP 400 (bad request) for ${pathForError}`);
    }
    if (!res.ok) throw new Error(`backend HTTP ${res.status} for ${pathForError}`);
    return (await res.json()) as T;
  } catch (err) {
    // A bare AbortError surfaces as "This operation was aborted" — useless to
    // the caller. Translate to something actionable.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `DeXe backend request timed out after ${timeoutMs}ms (${path.split("?")[0]}) — usually transient, re-run the call. ` +
          `If it persists: check network access to ${base} or set DEXE_BACKEND_API_URL.`,
      );
    }
    throw err;
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
        "Holders + raw balances for any ERC20 from the DeXe backend, balance desc, one page at a time (see `pageToken`). Mainnets only (1, 56).",
      inputSchema: {
        token: z.string().describe("ERC20 token contract address"),
        chainId: z.number().int().positive().optional().describe("Chain (default: configured default)"),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(BACKEND_MAX_PAGE_SIZE)
          .default(BACKEND_MAX_PAGE_SIZE)
          .describe("Rows per page (backend max 100)."),
        pageToken: z
          .string()
          .max(8192)
          .optional()
          .describe("Prior result's `nextPageToken` for the next page."),
      },
      outputSchema: {
        token: z.string(),
        chainId: z.number(),
        count: z.number(),
        nextPageToken: z.string(),
        // The one added field. `count` is already the returned-row count, and
        // this tool is in the default profile, where every declared field is a
        // permanent per-session `tools/list` cost — so no `returned` twin.
        truncated: z.boolean().optional(),
        holders: z.array(z.object({ holder: z.string(), balance: z.string() })),
      },
    },
    async ({ token, chainId: chainIdArg, pageSize = BACKEND_MAX_PAGE_SIZE, pageToken }) => {
      if (!isAddress(token)) return errorResult(`Invalid token: ${token}`);
      const chainId = backendChainOf(rpc, chainIdArg);
      if (!BACKEND_INDEXED_CHAINS.has(chainId)) {
        return errorResult(backendChainRefusal(chainId, "dexe_read_token_holders"));
      }
      try {
        // URLSearchParams, not string concat: the cursor is base64 with `=`
        // padding and possibly `+`, which must be percent-encoded.
        const qs = new URLSearchParams({ page_size: String(pageSize) });
        if (pageToken) qs.set("page_token", pageToken);
        const json = await backendGetJson<{
          next_page_token?: string;
          holders_balances?: Record<string, string>;
        }>(`/integrations/api-proxy-cache/${chainId}/token-holders-balances/${token}?${qs.toString()}`);
        const holders = Object.entries(json.holders_balances ?? {})
          .map(([holder, balance]) => ({ holder, balance }))
          .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
        // Truncation comes from the cursor the backend hands back, never from
        // `rows === pageSize`: a page of 1 row WITH a cursor is real (observed
        // live on nfts-by-wallet).
        const nextPageToken = json.next_page_token ?? "";
        const structured = {
          token,
          chainId,
          count: holders.length,
          nextPageToken,
          truncated: nextPageToken !== "",
          holders,
        };
        const more = structured.truncated
          ? `\n⚠ MORE HOLDERS EXIST — this is one page, not the full list. Call dexe_read_token_holders ` +
            `again with the same token and chainId plus the \`pageToken\` from this result's ` +
            `nextPageToken. Do NOT report this page as the complete holder list.`
          : "";
        const text =
          `Holders of ${token} (chain ${chainId}): ${holders.length} on this page${more}\n` +
          holders
            .slice(0, 20)
            .map((h, i) => `  ${String(i + 1).padStart(2)}. ${h.holder}  ${h.balance}`)
            .join("\n") +
          (holders.length > 20
            ? `\n  … +${holders.length - 20} more on this page not shown above`
            : "");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_token_holders").message);
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
          `DAO stats ${govPool} (chain ${chainId}, period '${renderUntrusted(period, 40)}'): ${rows.length} point(s)` +
          (structured.downsampled ? ` → ${sampled.length} returned (downsampled; raise maxPoints for more)` : "") +
          "\n" +
          (latest
            ? `  latest → tvl_usd: ${latest.tvl_usd ?? "?"}, active_members: ${latest.active_members_count ?? "?"}, ` +
              `external_proposals: ${latest.external_proposals_count ?? "?"}`
            : "  (no data — DAO may have no tracked activity in this window; freshly created DAOs take a while to appear in the tracker)");
        return untrustedResult({
          summary: text,
          label: "tracker rows (third-party index)",
          structured,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_dao_stats").message);
      }
    },
  );
}

/** Evenly downsample a series to at most `max` points, always keeping first and last. */
export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)]!);
  return out;
}

function registerProtocolStats(server: McpServer): void {
  server.registerTool(
    "dexe_read_protocol_stats",
    {
      title: "Protocol-wide stats — TVL, proposals, DAOs across chains",
      description:
        "The app.dexe.io landing-page numbers: total TVL across ALL DAOs (server-side aggregated over `chainIds`), total proposals created, total DAO count, voting-locked token value, 24h change percents, and a TVL time series. Optionally includes the top-N DAOs by TVL per chain (name, addresses, token symbol, TVL, treasury). Backend-only — mainnets (1, 56).",
      inputSchema: {
        chainIds: z
          .array(z.number().int().positive())
          .min(1)
          .default([1, 56])
          .describe("Chains to aggregate over (backend supports 1 = Ethereum, 56 = BSC)"),
        period: z.string().default("24 hours").describe("Change-percent window, e.g. '24 hours' (the value app.dexe.io uses)"),
        maxDots: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .default(30)
          .describe("Cap on TVL time-series points (evenly downsampled; 0 = omit the series)"),
        topDaos: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(10)
          .describe("Include the top-N DAOs by TVL (merged across chainIds; 0 = skip)"),
      },
      outputSchema: {
        chainIds: z.array(z.number()),
        period: z.string(),
        summary: z.record(z.unknown()),
        tvlDots: z.array(z.record(z.unknown())),
        tvlDotsTotal: z.number(),
        top: z.array(z.record(z.unknown())),
      },
    },
    async ({ chainIds = [1, 56], period = "24 hours", maxDots = 30, topDaos = 10 }) => {
      try {
        const json = await backendGetJson<{
          data?: { attributes?: Record<string, unknown> };
        }>(
          `/integrations/tracker/pools/gov/summary-stats/${encodeURIComponent(period)}?filter[chain_ids]=${chainIds.join(",")}`,
        );
        const attrs = json.data?.attributes ?? {};
        const allDots = (attrs.tvl_dots as Array<Record<string, unknown>> | undefined) ?? [];
        const { tvl_dots: _omit, ...summary } = attrs;

        let top: Array<Record<string, unknown>> = [];
        // A chain the tracker doesn't index shouldn't sink the whole call — but
        // swallowing the reason makes a failed leaderboard fetch look like "this
        // chain has no DAOs", which an agent will report as fact. Name the
        // chains that failed instead.
        const topErrors: string[] = [];
        if (topDaos > 0) {
          const perChain = await Promise.all(
            chainIds.map(async (cid) => {
              try {
                const t = await backendGetJson<{ data?: Array<{ attributes?: Record<string, unknown> }> }>(
                  `/integrations/tracker/${cid}/pools/gov/top`,
                );
                return (t.data ?? []).map((d) => d.attributes ?? {});
              } catch (e) {
                topErrors.push(`chain ${cid}: ${safeErrorMessage(e)}`);
                return [];
              }
            }),
          );
          top = perChain
            .flat()
            .sort((a, b) => Number(b.tvl_usd ?? 0) - Number(a.tvl_usd ?? 0))
            .slice(0, topDaos)
            .map((d) => ({
              chainId: d.chain_id,
              govPool: d.gov_pool_address,
              name: d.gov_pool_name,
              tokenSymbol: d.gov_token_symbol,
              tvlUsd: d.tvl_usd,
              treasuryUsd: d.treasury_assets_usd,
              membersCount: d.total_members_count,
              proposalsCount: d.total_proposals_count,
            }));
        }

        const structured = {
          chainIds,
          period,
          summary,
          tvlDots: maxDots > 0 ? downsample(allDots, maxDots) : [],
          tvlDotsTotal: allDots.length,
          top,
        };
        // `t.name` is the DAO's own name — the leaderboard is exactly the list a
        // hostile DAO wants to appear in, so it is escaped and capped before it
        // is printed, and the whole payload is announced as third-party.
        const text =
          `Protocol stats (chains ${chainIds.join(",")}, period '${renderUntrusted(period, 40)}')\n` +
          `  TVL: $${summary.tvl_usd ?? "?"} (${summary.tvl_changes_percent ?? "?"}% / ${renderUntrusted(period, 40)}) across ${summary.total_pools_count ?? "?"} DAOs\n` +
          `  proposals: ${summary.total_proposals_count ?? "?"} total (${summary.proposals_changes_percent ?? "?"}%), voting-locked: $${summary.voting_locked_tokens ?? "?"}\n` +
          (top.length
            ? `  top by TVL: ${top
                .slice(0, 5)
                .map((t) => `${renderUntrusted(t.name ?? "?", 60)} ($${String(t.tvlUsd).split(".")[0]})`)
                .join(", ")}${top.length > 5 ? ` … +${top.length - 5}` : ""}`
            : "") +
          (topErrors.length
            ? `\n  ⚠️ the top-DAO leaderboard is INCOMPLETE — ${topErrors.length} of ${chainIds.length} chain(s) failed: ` +
              `${topErrors.join("; ")}. Do not read the list above as the full set; re-run to retry.`
            : "");
        return untrustedResult({
          summary: text,
          label: "DAO names + tracker figures (DAO-authored)",
          structured,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_protocol_stats").message);
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
        pageSize: z
          .number()
          .int()
          .positive()
          .max(BACKEND_MAX_PAGE_SIZE)
          .default(BACKEND_MAX_PAGE_SIZE)
          .describe(
            "Rows per page. The DeXe backend hard-caps this at 100 — a larger value is rejected with HTTP 400. Ignored on continuation pages: the token fixes the page size chosen on the first call.",
          ),
        pageToken: z
          .string()
          .max(8192)
          .optional()
          .describe(
            "Continue a previous page: pass the prior result's `nextPageToken` verbatim. A token is bound to the exact holder + chainId + pageSize it was minted for — re-run without it to restart at page 1.",
          ),
      },
      outputSchema: {
        holder: z.string(),
        chainId: z.number(),
        count: z.number(),
        nextPageToken: z.string(),
        truncated: z.boolean().optional(),
        nfts: z.array(z.record(z.unknown())),
      },
    },
    async ({
      holder,
      chainId: chainIdArg,
      tokens = [],
      pageSize = BACKEND_MAX_PAGE_SIZE,
      pageToken,
    }) => {
      if (!isAddress(holder)) return errorResult(`Invalid holder: ${holder}`);
      for (const t of tokens) if (!isAddress(t)) return errorResult(`Invalid token: ${t}`);
      const chainId = backendChainOf(rpc, chainIdArg);
      if (!BACKEND_INDEXED_CHAINS.has(chainId)) {
        return errorResult(backendChainRefusal(chainId, "dexe_read_nfts"));
      }
      try {
        const qs = new URLSearchParams({ format: "decimal", page_size: String(pageSize) });
        if (tokens.length) qs.set("token_addresses", tokens.join(","));
        if (pageToken) qs.set("page_token", pageToken);
        const json = await backendGetJson<{
          next_page_token?: string;
          nft_data?: Array<Record<string, unknown>>;
        }>(`/integrations/api-proxy-cache/${chainId}/nfts-by-wallet/${holder}?${qs.toString()}`);
        const nfts = json.nft_data ?? [];
        const nextPageToken = json.next_page_token ?? "";
        const structured = {
          holder,
          chainId,
          count: nfts.length,
          nextPageToken,
          truncated: nextPageToken !== "",
          nfts,
        };
        // NFT rows carry whole attacker-written metadata blobs (name, symbol,
        // token_uri, and any indexer-flattened attributes) — anyone can airdrop
        // an NFT to any address, so this list is unsolicited third-party text.
        // Warning FIRST: the rows below are up to 20 lines of attacker-written
        // NFT metadata, and a note appended after them is the thing most likely
        // to be lost or host-truncated.
        const more = structured.truncated
          ? `\n⚠ MORE NFTs EXIST — this is one page, not the full list. Call dexe_read_nfts again with the ` +
            `same holder and chainId plus the \`pageToken\` from this result's nextPageToken. Do NOT report ` +
            `this page as the complete NFT list.`
          : "";
        const text =
          `NFTs for ${holder} (chain ${chainId}): ${nfts.length} on this page${more}\n` +
          nfts
            .slice(0, 20)
            .map((n) => {
              const name = (n.name ?? n.symbol ?? "?") as string;
              return `  ${renderUntrusted(String(name), 60)}  #${renderUntrusted(n.token_id ?? "?", 40)} (${renderUntrusted(n.token_address ?? "?", 42)})`;
            })
            .join("\n") +
          (nfts.length > 20 ? `\n  … +${nfts.length - 20} more on this page not shown above` : "");
        return untrustedResult({
          summary: text,
          label: "NFT metadata (any address can airdrop an NFT)",
          structured,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_nfts").message);
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
        "Reads `validatorsCount()` and optionally checks `isValidator(candidate)` on the DAO's GovValidators contract. " +
        "Also returns the validators' monthly credit lines (GovPool.getCreditInfo) — an internal monthly_withdraw " +
        "against an unfunded/insufficient line reverts.",
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
        creditInfo: z
          .array(
            z.object({
              token: z.string(),
              monthLimit: z.string(),
              currentWithdrawLimit: z.string(),
              // 18-decimal-normalized: GovPoolCredit.sendFunds goes through
              // TokenBalance.from18 on payout, so the stored limits are ALWAYS
              // 18-dec whatever the credit token's own decimals are.
              monthLimitFormatted: z.string().optional(),
              currentWithdrawLimitFormatted: z.string().optional(),
            }),
          )
          .nullable()
          .describe("Validators' monthly credit lines (null when unreadable — older pools lack getCreditInfo)"),
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
        const creditIface = new Interface([
          "function getCreditInfo() view returns (tuple(address token, uint256 monthLimit, uint256 currentWithdrawLimit)[])",
        ]);
        const [helpersR] = await multicall(provider, [
          { target: govPool, iface: gp, method: "getHelperContracts", args: [] },
        ]);
        if (!helpersR?.success) return errorResult("getHelperContracts reverted");
        const validators = (helpersR.value as unknown as { validators: string }).validators;

        const calls: Call[] = [
          { target: validators, iface: v, method: "validatorsCount", args: [] },
          { target: govPool, iface: creditIface, method: "getCreditInfo", args: [], allowFailure: true },
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
        let creditInfo: Array<{
          token: string;
          monthLimit: string;
          currentWithdrawLimit: string;
          monthLimitFormatted?: string;
          currentWithdrawLimitFormatted?: string;
        }> | null = null;
        if (res[1]?.success) {
          const rows = res[1]!.value as unknown as Array<{ token: string; monthLimit: bigint; currentWithdrawLimit: bigint }>;
          creditInfo = rows.map((r) =>
            withFormatted(
              {
                token: r.token,
                monthLimit: r.monthLimit.toString(),
                currentWithdrawLimit: r.currentWithdrawLimit.toString(),
              },
              ["monthLimit", "currentWithdrawLimit"],
              GOV_POWER_DECIMALS,
            ),
          );
        }
        const isVal = candidate ? Boolean(res[2]?.value) : null;
        const structured = {
          govPool,
          validators,
          count,
          candidate: candidate ?? null,
          isValidator: isVal,
          creditInfo,
        };
        const text =
          `Validators contract ${validators}\n  count: ${count}` +
          (candidate ? `\n  ${candidate} isValidator: ${isVal}` : "") +
          (creditInfo
            ? creditInfo.length
              ? `\n  credit lines: ${creditInfo.map((c) => `${c.token} month=${c.monthLimitFormatted ?? c.monthLimit} available=${c.currentWithdrawLimitFormatted ?? c.currentWithdrawLimit} (18-dec normalized; raw ${c.monthLimit}/${c.currentWithdrawLimit})`).join("; ")}`
              : `\n  credit lines: none funded (internal monthly_withdraw would revert — fund via validators_allocation)`
            : "");
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_read_validators").message,
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
  // The two numbers "low creating power" is actually about. They are 18-decimal
  // -normalized voting power (GovUserKeeper.to18), never the gov token's own
  // decimals, so no token lookup is needed or wanted here.
  for (const f of ["minVotesForVoting", "minVotesForCreating"] as const) {
    const v = o[f];
    if (typeof v === "bigint" || (typeof v === "string" && /^\d+$/.test(v))) {
      try {
        o[`${f}Formatted`] = formatUnitsWithSymbol(
          typeof v === "bigint" ? v : BigInt(v),
          GOV_POWER_DECIMALS,
        );
      } catch {
        /* not a number - skip the derived field */
      }
    }
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
        // `executorDescription` is a DAO-authored string inside each settings
        // struct, and the whole struct is pretty-printed into the reply — so the
        // printed block is fenced rather than pasted.
        return untrustedResult({
          summary: `Settings for ${govPool}\n  contract: ${settings}`,
          label: `proposal settings for ${govPool} (executorDescription is DAO-authored)`,
          body: {
            default: structured.defaultSettings,
            internal: structured.internalSettings,
          },
          structured,
          maxBodyChars: 6000,
        });
      } catch (err) {
        return errorResult(
          toActionableError(err, "dexe_read_settings").message,
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
          toActionableError(err, "dexe_read_expert_status").message,
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
        // `totalTiers` is latestTierId() — the exact count this call pages over.
        const meta = pageMeta({
          offset,
          limit,
          returned: Array.isArray(tiers) ? tiers.length : 0,
          total: totalTiers,
        });
        const structured = { tokenSaleProposal, totalTiers, ...meta, tiers };
        // TierMetadata.name / .description and TierInfo.uri are free text written
        // by whoever opened the sale.
        return untrustedResult({
          summary:
            `TokenSale ${tokenSaleProposal}: ${totalTiers} tier(s), showing offset=${offset} limit=${limit}` +
            truncationNote(meta, "dexe_read_token_sale_tiers", "tier"),
          label: "tier metadata (sale-opener-authored)",
          structured,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_token_sale_tiers").message);
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
        return errorResult(toActionableError(err, "dexe_read_token_sale_user").message);
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
        // DistributionProposal stores `rewardAmount` 18-decimal-normalized and
        // applies from18Safe only at safeTransferFrom, so getPotentialReward
        // returns an 18-dec figure — rendering it against a USDT reward token's
        // 6 decimals would overstate it by 1e12.
        const distributions = proposalIds.map((pid, i) =>
          withFormatted(
            {
              proposalId: pid,
              isClaimed: res[i * 2]?.success ? Boolean(res[i * 2]!.value) : null,
              potentialReward: res[i * 2 + 1]?.success
                ? (res[i * 2 + 1]!.value as bigint).toString()
                : null,
            },
            ["potentialReward"],
            GOV_POWER_DECIMALS,
          ),
        );
        const structured = {
          distributionProposal,
          voter,
          powerDecimals: GOV_POWER_DECIMALS,
          distributions,
        };
        const text = distributions
          .map(
            (d) =>
              `  proposal ${d.proposalId}: claimed=${d.isClaimed}, reward=${(d as { potentialRewardFormatted?: string }).potentialRewardFormatted ?? d.potentialReward ?? "?"} (raw ${d.potentialReward ?? "?"})`,
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Distribution status for ${voter}:\n${text}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_distribution_status").message);
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
        // Each active staking carries a free-text `metadata` string set by the
        // DAO that created the tier.
        return untrustedResult({
          summary: text,
          label: "staking tier metadata (DAO-authored)",
          structured,
        });
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_staking_info").message);
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
        return errorResult(toActionableError(err, "dexe_read_privacy_policy_status").message);
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
