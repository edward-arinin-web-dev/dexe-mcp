import { AbiCoder, getAddress, Interface, keccak256, formatUnits, type JsonRpcProvider } from "ethers";
import type { DexeConfig } from "../../config.js";
import { RpcProvider } from "../../rpc.js";
import {
  assertAllowlistAndValueCap,
  assertChainCoherence,
  assertNoForbiddenCalldata,
  BroadcastGuardError,
} from "../broadcastGuards.js";
import { simulateCalldata } from "../simulate.js";
import { sanitizeRevertReason } from "../errors.js";
import { bundledAbiSnapshot } from "../abiSnapshot.js";
import { CalldataDecoder, type DecodedCall } from "../decoders.js";
import { SelectorIndex } from "../selectors.js";
import { renderUntrusted } from "../sanitize.js";
import { classifyGovernanceActions } from "../governanceHits.js";
import { CONTRACTS_REGISTRY_BY_CHAIN, CONTRACT_NAMES } from "../addresses.js";

/**
 * ── What the human is shown before typing the password ─────────────────────
 *
 * Everything on the approval page is derived HERE, by the server, from the
 * bytes that will be signed — never from text the model wrote. The model's
 * own description of a step (`payload.description`, which can carry a
 * proposal title or anything a prompt injection put there) is shown only as a
 * clearly labelled, escaped, truncated "builder note".
 *
 *   - decode: the bundled DeXe ABI snapshot (no compile step), including the
 *     calls nested inside multicall(bytes[]) and the actions of a proposal
 *   - labels: from the chain — the ContractsRegistry, GovPool helper
 *     contracts, ERC20 symbol (escaped: a symbol is token-deployer text),
 *     "no contract code" for EOAs
 *   - risk flags: unlimited approvals, native value, unlabelled spenders,
 *     governance-changing proposal actions, undecodable calldata, mainnet
 *   - prechecks: B6/B7/B11/B12 on every step, B9 (eth_call) on step 1 only —
 *     later steps depend on earlier ones and are checked at send time
 */

export type RiskLevel = "danger" | "warn" | "info";
export interface RiskFlag {
  level: RiskLevel;
  text: string;
}

export interface DecodedView {
  signature: string;
  contract: string | null;
  args: Array<{ name: string; value: string }>;
  nested: DecodedView[];
}

export interface ReviewStep {
  index: number;
  to: string;
  toLabel: string;
  /** Wei, decimal string. */
  value: string;
  valueHuman: string;
  selector: string | null;
  dataBytes: number;
  dataHash: string;
  /** First bytes of the calldata, for a reader who wants to check the raw hex. */
  dataPreview: string;
  decoded: DecodedView | null;
  /** The builder's own description of the step — caller text, escaped and truncated, never authoritative. */
  builderNote?: string;
  risks: RiskFlag[];
}

export interface Prechecks {
  /** B6/B7/B11/B12 on every step. */
  guards: "pass";
  /** B9 on step 1. */
  simulation: "pass" | "skipped" | "unavailable";
  simulationNote?: string;
}

export type ReviewResult =
  | { ok: true; steps: ReviewStep[]; prechecks: Prechecks }
  | { ok: false; guard: string; stepIndex: number; reason: string };

export interface ReviewPayload {
  to: string;
  data: string;
  value: string;
  description?: string;
}

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Smart Chain",
  97: "BSC Testnet",
  137: "Polygon",
  8453: "Base",
  11155111: "Sepolia",
};
const NATIVE: Record<number, string> = { 56: "BNB", 97: "tBNB", 1: "ETH", 11155111: "SepoliaETH" };

export function chainLabel(chainId: number): string {
  return `${CHAIN_NAMES[chainId] ?? "chain"} (${chainId})`;
}
export function isMainnet(chainId: number): boolean {
  return chainId === 56 || chainId === 1 || chainId === 10 || chainId === 137 || chainId === 8453;
}

/**
 * keccak(chainId, from, ordered (to, value, keccak(data))). What an approval is
 * bound to: a different order, recipient, amount or byte is a different batch.
 */
