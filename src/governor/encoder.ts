import { Interface, isAddress, keccak256, toUtf8Bytes } from "ethers";
import type { GovernorConfig } from "./loader.js";
import { isBravo } from "./adapter.js";

/**
 * Write-side ABI fragments per governor family. The exact selectors differ
 * between OZ v4+ and Bravo for propose / queue / execute, so build tools
 * MUST encode against the correct family. `castVote` and `castVoteWithReason`
 * share signatures across families.
 */

export const GOVERNOR_OZ_WRITE_ABI = [
  "function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)",
  "function castVote(uint256 proposalId, uint8 support) returns (uint256)",
  "function castVoteWithReason(uint256 proposalId, uint8 support, string reason) returns (uint256)",
  "function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)",
  "function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)",
  "function cancel(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)",
  "function hashProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) pure returns (uint256)",
] as const;

export const GOVERNOR_BRAVO_WRITE_ABI = [
  "function propose(address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, string description) returns (uint256)",
  "function castVote(uint256 proposalId, uint8 support)",
  "function castVoteWithReason(uint256 proposalId, uint8 support, string reason)",
  "function queue(uint256 proposalId)",
  "function execute(uint256 proposalId) payable",
  "function cancel(uint256 proposalId)",
] as const;

export const IVOTES_WRITE_ABI = [
  "function delegate(address delegatee)",
] as const;

export interface BuiltTx {
  to: string;
  value: string;
  data: string;
  selector: string;
  method: string;
  args: unknown;
  family: "oz" | "bravo";
}

function governorIface(cfg: GovernorConfig): Interface {
  return new Interface(
    (isBravo(cfg) ? GOVERNOR_BRAVO_WRITE_ABI : GOVERNOR_OZ_WRITE_ABI) as unknown as string[],
  );
}

function family(cfg: GovernorConfig): "oz" | "bravo" {
  return isBravo(cfg) ? "bravo" : "oz";
}

function selectorOf(iface: Interface, method: string): string {
  const fn = iface.getFunction(method);
  if (!fn) throw new Error(`encoder: method ${method} missing from ABI`);
  return fn.selector;
}

function ensureAddressArray(label: string, xs: unknown): string[] {
  if (!Array.isArray(xs)) throw new Error(`${label} must be an array`);
  for (const a of xs) if (typeof a !== "string" || !isAddress(a)) throw new Error(`${label} has invalid address: ${String(a)}`);
  return xs;
}

function ensureBytesArray(label: string, xs: unknown): string[] {
  if (!Array.isArray(xs)) throw new Error(`${label} must be an array`);
  for (const b of xs) {
    if (typeof b !== "string" || !/^0x([a-fA-F0-9]{2})*$/.test(b)) {
      throw new Error(`${label} has invalid 0x-prefixed hex: ${String(b)}`);
    }
  }
  return xs;
}

function ensureUintArray(label: string, xs: unknown): bigint[] {
  if (!Array.isArray(xs)) throw new Error(`${label} must be an array`);
  return xs.map((v, i) => {
    try {
      return BigInt(v as string | number | bigint);
    } catch {
      throw new Error(`${label}[${i}] is not a valid uint: ${String(v)}`);
    }
  });
}

function ensureStringArray(label: string, xs: unknown): string[] {
  if (!Array.isArray(xs)) throw new Error(`${label} must be an array`);
  for (const s of xs) if (typeof s !== "string") throw new Error(`${label} must be string[]`);
  return xs;
}

/** Upper bound on a proposal's action count. Guards the calldata builders
 * against pathological array sizes; well above any real governance proposal. */
export const MAX_ACTIONS = 50;

/**
 * Validates the OZ action tuple: equal lengths, non-empty (Governor reverts on
 * empty proposals), and within MAX_ACTIONS. Shared by propose/queue/execute/cancel
 * so every OZ path enforces the same shape.
 */
function ensureActionParity(
  label: string,
  targets: unknown[],
  values: unknown[],
  calldatas: unknown[],
): void {
  if (targets.length !== values.length || targets.length !== calldatas.length) {
    throw new Error(
      `${label}: target/value/calldata length mismatch (targets=${targets.length}, values=${values.length}, calldatas=${calldatas.length})`,
    );
  }
  if (targets.length === 0) throw new Error(`${label}: at least one action is required`);
  if (targets.length > MAX_ACTIONS) {
    throw new Error(`${label}: too many actions (${targets.length} > ${MAX_ACTIONS})`);
  }
}

