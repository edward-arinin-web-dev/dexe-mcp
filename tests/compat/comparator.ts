/**
 * Calldata Comparison Engine
 *
 * Compares two hex calldata strings:
 * 1. Byte-level hex diff (finds exact offset of first divergence)
 * 2. ABI-decoded field-by-field diff (using the deployGovPool ABI)
 * 3. Generates a markdown report
 *
 * Can be run as a standalone script:
 *   npx tsx tests/compat/comparator.ts <frontendHex> <mcpHex>
 *
 * Or imported as a module by the orchestrator.
 */

import { Interface, AbiCoder } from "ethers";

// ─── ABI ────────────────────────────────────────────────────────────────────

const DEPLOY_GOV_POOL_ABI = [
  "function deployGovPool(tuple(tuple(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] proposalSettings, address[] additionalProposalExecutors) settingsParams, tuple(string name, string symbol, tuple(uint64 duration, uint64 executionDelay, uint128 quorum) proposalSettings, address[] validators, uint256[] balances) validatorsParams, tuple(address tokenAddress, address nftAddress, uint256 individualPower, uint256 nftsTotalSupply) userKeeperParams, tuple(string name, string symbol, address[] users, uint256 cap, uint256 mintedTotal, uint256[] amounts) tokenParams, tuple(uint8 voteType, bytes initData, address presetAddress) votePowerParams, address verifier, bool onlyBABTHolders, string descriptionURL, string name) parameters) returns (address)",
];

const iface = new Interface(DEPLOY_GOV_POOL_ABI);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HexDiffResult {
  match: boolean;
  firstDiffByte: number | null;
  lengthA: number;
  lengthB: number;
  diffContext: string | null; // 32 bytes around the diff point
}

export interface FieldDiff {
  path: string;
  frontendValue: string;
  mcpValue: string;
}

export interface ComparisonReport {
  fixtureId: string;
  timestamp: string;
  verdict: "PASS" | "FAIL" | "ERROR";
  hexDiff: HexDiffResult;
  fieldDiffs: FieldDiff[];
  decodedFrontend: Record<string, unknown> | null;
  decodedMcp: Record<string, unknown> | null;
  error: string | null;
}

// ─── Hex-level comparison ───────────────────────────────────────────────────

export function compareHex(a: string, b: string): HexDiffResult {
  // Normalize
  const hexA = a.toLowerCase().replace(/^0x/, "");
  const hexB = b.toLowerCase().replace(/^0x/, "");

  if (hexA === hexB) {
    return {
      match: true,
      firstDiffByte: null,
      lengthA: hexA.length / 2,
      lengthB: hexB.length / 2,
      diffContext: null,
    };
  }

  // Find first diff
  const minLen = Math.min(hexA.length, hexB.length);
  let firstDiffChar = -1;
  for (let i = 0; i < minLen; i++) {
    if (hexA[i] !== hexB[i]) {
      firstDiffChar = i;
      break;
    }
  }
  if (firstDiffChar === -1) firstDiffChar = minLen; // length mismatch

  const firstDiffByte = Math.floor(firstDiffChar / 2);

  // Context: 32 bytes before and after the diff point
  const contextStart = Math.max(0, firstDiffByte - 32);
  const contextEnd = Math.min(Math.max(hexA.length, hexB.length) / 2, firstDiffByte + 32);
  const contextA = hexA.slice(contextStart * 2, contextEnd * 2);
  const contextB = hexB.slice(contextStart * 2, contextEnd * 2);

  return {
    match: false,
    firstDiffByte,
    lengthA: hexA.length / 2,
    lengthB: hexB.length / 2,
    diffContext: `byte ${firstDiffByte} (offset from start)\n  A: ...${contextA}...\n  B: ...${contextB}...`,
  };
}

// ─── ABI decode + field diff ────────────────────────────────────────────────

function decodeCalldata(hex: string): Record<string, unknown> | null {
  try {
    const decoded = iface.decodeFunctionData("deployGovPool", hex);
    return serializeDecoded(decoded);
  } catch (e) {
    return null;
  }
}

/**
 * Recursively serialize ethers Result into plain objects.
 * BigInts → strings, arrays → arrays, nested Results → objects.
 */
function serializeDecoded(val: unknown): any {
  if (val === null || val === undefined) return val;
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "boolean" || typeof val === "string" || typeof val === "number") return val;

  // ethers Result objects have numeric keys + named keys
  if (Array.isArray(val) || (typeof val === "object" && "toArray" in (val as any))) {
    const arr = Array.isArray(val) ? val : (val as any).toArray();

    // Check if it's a struct (has named keys beyond numeric indices)
    // ethers Result has a .toObject() method for structs
    if (typeof (val as any).toObject === "function") {
      const obj = (val as any).toObject();
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = serializeDecoded(v);
      }
      return result;
    }

    return arr.map((item: unknown) => serializeDecoded(item));
  }

  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (/^\d+$/.test(k)) continue; // skip numeric keys
      result[k] = serializeDecoded(v);
    }
    return result;
  }

  return String(val);
}

/**
 * Deep-diff two objects, returning a list of differing field paths.
 */
