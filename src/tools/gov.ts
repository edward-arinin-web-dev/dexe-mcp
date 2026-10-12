import { z } from "zod";
import { Contract, isAddress, type InterfaceAbi } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  sameArguments,
  type AbiSourceKind,
  type DecodedProposalAction,
  type DecodedCall,
} from "../lib/decoders.js";
import { DecodeAbis, type DecodeAbiSource } from "../lib/decodeAbis.js";
import { GovAddressResolver } from "../lib/govAddresses.js";
import { RpcProvider } from "../rpc.js";
import { renderUntrusted, untrustedResult } from "../lib/sanitize.js";
import { toActionableError } from "../lib/errors.js";
import { chainIdParam } from "../lib/params.js";

export function registerGovTools(server: McpServer, ctx: ToolContext): void {
  const rpc = new RpcProvider(ctx.config);
  const abis = new DecodeAbis(ctx.artifacts, ctx.selectors);
  const addresses = new GovAddressResolver(ctx.artifacts);

  registerDecodeCalldata(server, abis);
  registerDecodeProposal(server, abis, rpc);
  registerReadGovState(server, ctx, addresses, rpc);
  registerListGovContractTypes(server);
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Which ABI sets decoded a call tree (the call and everything nested in it). */
function collectSources(call: DecodedCall | null, out: Set<AbiSourceKind>): Set<AbiSourceKind> {
  if (!call) return out;
  if (call.abiSource) out.add(call.abiSource);
  for (const n of call.nested ?? []) collectSources(n, out);
  return out;
}

/**
 * One line naming the snapshot when it decoded anything: on its own (no usable
 * local compile), or as the fallback for calls the local compile lacks.
 */
function snapshotNote(used: Set<AbiSourceKind>, source: DecodeAbiSource, abis: DecodeAbis): string {
  if (!used.has("snapshot")) return "";
  return source.kind === "snapshot"
    ? `\n\nDecoded with ${source.label}.`
    : `\n\nThe local compile has no ABI for some of these calls; they were decoded with ${abis.bundled().label}.`;
}

/** Overall source for a reply: the one set used, or "mixed" when both were. */
function overallSource(used: Set<AbiSourceKind>, source: DecodeAbiSource): AbiSourceKind | "mixed" {
  if (used.size > 1) return "mixed";
  return [...used][0] ?? source.kind;
}

const argNames = (c: DecodedCall) => Object.keys(c.args).join(", ");

/** Caps a list of contract names so an unknown-name error stays short. */
function knownNames(source: DecodeAbiSource, max = 50): string {
  const names = source.names().sort();
  return names.length > max
    ? `${names.slice(0, max).join(", ")}, … (${names.length - max} more)`
    : names.join(", ");
}

/**
 * Why nothing matched, and what to do about it. The snapshot branch names no
 * dev tool: it is the path a zero-config install (and the read edition) takes.
 */
function noMatchMessage(data: string, contract: string | undefined, source: DecodeAbiSource): string {
  const selector = data.slice(0, 10);
  if (contract) {
    return (
      `No matching ABI found for selector ${selector} in ${contract} (${source.label}). ` +
      "Omit `contract` to search every ABI."
    );
  }
  const base =
    `No matching ABI found for selector ${selector} in ${source.label}. ` +
    "The target is most likely not a DeXe Protocol contract or a plain ERC20/ERC721 — decode it " +
    "with that contract's verified ABI (block explorer), or look the selector up in a public " +
    "signature database such as 4byte.directory. A DeXe contract upgraded after the snapshot's " +
    "commit can also carry selectors the snapshot does not know.";
  // Both sets were searched by now (the local decoder falls back to the
  // snapshot); the dev hint only applies where a local compile exists.
  return source.kind === "artifacts"
    ? `${base} Try dexe_find_selector to search the local compile's events and errors too.`
    : base;
}

// ---------- dexe_decode_calldata ----------

function registerDecodeCalldata(server: McpServer, abis: DecodeAbis): void {
  server.registerTool(
    "dexe_decode_calldata",
    {
      title: "Decode ABI-encoded calldata",
      description:
        "Read-only, local. Decodes '0x…' calldata against the DeXe Protocol ABIs (bundled; a local compile wins) — only `contract`'s when given, else every match.",
      inputSchema: {
        data: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string")
          .describe("Raw calldata including 4-byte selector"),
        contract: z.string().optional().describe("Optional: restrict to one contract's ABI"),
      },
      outputSchema: {
        matched: z.boolean(),
        primary: z
          .object({
            contract: z.string().nullable(),
            sourceName: z.string().nullable(),
            signature: z.string(),
            selector: z.string(),
            args: z.record(z.string(), z.unknown()),
            argsArray: z.array(z.unknown()),
            privileged: z.boolean().optional(),
            nested: z.array(z.unknown()).optional(),
            abiSource: z.enum(["artifacts", "snapshot"]).optional(),
          })
          .nullable(),
        alternativeCount: z.number(),
        alternatives: z.array(
          z.object({
            contract: z.string().nullable(),
            signature: z.string(),
          }),
        ),
        ambiguous: z
          .boolean()
          .describe(
            "True when another contract reads this selector's arguments differently (other names or types, e.g. ERC20 vs ERC721 approve)",
          ),
        abiSource: z
          .enum(["artifacts", "snapshot", "mixed"])
          .describe("ABIs used: the local compile, the bundled DeXe-Protocol snapshot, or both (nested calls)"),
      },
    },
    async ({ data, contract }) => {
      const source = abis.resolve();
      if (contract && !source.has(contract)) {
        return errorResult(
          `No ABI named "${renderUntrusted(contract, 80)}" in ${source.label}. Known contracts: ${knownNames(source)}. ` +
            "Omit `contract` to search every ABI by selector.",
        );
      }

      const result = source.decoder.decodeCalldata(data, contract);
      const used = collectSources(result.primary, new Set());
      const differing = result.primary
        ? result.alternatives.find((a) => !sameArguments(a, result.primary!))
        : undefined;
      const structured = {
        matched: result.primary !== null,
        primary: result.primary,
        alternativeCount: result.alternatives.length,
        alternatives: result.alternatives.map((a) => ({ contract: a.contract, signature: a.signature })),
        ambiguous: differing !== undefined,
        abiSource: overallSource(used, source),
      };

      const text = result.primary
        ? renderDecodedCall(result.primary, "") +
          (result.alternatives.length > 0
            ? `\n\n${result.alternatives.length} alternative match(es): ${result.alternatives.map((a) => `${a.contract}.${a.signature}`).join(", ")}`
            : "") +
          (differing
            ? `\n\n⚠ AMBIGUOUS: ${result.primary.contract} reads the arguments as (${argNames(result.primary)}), ` +
              `${differing.contract} as (${argNames(differing)}). Check which contract the target is before trusting the names.`
            : "") +
          snapshotNote(used, source, abis)
        : noMatchMessage(data, contract, source);

      // The spread is mandatory: `untrustedResult` returns only content +
      // structuredContent, so building the object from it directly would drop
      // `isError` and turn a no-match into a reported success.
      return {
        ...untrustedResult({
          summary: text,
          label: "decoded calldata arguments (author-controlled)",
          structured,
        }),
        isError: !result.primary,
      };
    },
  );
}

// ---------- dexe_decode_proposal ----------

function registerDecodeProposal(server: McpServer, abis: DecodeAbis, rpc: RpcProvider): void {
  server.registerTool(
    "dexe_decode_proposal",
    {
      title: "Read and decode a GovPool proposal",
      description:
        "Read-only. Fetches a GovPool proposal via `getProposals(offset, limit)` and decodes its for/against actions. Works with the built-in public RPC; set DEXE_RPC_URL_MAINNET / _TESTNET for reliability.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        proposalId: z.number().int().positive().describe("Proposal ID (1-indexed)"),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        proposalId: z.number(),
        proposalState: z.number(),
        stateName: z.string().describe("Named ProposalState (Voting, SucceededFor, ExecutedFor, ...)"),
        descriptionURL: z.string(),
        requiredQuorum: z.string(),
        requiredValidatorsQuorum: z.string(),
        core: z.object({
          voteEnd: z.string(),
          executeAfter: z.string(),
          executed: z.boolean(),
          votesFor: z.string(),
          votesAgainst: z.string(),
          rawVotesFor: z.string(),
          rawVotesAgainst: z.string(),
          givenRewards: z.string(),
        }),
        forActions: z.array(z.unknown()),
        againstActions: z.array(z.unknown()),
        abiSource: z
          .enum(["artifacts", "snapshot", "mixed"])
          .describe(
            "ABIs used to decode the actions: the local compile, the bundled DeXe-Protocol snapshot, or both (each decoded call says which)",
          ),
      },
    },
    async ({ govPool, proposalId, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      const source = abis.resolve();

      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;

      // A local compile without GovPool (partial or foreign artifacts) still
      // reads the proposal through the snapshot's GovPool ABI.
      const abi = source.get("GovPool")[0]?.abi ?? abis.bundled().get("GovPool")[0]!.abi;

      const pool = new Contract(govPool, abi as unknown as InterfaceAbi, provider);
      let views: unknown[];
      try {
        views = await pool.getFunction("getProposals")(proposalId - 1, 1);
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_decode_proposal getProposals").message);
      }
      if (!views || views.length === 0) {
        return errorResult(`Proposal ${proposalId} not found at ${govPool}.`);
      }

      // ProposalView = [proposal, validatorProposal, proposalState, requiredQuorum, requiredValidatorsQuorum]
      // proposal = [core, descriptionURL, actionsOnFor, actionsOnAgainst]
      // core = [settings, voteEnd, executeAfter, executed, votesFor, votesAgainst, rawVotesFor, rawVotesAgainst, givenRewards]
      const view = views[0] as unknown[];
      const proposal = view[0] as unknown[];
      const core = proposal[0] as unknown[];
      const descriptionURL = proposal[1] as string;
      const rawForActions = proposal[2] as Array<[string, bigint, string]>;
      const rawAgainstActions = proposal[3] as Array<[string, bigint, string]>;
      const proposalState = Number(view[2]);
      const requiredQuorum = (view[3] as bigint).toString();
      const requiredValidatorsQuorum = (view[4] as bigint).toString();

      const { decoder } = source;
      const forActions: DecodedProposalAction[] = rawForActions.map((a) =>
        decoder.decodeProposalAction({ executor: a[0], value: a[1], data: a[2], side: "for" }),
      );
      const againstActions: DecodedProposalAction[] = rawAgainstActions.map((a) =>
        decoder.decodeProposalAction({ executor: a[0], value: a[1], data: a[2], side: "against" }),
      );

      const used = new Set<AbiSourceKind>();
      for (const a of [...forActions, ...againstActions]) collectSources(a.decoded, used);

      const structured = {
        govPool,
        proposalId,
        proposalState,
        stateName: PROPOSAL_STATE_NAMES[proposalState] ?? "Undefined",
        descriptionURL,
        requiredQuorum,
        requiredValidatorsQuorum,
        core: {
          voteEnd: (core[1] as bigint).toString(),
          executeAfter: (core[2] as bigint).toString(),
          executed: Boolean(core[3]),
          votesFor: (core[4] as bigint).toString(),
          votesAgainst: (core[5] as bigint).toString(),
          rawVotesFor: (core[6] as bigint).toString(),
          rawVotesAgainst: (core[7] as bigint).toString(),
          givenRewards: (core[8] as bigint).toString(),
        },
        forActions,
        againstActions,
        abiSource: overallSource(used, source),
      };

      // Deliberately NO `body`: a fence caps at 4000 chars, and an attacker
      // controlling six actions of padded args could push a
      // "PRIVILEGED SELECTOR" line past the truncation point — strictly worse
      // than the injection being fixed. The prose is server-authored apart from
      // fields already escaped above, and `structured` (which carried the raw
      // descriptionURL and decoded args) is now deep-sanitized and announced.
      const text =
        `Proposal ${proposalId} @ ${govPool}\nState: ${PROPOSAL_STATE_NAMES[proposalState] ?? proposalState}\nDescription: ${renderUntrusted(descriptionURL)}\nActions on For: ${forActions.length}\nActions on Against: ${againstActions.length}\n${formatActions(forActions)}${formatActions(againstActions)}${snapshotNote(used, source, abis)}`;
      return untrustedResult({
        summary: text,
        label: `descriptionURL and decoded action arguments of proposal ${proposalId} on GovPool ${govPool} (author-controlled)`,
        structured,
      });
    },
  );
}

const PROPOSAL_STATE_NAMES = [
  "Voting",
  "WaitingForVotingTransfer",
  "ValidatorVoting",
  "Defeated",
  "SucceededFor",
  "SucceededAgainst",
  "Locked",
  "ExecutedFor",
  "ExecutedAgainst",
  "Undefined",
];

/**
 * Render a decoded call as indented text, printing its decoded args, a
 * ⚠ PRIVILEGED marker for privileged-class selectors, and recursively unwrapping any
 * nested calls (e.g. the inner calls of a `multicall`) so a reviewer reading
 * the text sees hidden privileged actions, not just the wrapper.
 */
function renderDecodedCall(call: DecodedCall, indent: string): string {
  const flag = call.privileged ? "  ⚠ PRIVILEGED SELECTOR" : "";
  let argsText = "";
  try {
    const j = JSON.stringify(call.args);
    // Decoded args are attacker-authored strings (executorDescription, IPFS
    // URIs, token names). JSON.stringify escapes control chars but does NOT
    // strip bidi/zero-width and does NOT defang a forged `[/UNTRUSTED …]`.
    // renderUntrusted sanitizes FIRST and caps after, so the cap is a real cap,
    // and flags non-ASCII — the signal a reviewer of a transfer arg needs.
    if (j && j !== "{}") argsText = renderUntrusted(j, 1000);
  } catch {
    /* args not JSON-serializable — skip */
  }
  let s = `${indent}${call.contract ?? "?"}.${call.signature}${flag}`;
  if (argsText) s += `\n${indent}  args: ${argsText}`;
  if (call.nested && call.nested.length > 0) {
    s += `\n${indent}  ↳ unwraps ${call.nested.length} nested call(s):`;
    for (const n of call.nested) s += `\n${renderDecodedCall(n, indent + "    ")}`;
  }
  return s;
}

function formatActions(actions: DecodedProposalAction[]): string {
  if (actions.length === 0) return "";
  return (
    `\n\n--- ${actions[0]!.side.toUpperCase()} actions ---\n` +
    actions
      .map((a, i) => {
        const decoded = a.decoded ? renderDecodedCall(a.decoded, "     ") : "     (no matching ABI)";
        return `  ${i}: executor=${a.executor} value=${a.value}\n${decoded}`;
      })
      .join("\n")
  );
}

// ---------- dexe_read_gov_state ----------

function registerReadGovState(
  server: McpServer,
  _ctx: ToolContext,
  addresses: GovAddressResolver,
  rpc: RpcProvider,
): void {
  server.registerTool(
    "dexe_read_gov_state",
    {
      title: "Read aggregate GovPool state",
      description:
        "Read-only. Reads `getHelperContracts()` and `getNftContracts()` on a GovPool. Works with the built-in public RPC; set DEXE_RPC_URL_MAINNET / _TESTNET for reliability.",
      inputSchema: {
        govPool: z.string().describe("GovPool contract address"),
        chainId: chainIdParam,
      },
      outputSchema: {
        govPool: z.string(),
        helpers: z.object({
          settings: z.string(),
          userKeeper: z.string(),
          validators: z.string(),
          poolRegistry: z.string(),
          votePower: z.string(),
        }),
        nftContracts: z.object({
          nftMultiplier: z.string(),
          expertNft: z.string(),
          dexeExpertNft: z.string(),
          babt: z.string(),
        }),
      },
    },
    async ({ govPool, chainId }) => {
      if (!isAddress(govPool)) return errorResult(`Invalid GovPool address: ${govPool}`);
      const pr = rpc.tryProvider(chainId);
      if ("error" in pr) return errorResult(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;
      // Same resolution the provider above went through, so the resolver's cache
      // is keyed by the chain this read actually targets — a GovPool address is
      // not unique across chains and an unkeyed entry would let chain 56 answer a
      // chain 97 lookup. Passing it also spares the resolver a getNetwork() call.
      const readChainId = rpc.resolveChainId(chainId);

      try {
        const helpers = await addresses.resolveHelpers(govPool, provider, readChainId);
        const nftContracts = await addresses.resolveNftContracts(govPool, provider, readChainId);
        const structured = { govPool, helpers, nftContracts };
        return {
          content: [
            {
              type: "text" as const,
              text: `GovPool ${govPool} (chain ${readChainId})\n\nHelpers:\n  settings     : ${helpers.settings}\n  userKeeper   : ${helpers.userKeeper}\n  validators   : ${helpers.validators}\n  poolRegistry : ${helpers.poolRegistry}\n  votePower    : ${helpers.votePower}\n\nNFT contracts:\n  nftMultiplier : ${nftContracts.nftMultiplier}\n  expertNft     : ${nftContracts.expertNft}\n  dexeExpertNft : ${nftContracts.dexeExpertNft}\n  babt          : ${nftContracts.babt}`,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(toActionableError(err, "dexe_read_gov_state").message);
      }
    },
  );
}

// ---------- dexe_list_gov_contract_types ----------

function registerListGovContractTypes(server: McpServer): void {
  server.registerTool(
    "dexe_list_gov_contract_types",
    {
      title: "Orientation: gov subsystem contract catalog",
      description:
        "Read-only, local. Catalog of the DeXe governance contracts: what each does and where its source lives.",
      inputSchema: {},
      outputSchema: {
        contracts: z.array(
          z.object({
            name: z.string(),
            role: z.string(),
            sourcePath: z.string(),
          }),
        ),
      },
    },
    async () => {
      const catalog = [
        { name: "GovPool", role: "Per-DAO main contract: proposals, voting, execution", sourcePath: "contracts/gov/GovPool.sol" },
        { name: "GovSettings", role: "Proposal settings (quorum, voting period, etc.)", sourcePath: "contracts/gov/settings/GovSettings.sol" },
        { name: "GovUserKeeper", role: "User deposits, delegations, and voting power bookkeeping", sourcePath: "contracts/gov/user-keeper/GovUserKeeper.sol" },
        { name: "GovValidators", role: "Validator set + second-step validator voting", sourcePath: "contracts/gov/validators/GovValidators.sol" },
        { name: "DistributionProposal", role: "Proposal executor for reward distribution", sourcePath: "contracts/gov/proposals/DistributionProposal.sol" },
        { name: "StakingProposal", role: "Proposal executor for staking-related actions", sourcePath: "contracts/gov/proposals/StakingProposal.sol" },
        { name: "TokenSaleProposal", role: "Proposal executor for token sale tiers", sourcePath: "contracts/gov/proposals/TokenSaleProposal.sol" },
        { name: "LinearPower", role: "Voting-power formula: linear", sourcePath: "contracts/gov/voting/LinearPower.sol" },
        { name: "PolynomialPower", role: "Voting-power formula: polynomial", sourcePath: "contracts/gov/voting/PolynomialPower.sol" },
        { name: "ContractsRegistry", role: "Service locator for global protocol contracts (not per-pool)", sourcePath: "contracts/core/ContractsRegistry.sol" },
        { name: "PoolRegistry", role: "Tracks all deployed GovPool instances", sourcePath: "contracts/factory/PoolRegistry.sol" },
      ];
      return {
        content: [
          {
            type: "text" as const,
            text: catalog.map((c) => `  ${c.name.padEnd(22)} — ${c.role}\n    ${c.sourcePath}`).join("\n"),
          },
        ],
        structuredContent: { contracts: catalog },
      };
    },
  );
}