export interface ProposeArgs {
  targets: string[];
  values: (string | number | bigint)[];
  calldatas: string[];
  description: string;
  /** Bravo only: per-target function signature strings (e.g. "transfer(address,uint256)"). Defaults to []. */
  signatures?: string[];
}

export function buildPropose(cfg: GovernorConfig, args: ProposeArgs): BuiltTx {
  const iface = governorIface(cfg);
  const targets = ensureAddressArray("targets", args.targets);
  const values = ensureUintArray("values", args.values);
  const calldatas = ensureBytesArray("calldatas", args.calldatas);
  if (typeof args.description !== "string") throw new Error("description must be a string");
  ensureActionParity("propose", targets, values, calldatas);
  let data: string;
  let argsOut: unknown;
  if (isBravo(cfg)) {
    const signatures = args.signatures
      ? ensureStringArray("signatures", args.signatures)
      : new Array(targets.length).fill("");
    if (signatures.length !== targets.length) {
      throw new Error(`bravo propose: signatures length ${signatures.length} != targets length ${targets.length}`);
    }
    data = iface.encodeFunctionData("propose", [targets, values, signatures, calldatas, args.description]);
    argsOut = { targets, values: values.map(String), signatures, calldatas, description: args.description };
  } else {
    data = iface.encodeFunctionData("propose", [targets, values, calldatas, args.description]);
    argsOut = { targets, values: values.map(String), calldatas, description: args.description };
  }
  return {
    to: cfg.governorAddress,
    value: "0",
    data,
    selector: data.slice(0, 10),
    method: "propose",
    args: argsOut,
    family: family(cfg),
  };
}

export type Support = 0 | 1 | 2; // 0=Against, 1=For, 2=Abstain (OZ + Bravo agree)

export function buildVoteCast(
  cfg: GovernorConfig,
  proposalId: string | bigint,
  support: Support,
  reason?: string,
): BuiltTx {
  if (![0, 1, 2].includes(support)) throw new Error(`support must be 0|1|2, got ${support}`);
  const iface = governorIface(cfg);
  const pid = BigInt(proposalId);
  const method = reason !== undefined ? "castVoteWithReason" : "castVote";
  const data = reason !== undefined
    ? iface.encodeFunctionData("castVoteWithReason", [pid, support, reason])
    : iface.encodeFunctionData("castVote", [pid, support]);
  return {
    to: cfg.governorAddress,
    value: "0",
    data,
    selector: data.slice(0, 10),
    method,
    args: reason !== undefined
      ? { proposalId: pid.toString(), support, reason }
      : { proposalId: pid.toString(), support },
    family: family(cfg),
  };
}

export interface QueueExecuteArgs {
  /** Bravo: proposalId. OZ: hash will be recomputed from the rest. */
  proposalId?: string | bigint;
  /** OZ only. */
  targets?: string[];
  /** OZ only. */
  values?: (string | number | bigint)[];
  /** OZ only. */
  calldatas?: string[];
  /** OZ only. Either the raw description (we hash it) or descriptionHash. */
  description?: string;
  descriptionHash?: string;
}

function computeDescHash(args: QueueExecuteArgs): string {
  if (args.descriptionHash) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.descriptionHash)) {
      throw new Error(`descriptionHash must be 32-byte hex; got ${args.descriptionHash}`);
    }
    return args.descriptionHash;
  }
  if (typeof args.description !== "string") {
    throw new Error("OZ queue/execute: either description or descriptionHash is required");
  }
  return keccak256(toUtf8Bytes(args.description));
}

