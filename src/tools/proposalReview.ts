import { z } from "zod";
import { Interface, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { RpcProvider } from "../rpc.js";
import { multicall, type Call } from "../lib/multicall.js";
import { resolveChain } from "../configRead.js";
import { GET_PROPOSALS_FRAGMENT, decodeProposalView } from "../lib/govProposalView.js";
import { proposalStateName } from "../lib/preflight.js";
import { fetchIpfs, stripIpfsPrefix } from "../lib/ipfs.js";
import { resolveGateways } from "./ipfsRead.js";
import { DecodeAbis } from "../lib/decodeAbis.js";
import { fenceUntrusted } from "../lib/sanitize.js";
import { safeErrorMessage } from "../lib/redact.js";
import { PROPOSAL_ID_DESC } from "../lib/params.js";
import {
  buildReview,
  metadataToText,
  ZERO_ADDRESS,
  type ReviewFacts,
  type ReviewLimits,
  type ReviewResult,
  type TokenFacts,
} from "../lib/proposalReview.js";

/**
 * `dexe_proposal_review` — what a proposal will DO, for an agent that has to
 * vote on it. Read-only. The pure half (decoding, flags, text analysis) is
 * ../lib/proposalReview.ts; this file only gathers the facts.
 *
 * `reviewProposal` is exported so the council runner (src/cli/council.ts) calls
 * the same code path without a round trip through MCP.
 */

const GOV_POOL_ABI = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
  "function getNftContracts() view returns (address nftMultiplier, address expertNft, address dexeExpertNft, address babt)",
  GET_PROPOSALS_FRAGMENT,
]);
const USER_KEEPER_ABI = new Interface(["function tokenAddress() view returns (address)"]);
const ERC20_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export interface ReviewInput {
  govPool: string;
  proposalId: number;
  chainId?: number;
  addressBook?: Record<string, string>;
  limits?: ReviewLimits;
}

/** Facts only; throws on a bad pool / missing proposal with a server-authored message. */
export async function gatherReviewFacts(ctx: ToolContext, input: ReviewInput, rpc = new RpcProvider(ctx.config)): Promise<ReviewFacts> {
  if (!isAddress(input.govPool)) throw new Error(`Invalid govPool: ${input.govPool}`);
  if (!Number.isInteger(input.proposalId) || input.proposalId < 1) throw new Error(`Invalid proposalId: ${input.proposalId} (1-indexed)`);
  const govPool = getAddress(input.govPool);
  const chain = resolveChain(ctx.config, input.chainId);
  const pr = rpc.tryProvider(chain.chainId);
  if ("error" in pr) throw new Error(`${pr.error}\n${pr.remediation}`);
  const provider = pr.ok;

  const resA = await multicall(provider, [
    { target: govPool, iface: GOV_POOL_ABI, method: "getHelperContracts", args: [] },
    { target: govPool, iface: GOV_POOL_ABI, method: "getProposals", args: [input.proposalId - 1, 1], allowFailure: true },
    { target: govPool, iface: GOV_POOL_ABI, method: "getNftContracts", args: [], allowFailure: true },
  ]);
  if (!resA[0]?.success) throw new Error("getHelperContracts reverted — is this a GovPool?");
  const views = resA[1]?.success ? (resA[1]!.value as unknown[]) : null;
  if (!views || views.length === 0) throw new Error(`Proposal ${input.proposalId} not found at ${govPool}`);
  const view = decodeProposalView(views[0]);
  if (!view) throw new Error("Failed to decode the proposal view");

  const h = resA[0]!.value as unknown as Record<string, string>;
  const daoContracts: Record<string, string> = { [govPool.toLowerCase()]: "govPool" };
  const addRole = (addr: unknown, role: string) => {
    if (typeof addr === "string" && isAddress(addr) && addr !== ZERO_ADDRESS) daoContracts[addr.toLowerCase()] ??= role;
  };
  for (const k of ["settings", "userKeeper", "validators", "poolRegistry", "votePower"]) addRole(h[k], k);
  if (resA[2]?.success) {
    const n = resA[2]!.value as unknown as Record<string, string>;
    for (const k of ["nftMultiplier", "expertNft", "dexeExpertNft", "babt"]) addRole(n[k], k);
  }

  const all = [...view.actionsOnFor, ...view.actionsOnAgainst];
  const executors = [...new Set(all.map((a) => a.executor.toLowerCase()))].filter((e) => isAddress(e));
  const callsB: Call[] = [];
  if (daoContracts[String(h.userKeeper).toLowerCase()]) {
    callsB.push({ target: h.userKeeper!, iface: USER_KEEPER_ABI, method: "tokenAddress", args: [], allowFailure: true });
  }
  const offset = callsB.length;
  for (const e of executors) {
    callsB.push({ target: e, iface: ERC20_ABI, method: "symbol", args: [], allowFailure: true });
    callsB.push({ target: e, iface: ERC20_ABI, method: "decimals", args: [], allowFailure: true });
    callsB.push({ target: e, iface: ERC20_ABI, method: "balanceOf", args: [govPool], allowFailure: true });
  }
  const resB = callsB.length > 0 ? await multicall(provider, callsB) : [];
  if (offset === 1 && resB[0]?.success) addRole(resB[0]!.value, "govToken");
  const tokens: Record<string, TokenFacts> = {};
  executors.forEach((e, k) => {
    const sym = resB[offset + k * 3];
    const dec = resB[offset + k * 3 + 1];
    const bal = resB[offset + k * 3 + 2];
    // A token is something that answers decimals() AND balanceOf(); symbol is optional.
    if (dec?.success && bal?.success) {
      tokens[e] = {
        symbol: sym?.success && typeof sym.value === "string" ? sym.value : null,
        decimals: Number(dec.value),
        treasuryBalance: BigInt(bal.value as bigint),
      };
    }
  });

  const nativeBalance = all.some((a) => {
    try {
      return BigInt(a.value) > 0n;
    } catch {
      return false;
    }
  })
    ? await provider.getBalance(govPool).catch(() => null)
    : null;

  // Generic decoder for selectors the review table does not explain — names
  // only, so the packet can say "calls foo(uint256) on X" instead of a hex blob.
  const fallbackSignatures: Record<string, string> = {};
  try {
    const decoder = new DecodeAbis(ctx.artifacts, ctx.selectors).resolve().decoder;
    for (const a of all) {
      if (a.data.length < 10) continue;
      const sel = a.data.slice(0, 10).toLowerCase();
      if (fallbackSignatures[sel]) continue;
      const d = decoder.decodeCalldata(a.data).primary;
      if (d?.signature) fallbackSignatures[sel] = d.signature;
    }
  } catch {
    /* names are a nicety; the review stands without them */
  }

  let text: string | null = null;
  let textError: string | undefined;
  const url = view.descriptionURL ?? "";
  if (url.trim().length === 0) {
    textError = "The proposal has no descriptionURL.";
  } else {
    try {
      const gateways = resolveGateways(ctx);
      const res = await fetchIpfs(stripIpfsPrefix(url), { gateways, maxBytes: 256 * 1024 });
      const json = res.json ?? (() => {
        const s = new TextDecoder().decode(res.bytes);
        try {
          return JSON.parse(s) as unknown;
        } catch {
          return s;
        }
      })();
      text = metadataToText(json);
    } catch (e) {
      textError = `The proposal text could not be fetched from IPFS (${safeErrorMessage(e).slice(0, 160)}); judge the actions alone.`;
    }
  }

  return {
    chainId: chain.chainId,
    govPool,
    proposalId: input.proposalId,
    stateIndex: view.proposalState,
    stateName: proposalStateName(view.proposalState),
    voteEnd: view.voteEnd,
    votesFor: view.votesFor,
    votesAgainst: view.votesAgainst,
    requiredQuorum: view.requiredQuorum,
    actionsOnFor: view.actionsOnFor,
    actionsOnAgainst: view.actionsOnAgainst,
    daoContracts,
    tokens,
    nativeBalance,
    nativeSymbol: chain.chainId === 56 || chain.chainId === 97 ? "BNB" : "native",
    addressBook: input.addressBook ?? {},
    text,
    textError,
    fallbackSignatures,
  };
}

