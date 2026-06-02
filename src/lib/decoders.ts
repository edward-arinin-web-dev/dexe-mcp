import { Interface, type Result } from "ethers";
import type { Artifacts } from "../artifacts.js";
import type { SelectorIndex } from "./selectors.js";
import { findForbiddenSelector } from "./dangerousSelectors.js";

export interface DecodedCall {
  /** Which contract's ABI produced this decode. May be `null` if we used a bare selector match. */
  contract: string | null;
  sourceName: string | null;
  signature: string;
  selector: string;
  /** Arguments as a plain object keyed by parameter name (falls back to positional `arg_0` keys). */
  args: Record<string, unknown>;
  /** Raw positional args — useful for agents that want the tuple directly. */
  argsArray: unknown[];
  /** True if this selector is a C-2-class privileged accounting function. */
  privileged?: boolean;
  /**
   * Calls discovered inside this call's calldata args — e.g. the inner calls of
   * a `multicall(bytes[])`, or the actions of a nested `createProposal`. Lets a
   * reviewer see hidden privileged calls instead of just the wrapper (C-1).
   */
  nested?: DecodedCall[];
}

export interface DecodedProposalAction {
  side: "for" | "against";
  executor: string;
  value: string; // stringified BigInt for JSON safety
  data: string;
  /** Decoded call against the executor's ABI. `null` if we couldn't match. */
  decoded: DecodedCall | null;
}

export class CalldataDecoder {
  constructor(
    private readonly artifacts: Artifacts,
    private readonly selectors: SelectorIndex,
  ) {}

  /**
   * Decode raw calldata. If `contractName` is given, only that contract's ABI
   * is tried. Otherwise every artifact whose selector matches is tried in
   * turn; the first successful parse wins (with alternatives in `.alternatives`).
   */
  static readonly MAX_NEST_DEPTH = 4;

  /**
   * Decode calldata and recursively unwrap any well-formed nested calldata
   * found in its arguments — `multicall(bytes[])`, a nested `createProposal`'s
   * `ProposalAction[]`, `tryExecute`, etc. The decoded `primary` carries a
   * `privileged` flag for C-2-class selectors and a `nested` tree so a reviewer
   * reading the text sees hidden inner calls, not just the wrapper (C-1).
   */
  decodeCalldata(
    data: string,
    contractName?: string,
  ): { primary: DecodedCall | null; alternatives: DecodedCall[] } {
    return this.decodeEnriched(data, contractName, 0);
  }

  private decodeEnriched(
    data: string,
    contractName: string | undefined,
    depth: number,
  ): { primary: DecodedCall | null; alternatives: DecodedCall[] } {
    const res = this.decodeOnce(data, contractName);
    if (res.primary) {
      res.primary.privileged = findForbiddenSelector(res.primary.selector) != null;
      if (depth < CalldataDecoder.MAX_NEST_DEPTH) {
        const nested: DecodedCall[] = [];
        this.collectNested(res.primary.argsArray, depth + 1, nested);
        if (nested.length > 0) res.primary.nested = nested;
      }
    }
    return res;
  }

  /** Walk decoded args; recurse into any value that is itself well-formed calldata. */
  private collectNested(value: unknown, depth: number, out: DecodedCall[]): void {
    if (typeof value === "string") {
      if (looksLikeCalldata(value)) {
        const r = this.decodeEnriched(value, undefined, depth);
        if (r.primary) out.push(r.primary);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const el of value) this.collectNested(el, depth, out);
    }
  }

  private decodeOnce(
    data: string,
    contractName?: string,
  ): { primary: DecodedCall | null; alternatives: DecodedCall[] } {
    if (!data || data.length < 10 || !data.startsWith("0x")) {
      return { primary: null, alternatives: [] };
    }
    const selector = data.slice(0, 10).toLowerCase();

    if (contractName) {
      const record = this.artifacts.get(contractName)[0];
      if (!record) return { primary: null, alternatives: [] };
      const hit = tryDecodeWith(record.abi, data);
      if (hit) {
        return {
          primary: {
            contract: record.contractName,
            sourceName: record.sourceName,
            ...hit,
          },
          alternatives: [],
        };
      }
      return { primary: null, alternatives: [] };
    }

    const candidates = this.selectors.find(selector).filter((h) => h.kind === "function");
    const decoded: DecodedCall[] = [];
    const seen = new Set<string>();
    for (const cand of candidates) {
      if (seen.has(cand.contract)) continue;
      seen.add(cand.contract);
      const records = this.artifacts.get(cand.contract);
      for (const r of records) {
        const hit = tryDecodeWith(r.abi, data);
        if (hit) {
          decoded.push({ contract: r.contractName, sourceName: r.sourceName, ...hit });
          break;
        }
      }
    }
    if (decoded.length === 0) {
      return { primary: null, alternatives: [] };
    }
    return { primary: decoded[0]!, alternatives: decoded.slice(1) };
  }

  /**
   * Given a ProposalAction tuple, find the executor contract and decode `data`
   * against its ABI. Strategy: try to find an artifact whose runtime bytecode
   * is "close enough" via name fallback — but in practice we can't easily
   * reverse-lookup an address to a contract type off-chain without an on-chain
   * probe. So instead we rely on the selector index: decode purely by selector
   * match across all loaded ABIs, which works for the DeXe proposal executors
   * because each one has distinct signatures.
   */
  decodeProposalAction(action: {
    executor: string;
    value: bigint;
    data: string;
    side: "for" | "against";
  }): DecodedProposalAction {
    const result = this.decodeCalldata(action.data);
    return {
      side: action.side,
      executor: action.executor,
      value: action.value.toString(),
      data: action.data,
      decoded: result.primary,
    };
  }
}

function tryDecodeWith(abi: readonly unknown[], data: string): Omit<DecodedCall, "contract" | "sourceName"> | null {
  let iface: Interface;
  try {
    iface = new Interface(abi as readonly unknown[] as ReadonlyArray<string>);
  } catch {
    return null;
  }
  try {
    const parsed = iface.parseTransaction({ data });
    if (!parsed) return null;
    return {
      signature: parsed.fragment.format("sighash"),
      selector: parsed.selector,
      args: resultToObject(parsed.args, parsed.fragment.inputs.map((i) => i.name)),
      argsArray: [...parsed.args].map(normalize),
    };
  } catch {
    return null;
  }
}

function resultToObject(result: Result, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < result.length; i++) {
    const key = names[i] && names[i] !== "" ? names[i]! : `arg_${i}`;
    out[key] = normalize(result[i]);
  }
  return out;
}

function normalize(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    // ethers Result is an array-like with named keys; treat as array for JSON safety.
    const asResult = v as Result;
    if (typeof asResult.toArray === "function") {
      return asResult.toArray().map(normalize);
    }
  }
  return v;
}

/**
 * Heuristic: does `v` look like ABI calldata (a 4-byte selector followed by
 * whole 32-byte words)? This filters out addresses (20 bytes), bytes32 hashes,
 * and arbitrary blobs, so recursion only follows real nested calls.
 */
function looksLikeCalldata(v: string): boolean {
  if (!/^0x[0-9a-fA-F]+$/.test(v)) return false;
  if (v.length < 10) return false; // need at least the 4-byte selector
  return (v.length - 10) % 64 === 0; // selector + N 32-byte words
}
