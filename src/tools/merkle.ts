import { z } from "zod";
import { isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import {
  buildAddressMerkleTree,
  buildMerkleTree,
  computeLeafHash,
  verifyProof,
} from "../lib/merkleTree.js";

/**
 * Merkle utility tools — produce roots and proofs compatible with
 * OpenZeppelin's `StandardMerkleTree` and the on-chain verifier in
 * `TokenSaleProposalBuy.sol::_checkMerkleProofs`.
 *
 * Default leaf encoding is `["address"]` (the only shape used by the
 * frontend's OTC token-sale flow). Set `leafEncoding` + `entries` for
 * advanced trees (e.g. `["address","uint256"]`).
 */

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function jsonResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function normaliseAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of addresses) {
    if (!isAddress(raw)) throw new Error(`Invalid address: ${raw}`);
    const checksummed = getAddress(raw);
    if (seen.has(checksummed.toLowerCase())) continue;
    seen.add(checksummed.toLowerCase());
    result.push(checksummed);
  }
  return result;
}

export function registerMerkleTools(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    "dexe_merkle_build",
    {
      title: "Build a merkle tree (OZ StandardMerkleTree compatible)",
      description:
        "Builds a merkle tree compatible with OpenZeppelin StandardMerkleTree (used by DeXe's TokenSaleProposal merkle whitelists). Default leaf shape is a single address; pass `leafEncoding` + `entries` for richer leaves (e.g. address + amount). Returns root, leaf hashes, and per-input-index proofs.",
      inputSchema: {
        addresses: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            "Convenience: addresses for an `address`-only merkle whitelist. Mutually exclusive with `entries`.",
          ),
        entries: z
          .array(z.array(z.union([z.string(), z.number()])))
          .min(1)
          .optional()
          .describe(
            "Advanced: per-leaf raw values matching `leafEncoding` order. Mutually exclusive with `addresses`.",
          ),
        leafEncoding: z
          .array(z.string())
          .min(1)
          .default(["address"])
          .describe(
            "ABI types for each leaf column. Default `['address']` matches the OTC frontend.",
          ),
      },
      outputSchema: {
        root: z.string(),
        leafHashes: z.array(z.string()),
        proofs: z.array(z.array(z.string())),
        addresses: z.array(z.string()).optional(),
      },
    },
    async ({ addresses, entries, leafEncoding = ["address"] }) => {
      try {
        if (!addresses && !entries) {
          return errorResult("Must provide either `addresses` or `entries`.");
        }
        if (addresses && entries) {
          return errorResult("Provide either `addresses` or `entries`, not both.");
        }

        if (addresses) {
          const normalised = normaliseAddresses(addresses);
          const result = buildAddressMerkleTree(normalised);
          return jsonResult({
            root: result.root,
            leafHashes: result.leafHashes,
            proofs: result.proofs,
            addresses: normalised,
          });
        }

        const result = buildMerkleTree(entries as readonly (readonly unknown[])[], leafEncoding);
        return jsonResult({
          root: result.root,
          leafHashes: result.leafHashes,
          proofs: result.proofs,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "dexe_merkle_proof",
    {
      title: "Compute a merkle proof for one address (or leaf)",
      description:
        "Builds the same tree as `dexe_merkle_build` and returns the proof for a single target. Useful for buyer-side flows where the full whitelist is known but only one proof is needed. Default shape: address-only.",
      inputSchema: {
        addresses: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Address-only whitelist (mutually exclusive with `entries`)."),
        entries: z
          .array(z.array(z.union([z.string(), z.number()])))
          .min(1)
          .optional(),
        leafEncoding: z.array(z.string()).min(1).default(["address"]),
        target: z.string().describe("Address (when using `addresses`)."),
        targetEntry: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("Raw leaf values when using `entries`."),
      },
      outputSchema: {
        root: z.string(),
        leaf: z.string(),
        proof: z.array(z.string()),
        verified: z.boolean(),
      },
    },
    async ({ addresses, entries, leafEncoding = ["address"], target, targetEntry }) => {
      try {
        if (!addresses && !entries) {
          return errorResult("Must provide either `addresses` or `entries`.");
        }
        if (addresses) {
          if (!isAddress(target)) return errorResult(`Invalid target address: ${target}`);
          const normalised = normaliseAddresses(addresses);
          const checksummed = getAddress(target);
          const idx = normalised.findIndex((a) => a.toLowerCase() === checksummed.toLowerCase());
          if (idx === -1) {
            return errorResult(`Target ${checksummed} not present in whitelist.`);
          }
          const tree = buildAddressMerkleTree(normalised);
          const leaf = computeLeafHash([checksummed], ["address"]);
          const proof = tree.proofs[idx] ?? [];
          return jsonResult({
            root: tree.root,
            leaf,
            proof,
            verified: verifyProof(proof, tree.root, leaf),
          });
        }
        if (!entries) {
          return errorResult("Must provide `entries` when not using `addresses`.");
        }
        if (!targetEntry) {
          return errorResult("Provide `targetEntry` when using `entries`.");
        }
        const tree = buildMerkleTree(
          entries as readonly (readonly unknown[])[],
          leafEncoding,
        );
        const leaf = computeLeafHash(targetEntry, leafEncoding);
        const idx = tree.leafHashes.findIndex((h) => h.toLowerCase() === leaf.toLowerCase());
        if (idx === -1) {
          return errorResult("Target entry leaf not in tree.");
        }
        let proof: string[] = [];
        for (let i = 0; i < entries.length; i++) {
          const candidateLeaf = computeLeafHash(
            entries[i] as readonly unknown[],
            leafEncoding,
          );
          if (candidateLeaf.toLowerCase() === leaf.toLowerCase()) {
            proof = tree.proofs[i] ?? [];
            break;
          }
        }
        return jsonResult({
          root: tree.root,
          leaf,
          proof,
          verified: verifyProof(proof, tree.root, leaf),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