export async function reviewProposal(ctx: ToolContext, input: ReviewInput, rpc?: RpcProvider): Promise<ReviewResult> {
  const facts = await gatherReviewFacts(ctx, input, rpc);
  return buildReview(facts, input.limits);
}

export const UNTRUSTED_TEXT_LABEL = "proposal title + description, written by the proposer";

export function registerProposalReviewTool(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  server.registerTool(
    "dexe_proposal_review",
    {
      title: "Review what a proposal will do",
      description:
        "Read-only. The voting packet for an agent: each FOR/AGAINST action decoded in plain words (token, human amount, " +
        "recipient label from addressBook, % of treasury) plus risk flags. The proposer's text comes back separately, " +
        "fenced as untrusted, with its own injection flags.",
      inputSchema: {
        govPool: z.string().describe("GovPool address"),
        proposalId: z.union([z.string(), z.number()]).describe(PROPOSAL_ID_DESC),
        addressBook: z
          .record(z.string(), z.string())
          .optional()
          .describe("Known addresses → labels; any other recipient is flagged NOT IN ADDRESS BOOK"),
        maxTreasuryPct: z.number().positive().max(100).optional().describe("Flag a single move above this % of the treasury balance (default 10)"),
        chainId: z.number().int().positive().optional().describe("Chain id (56 mainnet, 97 testnet). Default: the MCP's default chain."),
      },
    },
    async ({ govPool, proposalId, addressBook, maxTreasuryPct, chainId }) => {
      try {
        const id = Number(proposalId);
        const { packet, untrustedText } = await reviewProposal(
          ctx,
          { govPool, proposalId: id, chainId, addressBook, limits: { maxTreasuryPct } },
          rpc,
        );
        const content: { type: "text"; text: string }[] = [{ type: "text", text: JSON.stringify(packet) }];
        content.push({
          type: "text",
          text: untrustedText && untrustedText.length > 0 ? fenceUntrusted(UNTRUSTED_TEXT_LABEL, untrustedText, 4000) : "(no proposal text)",
        });
        return { content };
      } catch (e) {
        return { content: [{ type: "text" as const, text: safeErrorMessage(e) }], isError: true };
      }
    },
  );
}