export function computeBatchHash(
  chainId: number,
  from: string,
  steps: ReadonlyArray<{ to: string; value: string; data: string }>,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(
    coder.encode(
      ["uint256", "address", "tuple(address to, uint256 value, bytes32 dataHash)[]"],
      [
        BigInt(chainId),
        getAddress(from),
        steps.map((s) => [getAddress(s.to), BigInt(s.value || "0"), keccak256(s.data || "0x")]),
      ],
    ),
  );
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Six base32 characters of the batch hash as `XXX-XXX` — easy to compare by eye between chat and page. */
export function fingerprintOf(batchHash: string): string {
  const n = BigInt(batchHash.slice(0, 2 + 8)); // first 32 bits
  let out = "";
  for (let i = 0; i < 6; i++) out += CROCKFORD[Number((n >> BigInt(27 - i * 5)) & 31n)];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

let snapshotDecoder: CalldataDecoder | undefined;
function decoder(): CalldataDecoder {
  if (!snapshotDecoder) {
    const snap = bundledAbiSnapshot();
    snapshotDecoder = new CalldataDecoder(snap, new SelectorIndex(snap), { sourceKind: "snapshot" });
  }
  return snapshotDecoder;
}

const ERC20 = new Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const GOV_POOL = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function createProposalAndVote(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst, uint256 voteAmount, uint256[] voteNftIds)",
  "function createProposal(string _descriptionURL, tuple(address executor, uint256 value, bytes data)[] actionsOnFor, tuple(address executor, uint256 value, bytes data)[] actionsOnAgainst)",
  "function multicall(bytes[] data) returns (bytes[])",
]);
const APPROVE_SEL = ERC20.getFunction("approve")!.selector;
const TRANSFER_SEL = ERC20.getFunction("transfer")!.selector;
const REGISTRY = new Interface(["function getContract(string name) view returns (address)"]);
const POOL_REGISTRY = new Interface(["function isGovPool(address govPool) view returns (bool)"]);
const USER_KEEPER = new Interface([
  "function tokenAddress() view returns (address)",
  "function stakingProposalAddress() view returns (address)",
]);
const CREATE_SELS = new Set([
  GOV_POOL.getFunction("createProposalAndVote")!.selector,
  GOV_POOL.getFunction("createProposal")!.selector,
]);
const MULTICALL_SEL = GOV_POOL.getFunction("multicall")!.selector;
const UNLIMITED = 2n ** 255n;

/** Contracts whose functions only make sense on a registry-confirmed DeXe deployment. */
const PROTOCOL_CONTRACTS: ReadonlySet<string> = new Set([
  "GovPool",
  "GovUserKeeper",
  "GovSettings",
  "GovValidators",
  "GovValidatorsToken",
  "TokenSaleProposal",
  "DistributionProposal",
  "StakingProposal",
  "PoolFactory",
  "PoolRegistry",
  "ContractsRegistry",
  "UserRegistry",
  "CoreProperties",
  "PriceFeed",
  "TokenAllocator",
  "LinearPower",
  "PolynomialPower",
  "ERC721Multiplier",
  "DexeERC721Multiplier",
  "ERC721Expert",
]);

const SATELLITE = new Interface([
  "function govAddress() view returns (address)",
  "function govPoolAddress() view returns (address)",
]);

/** Calls that hand tokens, allowance, operator rights or votes to someone. */
const HANDOVER = new Interface([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function setApprovalForAll(address operator, bool approved)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function delegate(address delegatee, uint256 amount, uint256[] nftIds)",
]);

interface Handover {
  kind: "spender" | "operator" | "recipient" | "delegatee" | "revoke";
  party: string;
  unlimited: boolean;
  amount?: string;
}