export function deepDiff(
  a: unknown,
  b: unknown,
  path = "",
): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  if (a === b) return diffs;

  // Both primitives
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (String(a) !== String(b)) {
      diffs.push({
        path: path || "(root)",
        frontendValue: String(a),
        mcpValue: String(b),
      });
    }
    return diffs;
  }

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    if (a.length !== b.length) {
      diffs.push({
        path: `${path}.length`,
        frontendValue: String(a.length),
        mcpValue: String(b.length),
      });
    }
    for (let i = 0; i < maxLen; i++) {
      diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    }
    return diffs;
  }

  // Both objects
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  const allKeys = new Set([...keysA, ...keysB]);

  for (const key of allKeys) {
    const valA = (a as Record<string, unknown>)[key];
    const valB = (b as Record<string, unknown>)[key];
    diffs.push(...deepDiff(valA, valB, path ? `${path}.${key}` : key));
  }

  return diffs;
}

// ─── Main comparison ────────────────────────────────────────────────────────

export function compare(
  frontendHex: string,
  mcpHex: string,
  fixtureId = "unknown",
): ComparisonReport {
  const hexDiff = compareHex(frontendHex, mcpHex);

  let decodedFrontend: Record<string, unknown> | null = null;
  let decodedMcp: Record<string, unknown> | null = null;
  let fieldDiffs: FieldDiff[] = [];
  let error: string | null = null;

  try {
    decodedFrontend = decodeCalldata(frontendHex);
    decodedMcp = decodeCalldata(mcpHex);

    if (decodedFrontend && decodedMcp) {
      fieldDiffs = deepDiff(decodedFrontend, decodedMcp, "parameters");
    } else {
      if (!decodedFrontend) error = "Failed to ABI-decode frontend calldata";
      if (!decodedMcp) error = (error ? error + "; " : "") + "Failed to ABI-decode MCP calldata";
    }
  } catch (e: unknown) {
    error = `ABI decode error: ${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    fixtureId,
    timestamp: new Date().toISOString(),
    verdict: hexDiff.match ? "PASS" : "FAIL",
    hexDiff,
    fieldDiffs,
    decodedFrontend,
    decodedMcp,
    error,
  };
}

// ─── Markdown report generator ──────────────────────────────────────────────

export function toMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];

  lines.push(`# Compatibility Report: ${report.fixtureId}`);
  lines.push("");
  lines.push(`**Timestamp:** ${report.timestamp}`);
  lines.push(`**Verdict:** ${report.verdict === "PASS" ? "PASS ✅" : "FAIL ❌"}`);
  lines.push("");

  // Hex diff summary
  lines.push("## Hex-Level Comparison");
  lines.push("");
  if (report.hexDiff.match) {
    lines.push("Calldata matches byte-for-byte.");
  } else {
    lines.push(`Frontend calldata length: ${report.hexDiff.lengthA} bytes`);
    lines.push(`MCP calldata length: ${report.hexDiff.lengthB} bytes`);
    lines.push(`First difference at byte: ${report.hexDiff.firstDiffByte}`);
    if (report.hexDiff.diffContext) {
      lines.push("");
      lines.push("```");
      lines.push(report.hexDiff.diffContext);
      lines.push("```");
    }
  }
  lines.push("");

  // Field diffs
  if (report.fieldDiffs.length > 0) {
    lines.push("## Field-Level Differences");
    lines.push("");
    lines.push("| Field Path | Frontend | MCP |");
    lines.push("|---|---|---|");
    for (const d of report.fieldDiffs) {
      const fv = d.frontendValue.length > 60 ? d.frontendValue.slice(0, 57) + "..." : d.frontendValue;
      const mv = d.mcpValue.length > 60 ? d.mcpValue.slice(0, 57) + "..." : d.mcpValue;
      lines.push(`| \`${d.path}\` | \`${fv}\` | \`${mv}\` |`);
    }
    lines.push("");
  }

  // Errors
  if (report.error) {
    lines.push("## Errors");
    lines.push("");
    lines.push("```");
    lines.push(report.error);
    lines.push("```");
    lines.push("");
  }

  // Full decoded (collapsed for readability)
  if (report.verdict === "FAIL" && (report.decodedFrontend || report.decodedMcp)) {
    lines.push("## Decoded Calldata");
    lines.push("");
    lines.push("<details><summary>Frontend (decoded)</summary>");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(report.decodedFrontend, null, 2));
    lines.push("```");
    lines.push("</details>");
    lines.push("");
    lines.push("<details><summary>MCP (decoded)</summary>");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(report.decodedMcp, null, 2));
    lines.push("```");
    lines.push("</details>");
  }

  return lines.join("\n");
}

// ─── CLI entry point ────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("comparator.ts") || process.argv[1]?.endsWith("comparator.js")) {
  const [, , frontendHex, mcpHex, fixtureId] = process.argv;
  if (!frontendHex || !mcpHex) {
    console.error("Usage: npx tsx tests/compat/comparator.ts <frontendHex> <mcpHex> [fixtureId]");
    process.exit(1);
  }
  const report = compare(frontendHex, mcpHex, fixtureId || "cli");
  console.log(toMarkdown(report));
  process.exit(report.verdict === "PASS" ? 0 : 1);
}
