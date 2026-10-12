import type { AbiRecord } from "../artifacts.js";
import { PROTOCOL_ABI_SNAPSHOT_JSON } from "../abi/protocolSnapshot.generated.js";

/**
 * Shape of the committed ABI snapshot (src/abi/protocolSnapshot.generated.ts,
 * written by scripts/gen-abi-snapshot.ts). ABI only — no bytecode — so the
 * decode tools work on an install that has never cloned or compiled
 * DeXe-Protocol (the zero-config path, and the remote read server, which has no
 * git, npm or hardhat).
 */
export interface AbiSnapshotData {
  readonly protocol: {
    readonly repository: string;
    /** DeXe-Protocol commit the artifacts were compiled from. */
    readonly commit: string;
    readonly solcVersion: string;
    readonly openzeppelinContracts: string;
  };
  readonly contracts: readonly AbiRecord[];
}

let parsedData: AbiSnapshotData | undefined;

/**
 * The snapshot, parsed on first use: a process that never decodes never pays
 * for it. Its shape is pinned by tests/lib/abi-snapshot.test.ts.
 */
export function protocolAbiSnapshotData(): AbiSnapshotData {
  return (parsedData ??= JSON.parse(PROTOCOL_ABI_SNAPSHOT_JSON) as AbiSnapshotData);
}

/**
 * Read-only view over the snapshot with the same `get` / `list` surface the
 * decoder and `SelectorIndex` use on the compiled `Artifacts`.
 *
 * `list()` returns the same array every call: `SelectorIndex` rebuilds when that
 * identity changes, so a stable one means the index is built once per process.
 */
export class AbiSnapshot {
  readonly protocol: AbiSnapshotData["protocol"];
  private readonly records: readonly AbiRecord[];
  private readonly byName = new Map<string, AbiRecord[]>();

  constructor(data: AbiSnapshotData = protocolAbiSnapshotData()) {
    this.protocol = data.protocol;
    this.records = data.contracts;
    for (const r of this.records) {
      const list = this.byName.get(r.contractName);
      if (list) list.push(r);
      else this.byName.set(r.contractName, [r]);
    }
  }

  list(): readonly AbiRecord[] {
    return this.records;
  }

  get(contractName: string): AbiRecord[] {
    return this.byName.get(contractName) ?? [];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Plain-language name for messages, e.g. "the bundled DeXe-Protocol ABI snapshot (39 contracts, commit f09a3ba98c)". */
  describe(): string {
    return `the bundled DeXe-Protocol ABI snapshot (${this.records.length} contracts, commit ${this.protocol.commit.slice(0, 10)})`;
  }
}

let shared: AbiSnapshot | undefined;

/** Process-wide snapshot instance (the data is immutable, so one is enough). */
export function bundledAbiSnapshot(): AbiSnapshot {
  return (shared ??= new AbiSnapshot());
}
