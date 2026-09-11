/**
 * The dryRun IPFS disclosure block.
 *
 * A composite's preview embeds `ipfs://…` refs directly in the calldata it
 * hands back, and `dryRun` payloads are complete `{to,data,value,chainId}`
 * objects that `dexe_tx_send` will happily broadcast. Before 0.34.0 nothing in
 * the response said whether those refs pointed at pinned content — so a
 * preview's payload looked exactly like a real one, and broadcasting it minted
 * a DAO (or a proposal) whose metadata resolved to nothing. On a DAO profile
 * that is permanent: `editDescriptionURL` is `onlyThis`, so the repair needs a
 * governance proposal to pass.
 *
 * The block below is COMPUTED from what each call site actually did — never
 * hand-written — so it cannot drift from reality the way a literal note does.
 * Every artifact carries its own `pinned` flag, which means a mixed envelope
 * (some refs pinned, some previewed) describes itself correctly instead of
 * making one flat, wrong claim about all of them.
 */

/** One `ipfs://` reference that rode into emitted calldata or DAO metadata. */
export interface IpfsArtifact {
  /** Caller-facing name of the field this ref lands in. */
  field: string;
  uri: string;
  /** False = computed locally under dryRun, nothing was uploaded. */
  pinned: boolean;
  /**
   * For unpinned artifacts: whether the local CID is provably identical to what
   * a real pin returns (see `LocalPinCid.exact`). Defaults to true.
   */
  exact?: boolean;
}

export interface IpfsPreviewBlock {
  ipfs: {
    artifacts: IpfsArtifact[];
    allPinned: false;
    note: string;
  };
}

/**
 * Returns `{}` when every artifact was really pinned (a real run must carry no
 * marker at all), and the disclosure block otherwise.
 */
export function ipfsPreviewBlock(artifacts: readonly IpfsArtifact[]): IpfsPreviewBlock | Record<string, never> {
  const unpinned = artifacts.filter((a) => !a.pinned);
  if (unpinned.length === 0) return {};
  const fields = unpinned.map((a) => a.field).join(", ");
  const plural = unpinned.length === 1;
  const inexact = unpinned.filter((a) => a.exact === false);
  return {
    ipfs: {
      artifacts: [...artifacts],
      allPinned: false,
      note:
        `PREVIEW — ${fields}: ${plural ? "this CID was" : "these CIDs were"} computed locally, not pinned (dryRun). ` +
        `The CID${plural ? "" : "s"} and therefore this calldata match what a real run emits byte for byte, but the ` +
        `content itself is on nobody's IPFS node. Do NOT broadcast these payloads (dexe_tx_send or a wallet): the ` +
        `metadata would never resolve, and on a DAO profile that is permanent — changing descriptionURL requires ` +
        `passing a proposal. Re-run the SAME call without dryRun (with DEXE_PINATA_JWT set) to pin the content and ` +
        `broadcast.` +
        (inexact.length > 0
          ? ` Note: ${inexact.map((a) => a.field).join(", ")} ${inexact.length === 1 ? "is" : "are"} large or contain ` +
            `non-ASCII characters, so the local CID is the right shape but not provably identical to the pinned one.`
          : ""),
    },
  };
}
