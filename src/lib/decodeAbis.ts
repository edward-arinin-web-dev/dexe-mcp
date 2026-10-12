import { ArtifactsMissingError, type AbiRecord, type Artifacts } from "../artifacts.js";
import { CalldataDecoder, type AbiSourceKind, type SelectorLookup } from "./decoders.js";
import { SelectorIndex } from "./selectors.js";
import { bundledAbiSnapshot, type AbiSnapshot } from "./abiSnapshot.js";
import { debugLog } from "../runtime.js";

export type { AbiSourceKind } from "./decoders.js";

/** The ABI set one decode call runs against, with a decoder bound to it. */
export interface DecodeAbiSource {
  readonly kind: AbiSourceKind;
  /**
   * For `artifacts`, a decoder that falls back to the snapshot for any lookup
   * the local compile cannot answer, top-level or nested. Every call it decodes
   * carries `abiSource`, so a mixed result is visible.
   */
  readonly decoder: CalldataDecoder;
  /** Plain-language name of the ABI set(s), for messages. */
  readonly label: string;
  /** True if a contract of this name is known — locally or, for `artifacts`, in the snapshot. */
  has(contractName: string): boolean;
  get(contractName: string): readonly AbiRecord[];
  /** Every known contract name (local and snapshot for `artifacts`). */
  names(): string[];
}

type LocalArtifacts = Pick<Artifacts, "get" | "list" | "requireArtifactsExist"> &
  Partial<Pick<Artifacts, "contractsDir">>;

/**
 * Picks the ABIs the decode tools run against.
 *
 * - A usable local Hardhat compile (DEXE_PROTOCOL_PATH, populated by
 *   dexe_compile) is tried first, as before the snapshot existed. "Usable"
 *   means `artifacts/contracts/` exists AND holds at least one ABI: a failed
 *   compile can leave the directory empty.
 * - Whatever the local compile cannot decode — a contract it lacks, a selector
 *   none of its ABIs has — falls through to the bundled snapshot
 *   (src/abi/protocolSnapshot.generated.ts).
 * - With no usable compile, the snapshot alone is used, so decoding works on an
 *   install that never cloned or compiled the protocol.
 *
 * Decided per call: a compile that lands mid-session takes over on the next one.
 */
export class DecodeAbis {
  private localDecoder: CalldataDecoder | undefined;
  private snapshotSource: DecodeAbiSource | undefined;

  constructor(
    private readonly artifacts: LocalArtifacts,
    private readonly selectors: SelectorLookup,
    private readonly snapshot: () => AbiSnapshot = bundledAbiSnapshot,
  ) {}

  resolve(): DecodeAbiSource {
    return this.hasLocalArtifacts() ? this.local() : this.bundled();
  }

  /** The snapshot on its own, regardless of local artifacts. */
  bundled(): DecodeAbiSource {
    if (!this.snapshotSource) {
      const snap = this.snapshot();
      this.snapshotSource = {
        kind: "snapshot",
        decoder: new CalldataDecoder(snap, new SelectorIndex(snap), { sourceKind: "snapshot" }),
        label: snap.describe(),
        has: (name) => snap.get(name).length > 0,
        get: (name) => snap.get(name),
        names: () => snap.names(),
      };
    }
    return this.snapshotSource;
  }

  private local(): DecodeAbiSource {
    const snapshot = this.bundled();
    this.localDecoder ??= new CalldataDecoder(this.artifacts, this.selectors, {
      sourceKind: "artifacts",
      fallback: snapshot.decoder,
    });
    const artifacts = this.artifacts;
    return {
      kind: "artifacts",
      decoder: this.localDecoder,
      label: `the compiled artifacts at ${artifacts.contractsDir ?? "DEXE_PROTOCOL_PATH"} or ${snapshot.label}`,
      has: (name) => artifacts.get(name).length > 0 || snapshot.has(name),
      get: (name) => artifacts.get(name),
      names: () => [...new Set([...artifacts.list().map((r) => r.contractName), ...snapshot.names()])],
    };
  }

  /**
   * `requireArtifactsExist` only throws `ArtifactsMissingError`; any other throw
   * is treated the same way, because "cannot use the local compile" has one
   * answer either way: decode against the snapshot.
   */
  private hasLocalArtifacts(): boolean {
    try {
      this.artifacts.requireArtifactsExist();
      return this.artifacts.list().length > 0;
    } catch (err) {
      if (!(err instanceof ArtifactsMissingError)) {
        debugLog("decode", "local artifacts unusable, decoding with the ABI snapshot", err);
      }
      return false;
    }
  }
}
