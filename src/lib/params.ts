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
