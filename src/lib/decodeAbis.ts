import { ArtifactsMissingError, type AbiRecord, type Artifacts } from "../artifacts.js";
import { CalldataDecoder, type SelectorLookup } from "./decoders.js";
import { SelectorIndex } from "./selectors.js";
import { bundledAbiSnapshot, type AbiSnapshot } from "./abiSnapshot.js";
import { debugLog } from "../runtime.js";

export type AbiSourceKind = "artifacts" | "snapshot";

/** The ABI set one decode call runs against, with a decoder bound to it. */
export interface DecodeAbiSource {
  readonly kind: AbiSourceKind;
  readonly decoder: CalldataDecoder;
  /** Plain-language name of the ABI set, for messages. */
  readonly label: string;
  get(contractName: string): readonly AbiRecord[];
  names(): string[];
}

type LocalArtifacts = Pick<Artifacts, "get" | "list" | "requireArtifactsExist"> &
  Partial<Pick<Artifacts, "contractsDir">>;

/**
 * Picks the ABIs the decode tools run against.
 *
 * - A local Hardhat compile (DEXE_PROTOCOL_PATH, populated by dexe_compile) is
 *   used whenever it exists, exactly as before the snapshot existed.
 * - Otherwise the bundled snapshot (src/abi/protocolSnapshot.generated.ts) is
 *   used, so decoding works on an install that never cloned or compiled the
 *   protocol.
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

  /** The snapshot, regardless of local artifacts (e.g. for a contract the local compile lacks). */
  bundled(): DecodeAbiSource {
    if (!this.snapshotSource) {
      const snap = this.snapshot();
      this.snapshotSource = {
        kind: "snapshot",
        decoder: new CalldataDecoder(snap, new SelectorIndex(snap)),
        label: snap.describe(),
        get: (name) => snap.get(name),
        names: () => snap.names(),
      };
    }
    return this.snapshotSource;
  }

  private local(): DecodeAbiSource {
    this.localDecoder ??= new CalldataDecoder(this.artifacts, this.selectors);
    const artifacts = this.artifacts;
    return {
      kind: "artifacts",
      decoder: this.localDecoder,
      label: `the compiled artifacts at ${artifacts.contractsDir ?? "DEXE_PROTOCOL_PATH"}`,
      get: (name) => artifacts.get(name),
      names: () => [...new Set(artifacts.list().map((r) => r.contractName))],
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
      return true;
    } catch (err) {
      if (!(err instanceof ArtifactsMissingError)) {
        debugLog("decode", "local artifacts unusable, decoding with the ABI snapshot", err);
      }
      return false;
    }
  }
}
