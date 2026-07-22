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
  .describe(
    "Chain id to read from (56 = BSC mainnet, 97 = BSC testnet). Defaults to the MCP's default chain. " +
      "Rejects if no RPC is configured for the requested chain.",
  );

/**
 * Shared `signerKey` input param for broadcast tools. Optional — when omitted
 * the primary `DEXE_PRIVATE_KEY` signs (unchanged behavior). Selects a key
 * from the opt-in `DEXE_AGENT_PK_1..16` keyring for multi-persona/swarm flows.
 */
export const signerKeyParam = z
  .string()
  .optional()
  .describe("Keyring signer: omit = primary key; 'agent<n>' or address = DEXE_AGENT_PK_* key (see dexe_agents_list).");