export function buildQueue(cfg: GovernorConfig, args: QueueExecuteArgs): BuiltTx {
  const iface = governorIface(cfg);
  if (isBravo(cfg)) {
    if (args.proposalId === undefined) throw new Error("bravo queue: proposalId required");
    const pid = BigInt(args.proposalId);
    const data = iface.encodeFunctionData("queue", [pid]);
    return {
      to: cfg.governorAddress,
      value: "0",
      data,
      selector: data.slice(0, 10),
      method: "queue",
      args: { proposalId: pid.toString() },
      family: "bravo",
    };
  }
  const targets = ensureAddressArray("targets", args.targets);
  const values = ensureUintArray("values", args.values);
  const calldatas = ensureBytesArray("calldatas", args.calldatas);
  ensureActionParity("queue", targets, values, calldatas);
  const descriptionHash = computeDescHash(args);
  const data = iface.encodeFunctionData("queue", [targets, values, calldatas, descriptionHash]);
  return {
    to: cfg.governorAddress,
    value: "0",
    data,
    selector: data.slice(0, 10),
    method: "queue",
    args: { targets, values: values.map(String), calldatas, descriptionHash },
    family: "oz",
  };
}

export function buildExecute(cfg: GovernorConfig, args: QueueExecuteArgs, msgValue?: string | bigint): BuiltTx {
  const iface = governorIface(cfg);
  const value = msgValue === undefined ? "0" : BigInt(msgValue).toString();
  if (isBravo(cfg)) {
    if (args.proposalId === undefined) throw new Error("bravo execute: proposalId required");
    const pid = BigInt(args.proposalId);
    const data = iface.encodeFunctionData("execute", [pid]);
    return {
      to: cfg.governorAddress,
      value,
      data,
      selector: data.slice(0, 10),
      method: "execute",
      args: { proposalId: pid.toString() },
      family: "bravo",
    };
  }
  const targets = ensureAddressArray("targets", args.targets);
  const values = ensureUintArray("values", args.values);
  const calldatas = ensureBytesArray("calldatas", args.calldatas);
  ensureActionParity("execute", targets, values, calldatas);
  const descriptionHash = computeDescHash(args);
  const data = iface.encodeFunctionData("execute", [targets, values, calldatas, descriptionHash]);
  return {
    to: cfg.governorAddress,
    value,
    data,
    selector: data.slice(0, 10),
    method: "execute",
    args: { targets, values: values.map(String), calldatas, descriptionHash },
    family: "oz",
  };
}

export function buildCancel(cfg: GovernorConfig, args: QueueExecuteArgs): BuiltTx {
  const iface = governorIface(cfg);
  if (isBravo(cfg)) {
    if (args.proposalId === undefined) throw new Error("bravo cancel: proposalId required");
    const pid = BigInt(args.proposalId);
    const data = iface.encodeFunctionData("cancel", [pid]);
    return {
      to: cfg.governorAddress,
      value: "0",
      data,
      selector: data.slice(0, 10),
      method: "cancel",
      args: { proposalId: pid.toString() },
      family: "bravo",
    };
  }
  const targets = ensureAddressArray("targets", args.targets);
  const values = ensureUintArray("values", args.values);
  const calldatas = ensureBytesArray("calldatas", args.calldatas);
  ensureActionParity("cancel", targets, values, calldatas);
  const descriptionHash = computeDescHash(args);
  const data = iface.encodeFunctionData("cancel", [targets, values, calldatas, descriptionHash]);
  return {
    to: cfg.governorAddress,
    value: "0",
    data,
    selector: data.slice(0, 10),
    method: "cancel",
    args: { targets, values: values.map(String), calldatas, descriptionHash },
    family: "oz",
  };
}

export function buildDelegate(cfg: GovernorConfig, delegatee: string): BuiltTx {
  if (!isAddress(delegatee)) throw new Error(`delegate: invalid delegatee address ${delegatee}`);
  const iface = new Interface(IVOTES_WRITE_ABI as unknown as string[]);
  const data = iface.encodeFunctionData("delegate", [delegatee]);
  return {
    to: cfg.votingToken.address,
    value: "0",
    data,
    selector: data.slice(0, 10),
    method: "delegate",
    args: { delegatee },
    family: family(cfg),
  };
}

/**
 * Round-trip helper exposed for tests: decode calldata back into named args
 * for selector-validity + arg-roundtrip assertions.
 */
export function decodeGovernorWrite(cfg: GovernorConfig, data: string): { method: string; args: unknown[] } {
  const iface = governorIface(cfg);
  const decoded = iface.parseTransaction({ data });
  if (!decoded) throw new Error(`decodeGovernorWrite: could not parse calldata for ${cfg.id}`);
  return { method: decoded.name, args: decoded.args.toArray() };
}
