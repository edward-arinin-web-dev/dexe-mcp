import { Interface } from "ethers";
import type { Artifacts, ArtifactRecord } from "../artifacts.js";

export type SelectorKind = "function" | "event" | "error";

export interface SelectorHit {
  contract: string;
  sourceName: string;
  signature: string;
  selector: string; // 0x…: 4 bytes for function/error, 32 bytes for event topic
  kind: SelectorKind;
}

/**
 * Lazy, memoized selector index over all loaded contract artifacts.
 * Built on first query; invalidated when the underlying artifact cache is.
 * Supports collisions — the same 4-byte selector can appear in multiple contracts.
 */
export class SelectorIndex {
  private built = false;
  private byFunctionSelector = new Map<string, SelectorHit[]>();
  private byEventTopic = new Map<string, SelectorHit[]>();
  private byErrorSelector = new Map<string, SelectorHit[]>();
  private lastCacheStamp: unknown = null;

  constructor(private readonly artifacts: Artifacts) {}

  /** Build the index (idempotent). Called automatically by find/forContract. */
  private ensureBuilt(): void {
    // Tie rebuild to the artifacts list identity — invalidate() creates a new one.
    const stamp = this.artifacts.list();
    if (this.built && stamp === this.lastCacheStamp) return;

    this.byFunctionSelector.clear();
    this.byEventTopic.clear();
    this.byErrorSelector.clear();

    for (const record of stamp) {
      this.indexContract(record);
    }
    this.built = true;
    this.lastCacheStamp = stamp;
  }

  private indexContract(record: ArtifactRecord): void {
    let iface: Interface;
    try {
      iface = new Interface(record.abi as readonly unknown[] as ReadonlyArray<string>);
    } catch {
      return; // tolerate malformed ABIs
    }

    iface.forEachFunction((fn) => {
      const hit: SelectorHit = {
        contract: record.contractName,
        sourceName: record.sourceName,
        signature: fn.format("sighash"),
        selector: fn.selector,
        kind: "function",
      };
      push(this.byFunctionSelector, fn.selector, hit);
    });

    iface.forEachEvent((ev) => {
      const hit: SelectorHit = {
        contract: record.contractName,
        sourceName: record.sourceName,
        signature: ev.format("sighash"),
        selector: ev.topicHash,
        kind: "event",
      };
      push(this.byEventTopic, ev.topicHash, hit);
    });

    iface.forEachError((err) => {
      const hit: SelectorHit = {
        contract: record.contractName,
        sourceName: record.sourceName,
        signature: err.format("sighash"),
        selector: err.selector,
        kind: "error",
      };
      push(this.byErrorSelector, err.selector, hit);
    });
  }

  /** Look up a selector or event topic. Accepts function selector (4B), error selector (4B), or event topic (32B). */
  find(selector: string): SelectorHit[] {
    this.ensureBuilt();
    const s = selector.toLowerCase();
    return [
      ...(this.byFunctionSelector.get(s) ?? []),
      ...(this.byErrorSelector.get(s) ?? []),
      ...(this.byEventTopic.get(s) ?? []),
    ];
  }

  /** All selectors exposed by a single contract. */
  forContract(contractName: string): SelectorHit[] {
    this.ensureBuilt();
    const out: SelectorHit[] = [];
    for (const hits of this.byFunctionSelector.values()) {
      for (const h of hits) if (h.contract === contractName) out.push(h);
    }
    for (const hits of this.byEventTopic.values()) {
      for (const h of hits) if (h.contract === contractName) out.push(h);
    }
    for (const hits of this.byErrorSelector.values()) {
      for (const h of hits) if (h.contract === contractName) out.push(h);
    }
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const existing = m.get(k);
  if (existing) existing.push(v);
  else m.set(k, [v]);
}