/** Who a token-handover call gives something to, or null when `data` is not one. */
export function decodeHandover(data: string): Handover | null {
  if (!data || data.length < 10) return null;
  let parsed;
  try {
    parsed = HANDOVER.parseTransaction({ data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case "approve":
    case "increaseAllowance":
      return { kind: "spender", party: String(a[0]), unlimited: BigInt(a[1]) >= UNLIMITED };
    case "permit":
      return { kind: "spender", party: String(a[1]), unlimited: BigInt(a[2]) >= UNLIMITED };
    case "setApprovalForAll":
      return a[1] ? { kind: "operator", party: String(a[0]), unlimited: true } : { kind: "revoke", party: String(a[0]), unlimited: false };
    case "transfer":
      return { kind: "recipient", party: String(a[0]), unlimited: false };
    case "transferFrom":
    case "safeTransferFrom":
      return { kind: "recipient", party: String(a[1]), unlimited: false };
    case "delegate":
      return { kind: "delegatee", party: String(a[0]), unlimited: false, amount: `${BigInt(a[1]).toString()} (raw units)` };
    default:
      return null;
  }
}

/** Proposal actions (for + against) of a create call, including creates nested in a GovPool multicall. */
function proposalActionsOf(data: string): Array<{ executor: string; value: string; data: string }> {
  const out: Array<{ executor: string; value: string; data: string }> = [];
  const collect = (d: string) => {
    const sel = d.slice(0, 10).toLowerCase();
    if (!CREATE_SELS.has(sel)) return;
    try {
      const args = GOV_POOL.decodeFunctionData(GOV_POOL.getFunction(sel)!, d);
      for (const x of [...(args[1] as unknown as unknown[][]), ...(args[2] as unknown as unknown[][])]) {
        out.push({ executor: String(x[0]), value: String(x[1]), data: String(x[2]) });
      }
    } catch {
      /* malformed */
    }
  };
  collect(data);
  if (data.slice(0, 10).toLowerCase() === MULTICALL_SEL) {
    try {
      for (const d of GOV_POOL.decodeFunctionData("multicall", data)[0] as unknown as string[]) collect(d);
    } catch {
      /* malformed */
    }
  }
  return out;
}

/** The same decoded call, with every contract-name prefix removed (unvouched target). */
function withoutContractNames(v: DecodedView): DecodedView {
  return { ...v, contract: null, nested: v.nested.map(withoutContractNames) };
}

const MAX_ARG_CHARS = 160;
const MAX_ARGS = 12;

/** Render one decoded argument value as display text. Strings are caller/chain text: escaped by the page, capped here. */
function renderValue(v: unknown, depth = 0): string {
  if (depth > 3) return "…";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (/^0x[0-9a-fA-F]*$/.test(v)) return v.length > 2 + 64 * 2 ? `${v.slice(0, 66)}… (${(v.length - 2) / 2} bytes)` : v;
    return `"${renderUntrusted(v, MAX_ARG_CHARS)}" (text, unverified)`;
  }
  if (Array.isArray(v) || (v && typeof v === "object" && typeof (v as { length?: unknown }).length === "number")) {
    const arr = Array.from(v as ArrayLike<unknown>);
    const shown = arr.slice(0, 6).map((x) => renderValue(x, depth + 1));
    const s = `[${shown.join(", ")}${arr.length > 6 ? `, … ${arr.length - 6} more` : ""}]`;
    return s.length > MAX_ARG_CHARS * 2 ? `${s.slice(0, MAX_ARG_CHARS * 2)}…` : s;
  }
  return renderUntrusted(String(v), MAX_ARG_CHARS);
}

function viewOf(call: DecodedCall, depth = 0): DecodedView {
  const entries = Object.entries(call.args);
  return {
    signature: call.signature,
    contract: call.contract,
    args: entries.slice(0, MAX_ARGS).map(([name, value]) => ({ name, value: renderValue(value) })),
    nested: depth < 2 ? (call.nested ?? []).slice(0, 8).map((n) => viewOf(n, depth + 1)) : [],
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), ms);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReviewContext {
  chainId: number;
  from: string;
  config: DexeConfig;
  /** Simulate step 1 (B9). Composites and dexe_tx_send both do; tests turn it off. */
  simulateFirst: boolean;
  /** Recorded DAOs (state.json): govPool → name. Names are user text and shown escaped. */
  knownDaos?: ReadonlyArray<{ govPool: string; name?: string; chainId: number }>;
  /** Injected for tests; default builds one for `chainId` from the config. */
  provider?: Pick<JsonRpcProvider, "getCode" | "call">;
}

/** The prechecks + review. Never signs, never broadcasts; RPC failures degrade to fewer labels. */
export async function buildReview(payloads: readonly ReviewPayload[], ctx: ReviewContext): Promise<ReviewResult> {
  const cfg = ctx.config;
  // ---- B6/B7/B12 — free, every step, before any RPC --------------------------
  for (const [i, p] of payloads.entries()) {
    try {
      assertAllowlistAndValueCap({ to: p.to, value: p.value || "0" }, cfg);
      assertNoForbiddenCalldata({ to: p.to, data: p.data, value: p.value, chainId: ctx.chainId, from: ctx.from });
    } catch (e) {
      if (e instanceof BroadcastGuardError) return { ok: false, guard: e.guard, stepIndex: i, reason: e.message };
      throw e;
    }
  }

  let provider: Pick<JsonRpcProvider, "getCode" | "call"> | undefined = ctx.provider;
  if (!provider) {
    try {
      provider = new RpcProvider(cfg).requireProvider(ctx.chainId);
    } catch {
      provider = undefined;
    }
  }

  // ---- B11 — every step (getCode; fails open on transport errors) -----------
  const codeCache = new Map<string, string | null>();
  const codeAt = async (addr: string): Promise<string | null> => {
    const k = addr.toLowerCase();
    if (codeCache.has(k)) return codeCache.get(k)!;
    const c = provider ? ((await withTimeout(provider.getCode(addr), 6000)) ?? null) : null;
    codeCache.set(k, c);
    return c;
  };
  for (const [i, p] of payloads.entries()) {
    try {
      await assertChainCoherence({ to: p.to, data: p.data, chainId: ctx.chainId }, async (to) => {
        const c = await codeAt(to);
        if (c === null) throw new Error("unknown");
        return c;
      });
    } catch (e) {
      if (e instanceof BroadcastGuardError) return { ok: false, guard: e.guard, stepIndex: i, reason: e.message };
      throw e;
    }
  }

  // ---- B9 — step 1 only ------------------------------------------------------
  const prechecks: Prechecks = { guards: "pass", simulation: "skipped" };
  if (ctx.simulateFirst && payloads.length > 0) {
    const p = payloads[0]!;
    const simCfg: DexeConfig =
      ctx.chainId === cfg.defaultChainId ? cfg : { ...cfg, defaultChainId: ctx.chainId, chainId: ctx.chainId };
    const sim = await simulateCalldata(new RpcProvider(simCfg), {
      to: p.to,
      data: p.data,
      value: p.value,
      from: ctx.from,
      chainId: ctx.chainId,
    });
    if (!sim.success && !sim.networkError) {
      return {
        ok: false,
        guard: "B9",
        stepIndex: 0,
        reason:
          `Pre-approval simulation (eth_call) of step 1 reverted: ${sanitizeRevertReason(sim.revertReason)}. ` +
          `Nothing was shown for approval and nothing was signed.`,
      };
    }
    prechecks.simulation = sim.success ? "pass" : "unavailable";
    if (!sim.success) prechecks.simulationNote = "the RPC could not run the simulation — it will be retried at send time";
  }
  if (payloads.length > 1) {
    prechecks.simulationNote =
      (prechecks.simulationNote ? `${prechecks.simulationNote}; ` : "") +
      "steps after the first depend on earlier ones and are checked at send time";
  }

  // ---- labels ----------------------------------------------------------------
  // Every label comes from the chain, and a contract's own answers are trusted
  // only after the DeXe registry vouches for it: a fake "GovPool" can return
  // any address as its UserKeeper, so helper labels are applied only to pools
  // PoolRegistry.isGovPool() confirms on this chain.
  const labels = new Map<string, string>();
  const label = (addr: string, text: string) => {
    const k = addr.toLowerCase();
    if (!labels.has(k)) labels.set(k, text);
  };
  /** Addresses the registry vouches for: singletons, confirmed pools, their helpers. */
  const confirmed = new Set<string>();
  /** Satellites (TokenSale/Distribution/Staking) whose link to a confirmed pool is their own claim. */
  const satellites = new Map<string, string>();
  /** step target (lowercase) → why it is NOT trustworthy, when it claims to be a GovPool. */
  const fakePools = new Map<string, string>();
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const daoName = (pool: string) =>
    ctx.knownDaos?.find((d) => d.chainId === ctx.chainId && d.govPool.toLowerCase() === pool.toLowerCase())?.name;
  const rawCall = async (to: string, data: string): Promise<string | undefined> => {
    if (!provider) return undefined;
    const r = await withTimeout(provider.call({ to, data }), 6000);
    return r && r !== "0x" ? r : undefined;
  };
  const readAddress = async (iface: Interface, to: string, fn: string): Promise<string | undefined> => {
    const r = await rawCall(to, iface.encodeFunctionData(fn));
    if (!r) return undefined;
    try {
      const a = String(iface.decodeFunctionResult(fn, r)[0]);
      return /^0x0{40}$/i.test(a) ? undefined : a;
    } catch {
      return undefined;
    }
  };

  // Every address the batch hands control to: step targets, multicall inner
  // targets (the step target itself), proposal-action executors.
  const allActions = payloads.flatMap((pl) => proposalActionsOf(pl.data || "0x"));
  const candidates = [...new Set([...payloads.map((pl) => pl.to), ...allActions.map((a) => a.executor)].map((a) => a.toLowerCase()))];

  const registry =
    cfg.chains?.get?.(ctx.chainId)?.registryOverride ?? cfg.registryOverride ?? CONTRACTS_REGISTRY_BY_CHAIN[ctx.chainId];
  const builtInRegistry = CONTRACTS_REGISTRY_BY_CHAIN[ctx.chainId];
  const registryNote =
    registry && builtInRegistry && registry.toLowerCase() !== builtInRegistry.toLowerCase()
      ? `this server uses a custom DeXe ContractsRegistry (${registry}, DEXE_CONTRACTS_REGISTRY) instead of the built-in ` +
        `one for ${chainLabel(ctx.chainId)} — every "registered" label on this page is relative to it`
      : null;

  if (provider) {
    const named: Record<string, string> = {};
    if (registry) {
      label(registry, "DeXe ContractsRegistry");
      confirmed.add(registry.toLowerCase());
      for (const name of [CONTRACT_NAMES.POOL_FACTORY, CONTRACT_NAMES.POOL_REGISTRY, CONTRACT_NAMES.USER_REGISTRY]) {
        const ret = await rawCall(registry, REGISTRY.encodeFunctionData("getContract", [name]));
        if (!ret) continue;
        try {
          const addr = String(REGISTRY.decodeFunctionResult("getContract", ret)[0]);
          if (addr && !/^0x0{40}$/i.test(addr)) {
            named[name] = addr;
            confirmed.add(addr.toLowerCase());
            label(addr, `DeXe ${name.replace(/_/g, " ").toLowerCase()} (registry)`);
          }
        } catch {
          /* unreadable entry — fewer labels */
        }
      }
    }
    const poolRegistry = named[CONTRACT_NAMES.POOL_REGISTRY];
    const isGovPool = async (addr: string): Promise<boolean | null> => {
      if (!poolRegistry) return null;
      const r = await rawCall(poolRegistry, POOL_REGISTRY.encodeFunctionData("isGovPool", [addr]));
      try {
        return r ? Boolean(POOL_REGISTRY.decodeFunctionResult("isGovPool", r)[0]) : null;
      } catch {
        return null;
      }
    };
    const confirmPool = async (pool: string): Promise<string> => {
      const name = daoName(pool);
      const title = `GovPool ${short(getAddress(pool))}${name ? ` (recorded as "${renderUntrusted(name, 60)}")` : ""}`;
      if (confirmed.has(pool.toLowerCase())) return title;
      confirmed.add(pool.toLowerCase());
      label(pool, `${title} — registered DeXe DAO`);
      const ret = await rawCall(pool, GOV_POOL.encodeFunctionData("getHelperContracts"));
      if (ret) {
        try {
          const [settings, userKeeper, validators, , votePower] = GOV_POOL.decodeFunctionResult("getHelperContracts", ret) as unknown as string[];
          for (const [a, what] of [
            [userKeeper, "UserKeeper"],
            [settings, "GovSettings"],
            [validators, "GovValidators"],
            [votePower, "vote-power contract"],
          ] as const) {
            if (!a || /^0x0{40}$/i.test(a)) continue;
            confirmed.add(a.toLowerCase());
            label(a, `${what} of ${title}`);
          }
          const tokenAddr = await readAddress(USER_KEEPER, userKeeper!, "tokenAddress");
          if (tokenAddr) label(tokenAddr, `governance token of ${title}`);
          const staking = await readAddress(USER_KEEPER, userKeeper!, "stakingProposalAddress");
          if (staking) {
            confirmed.add(staking.toLowerCase());
            label(staking, `StakingProposal of ${title}`);
          }
        } catch {
          /* helpers unreadable — the pool itself stays confirmed */
        }
      }
      return title;
    };

    for (const t of candidates) {
      if (confirmed.has(t)) continue;
      // Does it claim to be a GovPool?
      const ret = await rawCall(t, GOV_POOL.encodeFunctionData("getHelperContracts"));
      let looksLikePool = false;
      if (ret) {
        try {
          GOV_POOL.decodeFunctionResult("getHelperContracts", ret);
          looksLikePool = true;
        } catch {
          looksLikePool = false;
        }
      }
      if (looksLikePool) {
        const registered = await isGovPool(t);
        if (registered === true) {
          await confirmPool(t);
        } else {
          fakePools.set(
            t,
            registered === false
              ? "this contract answers like a GovPool but is NOT a registered DeXe DAO (PoolRegistry.isGovPool = false) — " +
                  "whatever helper addresses it reports are its own claims"
              : "this contract answers like a GovPool but the DeXe PoolRegistry could not confirm it on this chain — " +
                  "its helper addresses are unverified",
          );
        }
        continue;
      }
      // A satellite (TokenSale / Distribution / Staking proposal) names its pool itself.
      const claimed = (await readAddress(SATELLITE, t, "govAddress")) ?? (await readAddress(SATELLITE, t, "govPoolAddress"));
      if (claimed && (await isGovPool(claimed)) === true) {
        const title = await confirmPool(claimed);
        if (!confirmed.has(t)) {
          satellites.set(t, title);
          label(t, `contract that says it belongs to ${title} (its own claim)`);
        }
      }
    }
  }

  /** Is `addr` vouched for by the registry (or a satellite of a confirmed pool)? */
  const trust = (addr: string): "confirmed" | "satellite" | "none" =>
    confirmed.has(addr.toLowerCase()) ? "confirmed" : satellites.has(addr.toLowerCase()) ? "satellite" : "none";

  /** The spender / recipient checks, for any call that hands tokens or allowance to someone. */
  const handoverRisks = async (data: string, where: string): Promise<RiskFlag[]> => {
    const h = decodeHandover(data);
    if (!h) return [];
    const out: RiskFlag[] = [];
    if (h.kind === "revoke") return [{ level: "info", text: `${where}revokes ${h.party}'s approval for all tokens` }];
    if (h.unlimited) out.push({ level: "danger", text: `${where}UNLIMITED ${h.kind === "operator" ? "approval for ALL tokens of the collection" : "token allowance"}` });
    if (h.kind === "delegatee") {
      out.push({ level: "info", text: `${where}delegates ${h.amount ?? "votes"} to ${h.party} — that address votes with them until you undelegate` });
      return out;
    }
    const partyCode = await codeAt(h.party);
    const noCode = partyCode !== null && /^0x0*$/i.test(partyCode);
    const known = labels.get(h.party.toLowerCase());
    const role = h.kind === "recipient" ? "recipient" : h.kind === "operator" ? "operator" : "approval spender";
    if (noCode) {
      out.push({
        level: "danger",
        text:
          h.kind === "recipient"
            ? `${where}the tokens go to ${h.party}, an address with NO contract code (a plain wallet) — make sure that is the intended recipient`
            : `${where}the ${role} is ${h.party}, an address with NO contract code (a plain wallet) — DeXe never asks you to approve one`,
      });
    } else if (known) {
      out.push({ level: "info", text: `${where}${role}: ${known}` });
    } else {
      out.push({ level: "warn", text: `${where}${role} ${h.party} is not a contract the DeXe registry vouches for` });
    }
    return out;
  };

  /** A DeXe protocol function sent to something the registry does not vouch for. */
  const protocolRisk = (call: DecodedView | null, target: string, where: string): RiskFlag | null => {
    if (!call?.contract || !PROTOCOL_CONTRACTS.has(call.contract)) return null;
    const t = trust(target);
    if (t === "confirmed") return null;
    if (t === "satellite") {
      return {
        level: "warn",
        text: `${where}${target} says it belongs to ${satellites.get(target.toLowerCase())}; that link is its own claim (DeXe has no on-chain pointer to verify it)`,
      };
    }
    return {
      level: "danger",
      text: `${where}this calls a DeXe protocol function (${call.signature.split("(")[0]}) on ${target}, which is NOT a registered DeXe contract`,
    };
  };

  const steps: ReviewStep[] = [];
  for (const [i, p] of payloads.entries()) {
    const to = getAddress(p.to);
    const risks: RiskFlag[] = [];
    const value = BigInt(p.value || "0");
    const data = p.data || "0x";
    const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;

    if (i === 0 && registryNote) risks.push({ level: "warn", text: registryNote });

    // Target label.
    let toLabel = labels.get(to.toLowerCase());
    const code = await codeAt(to);
    const fake = fakePools.get(to.toLowerCase());
    if (fake) {
      toLabel = "contract claiming to be a GovPool — NOT a registered DeXe DAO";
      risks.push({ level: "danger", text: fake });
    }
    if (!toLabel) {
      if (code !== null && /^0x0*$/i.test(code)) toLabel = "externally owned account (no contract code)";
      else if (decodeHandover(data) && provider) {
        const sym = await withTimeout(provider.call({ to, data: ERC20.encodeFunctionData("symbol") }), 6000);
        let symText: string | undefined;
        try {
          if (sym && sym !== "0x") symText = String(ERC20.decodeFunctionResult("symbol", sym)[0]);
        } catch {
          symText = undefined;
        }
        // Self-reported: a token can call itself anything.
        toLabel = symText ? `token reporting symbol "${renderUntrusted(symText, 24)}" (self-reported, unverified)` : "unlabelled token contract";
      } else toLabel = code === null ? "unlabelled address (code not checked)" : "unlabelled contract";
    }

    // Decode. A protocol-looking call on an unvouched target loses the
    // contract name: the bytes only say `deposit(...)`, not that it is a GovPool.
    let decoded: DecodedView | null = null;
    try {
      const r = decoder().decodeCalldata(data);
      if (r.primary) decoded = viewOf(r.primary);
    } catch {
      decoded = null;
    }
    if (!decoded && data !== "0x") {
      risks.push({ level: "warn", text: "calldata could not be decoded with the bundled DeXe ABIs — check the raw bytes" });
    }
    const pr = protocolRisk(decoded, to, "");
    if (pr) {
      if (!fake) risks.push(pr);
      if (pr.level === "danger" && decoded) decoded = withoutContractNames(decoded);
    }

    if (value > 0n) {
      risks.push({
        level: "warn",
        text: `sends ${formatUnits(value, 18)} ${NATIVE[ctx.chainId] ?? "native coin"} with the call`,
      });
    }

    // Who gets tokens / allowance / votes — top level, then inside a multicall.
    risks.push(...(await handoverRisks(data, "")));
    if (selector === MULTICALL_SEL) {
      try {
        const inner = GOV_POOL.decodeFunctionData("multicall", data)[0] as unknown as string[];
        for (const [k, d] of inner.entries()) risks.push(...(await handoverRisks(d, `inner call ${k + 1}: `)));
      } catch {
        /* malformed — the decode above shows what it can */
      }
    }

    // Proposal actions: governance-changing calls, treasury moves, handovers,
    // protocol calls on unvouched executors.
    const proposalActions = proposalActionsOf(data);
    if (proposalActions.length > 0) {
      const hits = classifyGovernanceActions(proposalActions, { protocolAddresses: [...confirmed] });
      for (const h of hits) {
        risks.push({
          level: "warn",
          text: `proposal action #${h.index + 1} changes governance (${h.kind}) on ${h.executor}`,
        });
      }
      for (const [k, a] of proposalActions.entries()) {
        const where = `proposal action #${k + 1}: `;
        if (BigInt(a.value || "0") > 0n) {
          risks.push({ level: "warn", text: `${where}moves ${formatUnits(BigInt(a.value), 18)} native coin` });
        }
        if (a.data.slice(0, 10).toLowerCase() === TRANSFER_SEL) {
          risks.push({ level: "warn", text: `${where}transfers tokens from the DAO treasury (${a.executor})` });
        }
        risks.push(...(await handoverRisks(a.data, where)));
        let actionCall: DecodedView | null = null;
        try {
          const r = decoder().decodeCalldata(a.data);
          if (r.primary) actionCall = viewOf(r.primary);
        } catch {
          actionCall = null;
        }
        const ar = protocolRisk(actionCall, a.executor, where);
        if (ar) risks.push(ar);
      }
    }

    if (isMainnet(ctx.chainId) && i === 0) {
      risks.push({ level: "warn", text: `${chainLabel(ctx.chainId)} — real funds` });
    }

    steps.push({
      index: i,
      to,
      toLabel,
      value: value.toString(),
      valueHuman: `${formatUnits(value, 18)} ${NATIVE[ctx.chainId] ?? "native"}`,
      selector,
      dataBytes: Math.max(0, (data.length - 2) / 2),
      dataHash: keccak256(data),
      dataPreview: data.length > 2 + 72 ? `${data.slice(0, 2 + 72)}…` : data,
      decoded,
      ...(p.description ? { builderNote: renderUntrusted(p.description, 160) } : {}),
      risks,
    });
  }
  return { ok: true, steps, prechecks };
}
