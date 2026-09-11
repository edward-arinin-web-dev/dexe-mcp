import { z } from "zod";

/**
 * Shared `chainId` input param for every read tool. Optional — when omitted the
 * MCP's default chain is used, so adding this to a tool is non-breaking.
 * Write tools already carry their own copy with broadcast-specific wording.
 */
export const chainIdParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Chain to read from: 56 mainnet, 97 testnet. Needs an RPC for it. Default: the configured chain.");

/**
 * `chainId` for the BACKEND-only reads (token holders, DAO stats, NFTs). The
 * DeXe indexer covers mainnets only, so the 97-testnet half of the RPC wording
 * would be a false claim here.
 */
export const backendChainIdParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Chain for the backend lookup: 1 Ethereum, 56 BSC. Testnets are not indexed. Default: the configured chain.");

/**
 * `chainId` for CALLDATA BUILDERS, which only stamp the chain into the payload
 * envelope — they neither read from it nor require an RPC for it. Reusing
 * `chainIdParam` here published two false claims on 28 tools ("read from",
 * "rejects if no RPC"): a builder happily stamps an unconfigured chain, and the
 * mismatch is caught later by the B11 broadcast guard, not here.
 *
 * Deliberately terser than the read param: it is repeated across the whole
 * builder surface, where every character is paid on every `tools/list`.
 */
export const buildChainIdParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Chain this payload targets: 56 mainnet, 97 testnet. Default: the configured chain.");

/**
 * Shared `signerKey` input param for broadcast tools. Optional — when omitted
 * the primary `DEXE_PRIVATE_KEY` signs (unchanged behavior). Selects a key
 * from the opt-in `DEXE_AGENT_PK_1..16` keyring for multi-persona/swarm flows.
 */
export const signerKeyParam = z
  .string()
  .optional()
  .describe("Keyring signer: omit = primary key; 'agent<n>' or address = a DEXE_AGENT_PK_* key.");

/**
 * ── Shared param VOCABULARY ────────────────────────────────────────────────
 *
 * The same concept was re-declared as a bare `z.string()` in ~40 places, so
 * `govPool`, `proposalId` and `nftIds` shipped with no description at all on
 * fund-moving tools. These are the one text per concept.
 *
 * They are DESCRIPTION-ONLY where the declared zod type differs between call
 * sites: applying a shared *_DESC string onto whatever type a site already has
 * keeps validation byte-identical, while a shared zod constant would silently
 * widen (`proposalId` as `string | number` reaches `parseUintString`, which
 * only accepts strings) or narrow (`nftIds` as `z.array(z.string())` would
 * reject the numeric ids `numericIntString` accepts today).
 *
 * Deliberately terse — every character is paid on every `tools/list`, and
 * `govPool` alone is published on 36 tools.
 */

/** The DAO's GovPool contract address — its main address. */
export const GOV_POOL_DESC = "DAO GovPool address (dexe_dao_registry_lookup).";

/** Drop-in for a BARE `govPool: z.string()`. Never replaces a described site. */
export const govPoolParam = z.string().describe(GOV_POOL_DESC);

/** DeXe proposal ids are 1-indexed counters on the pool, not hashes. */
export const PROPOSAL_ID_DESC = "On-chain proposal id, 1-indexed decimal (dexe_proposal_list).";

/** The DeXe backend's own id space — serialized into JSON:API bodies as a number. */
export const PROPOSAL_ID_DESC_OFFCHAIN = "Off-chain proposal id from the DeXe backend (JSON number).";

/** OZ/Bravo ids are keccak-derived uint256s, NOT 1-indexed counters. */
export const PROPOSAL_ID_DESC_GOVERNOR = "Proposal id from hashProposal, decimal or 0x-hex.";

/** NFT ids the CALLER owns (deposit / vote / delegate / withdraw). */
export const NFT_IDS_OWN_DESC = "Your governance NFT token ids, decimal; [] for ERC20-only DAOs.";

/** NFT ids the DAO TREASURY owns (treasury delegation). */
export const NFT_IDS_TREASURY_DESC = "DAO-treasury governance NFT token ids, decimal; [] if none.";

/** Who receives delegated power. */
export const DELEGATEE_DESC = "Address receiving the delegated voting power.";
