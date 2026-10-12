import { z } from "zod";

/**
 * Input params only write tools take: the calldata builders' `chainId`, the
 * keyring `signerKey`, and the off-chain (backend) proposal id. The shared
 * vocabulary every tool uses — `chainId` for reads, `govPool`, proposal and NFT
 * ids — is in ./params.ts.
 */

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

/** The DeXe backend's own id space — serialized into JSON:API bodies as a number. */
export const PROPOSAL_ID_DESC_OFFCHAIN = "Off-chain proposal id from the DeXe backend (JSON number).";

