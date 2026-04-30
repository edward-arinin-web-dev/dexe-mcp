import { AbiCoder, getBytes, keccak256, concat, hexlify } from "ethers";

/**
 * Minimal OpenZeppelin-StandardMerkleTree-compatible builder.
 *
 * Matches the frontend's `@openzeppelin/merkle-tree` (used in
 * `C:/dev/investing-dashboard/src/utils/MerkleTreeEntity.ts`) and the
 * on-chain verifier in `TokenSaleProposalBuy.sol::_checkMerkleProofs`:
 *
 *   leaf  = keccak256(bytes.concat(keccak256(abi.encode(...values))))
 *   node  = keccak256(sorted(left, right))     // commutative
 *
 * Leaves are sorted by leafHash (ascending) to give a deterministic root.
 */

export type LeafValues = readonly unknown[];

const coder = AbiCoder.defaultAbiCoder();

function leafHash(types: readonly string[], values: LeafValues): string {
  const inner = keccak256(coder.encode(types as string[], values as unknown[]));
  return keccak256(concat([inner]));
}

function commutative(a: string, b: string): string {
  const ab = getBytes(a);
  const bb = getBytes(b);
  // lexicographic compare of bytes
  let cmp = 0;
  for (let i = 0; i < ab.length && cmp === 0; i++) {
    cmp = (ab[i] ?? 0) - (bb[i] ?? 0);
  }
  return cmp <= 0 ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface MerkleTreeResult {
  root: string;
  /** Proof per original-input index (i.e. proofs[i] is for entries[i]). */
  proofs: string[][];
  /** Sorted leaf hashes (debug/inspection). */
  leafHashes: string[];
}

/**
 * Build a merkle tree over `entries`, where each entry is a tuple of values
 * matching `leafEncoding` (e.g. `["address"]` or `["address", "uint256"]`).
 *
 * Returns root + per-entry proof + leaf hashes. Compatible with
 * `MerkleProof.verifyCalldata` in OpenZeppelin Solidity.
 */
export function buildMerkleTree(
  entries: readonly LeafValues[],
  leafEncoding: readonly string[],
): MerkleTreeResult {
  if (entries.length === 0) {
    throw new Error("buildMerkleTree: entries must not be empty");
  }

  const original = entries.map((vals) => leafHash(leafEncoding, vals));

  const indexed = original
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));

  const n = indexed.length;
  const treeSize = n === 1 ? 1 : 2 * n - 1;
  const tree: string[] = new Array(treeSize).fill("0x");
  for (let i = 0; i < n; i++) tree[n - 1 + i] = indexed[i]!.h;
  for (let i = n - 2; i >= 0; i--) {
    tree[i] = commutative(tree[2 * i + 1]!, tree[2 * i + 2]!);
  }

  const sortedToOriginal = indexed.map(({ i }) => i);
  const originalToSorted = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) originalToSorted[sortedToOriginal[s]!] = s;

  function siblingPath(leafSortedIdx: number): string[] {
    const proof: string[] = [];
    let node = n - 1 + leafSortedIdx;
    while (node > 0) {
      const sibling = node % 2 === 0 ? node - 1 : node + 1;
      proof.push(tree[sibling]!);
      node = Math.floor((node - 1) / 2);
    }
    return proof;
  }

  const proofs: string[][] = new Array(n);
  for (let original_i = 0; original_i < n; original_i++) {
    proofs[original_i] = siblingPath(originalToSorted[original_i]!);
  }

  return {
    root: hexlify(tree[0]!),
    proofs,
    leafHashes: indexed.map(({ h }) => h),
  };
}

/** Convenience: build a single-address-leaf tree (the OTC default). */
export function buildAddressMerkleTree(addresses: readonly string[]): MerkleTreeResult {
  const entries = addresses.map((a) => [a] as const);
  return buildMerkleTree(entries, ["address"]);
}

/** Verify a proof against the root. Mirrors `MerkleProof.verifyCalldata`. */
export function verifyProof(
  proof: readonly string[],
  root: string,
  leaf: string,
): boolean {
  let computed = leaf;
  for (const sibling of proof) computed = commutative(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}

/**
 * Compute leaf hash for a given entry — exposed for callers that want to
 * pass the leaf to `verifyProof` without re-running the whole tree.
 */
export function computeLeafHash(values: LeafValues, leafEncoding: readonly string[]): string {
  return leafHash(leafEncoding, values);
}
