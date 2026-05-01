// Frontend ↔ MCP byte-diff runner for OTC token-sale calldata.
//
// For each fixture in tests/compat/fixtures/otc-frontend-*.json:
//   1. Load `input` and `expected.actions[]`.
//   2. Call `buildTokenSaleMultiActions(input)` from compiled `dist/`.
//   3. Byte-compare each `actions[i].data` (and length).
//   4. On mismatch, ABI-decode both sides via `Interface.parseTransaction` and
//      print a field-level diff.
//
// Exit 0 = all green; exit 1 = at least one fixture diverged.
//
// Usage: `npm run test:compat`  or  `node tests/compat/diff-otc.mjs`

import { Interface, getAddress } from "ethers";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const fixDir = path.join(__dirname, "fixtures");

const helperPath = path.join(repoRoot, "dist/tools/proposalBuildComplex.js");
if (!fs.existsSync(helperPath)) {
  console.error(
    `dist not built — run \`npm run build\` first (looking for ${helperPath}).`,
  );
  process.exit(1);
}
const helper = await import(
  "file:///" + helperPath.replace(/\\/g, "/")
);

const TSP_SIG = [
  "function createTiers(tuple(tuple(string name, string description) metadata, uint256 totalTokenProvided, uint64 saleStartTime, uint64 saleEndTime, uint64 claimLockDuration, address saleTokenAddress, address[] purchaseTokenAddresses, uint256[] exchangeRates, uint256 minAllocationPerUser, uint256 maxAllocationPerUser, tuple(uint256 vestingPercentage, uint64 vestingDuration, uint64 cliffPeriod, uint64 unlockStep) vestingSettings, tuple(uint8 participationType, bytes data)[] participationDetails)[] tiers)",
  "function addToWhitelist(tuple(uint256 tierId, address[] users, string uri)[] requests)",
];
const ERC20_SIG = ["function approve(address spender, uint256 amount) returns (bool)"];
const tspIface = new Interface(TSP_SIG);
const ercIface = new Interface(ERC20_SIG);

function tryDecode(data) {
  for (const iface of [tspIface, ercIface]) {
    try {
      const parsed = iface.parseTransaction({ data });
      if (parsed) return { name: parsed.name, args: parsed.args };
    } catch {
      /* not this iface */
    }
  }
  return null;
}

function jsonish(v, depth = 0) {
  if (depth > 6) return "…";
  if (v === null || v === undefined) return String(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map((x) => jsonish(x, depth + 1)).join(", ") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).filter((k) => isNaN(Number(k)));
    if (keys.length === 0) return jsonish(Array.from(v), depth + 1);
    return (
      "{" + keys.map((k) => `${k}: ${jsonish(v[k], depth + 1)}`).join(", ") + "}"
    );
  }
  return String(v);
}

function fieldDiff(name, expArgs, gotArgs, indent = "    ") {
  const ek = Object.keys(expArgs).filter((k) => isNaN(Number(k)));
  const gk = Object.keys(gotArgs).filter((k) => isNaN(Number(k)));
  const all = Array.from(new Set([...ek, ...gk]));
  if (all.length === 0) {
    // positional
    const len = Math.max(expArgs.length ?? 0, gotArgs.length ?? 0);
    for (let i = 0; i < len; i++) {
      const e = jsonish(expArgs[i]);
      const g = jsonish(gotArgs[i]);
      const mark = e === g ? "  " : "≠ ";
      console.log(`${indent}${mark}arg[${i}]  expected=${e}`);
      if (e !== g) console.log(`${indent}        got      =${g}`);
    }
    return;
  }
  for (const k of all) {
    const e = jsonish(expArgs[k]);
    const g = jsonish(gotArgs[k]);
    const mark = e === g ? "  " : "≠ ";
    console.log(`${indent}${mark}${k}:`);
    console.log(`${indent}    expected=${e}`);
    if (e !== g) console.log(`${indent}    got     =${g}`);
  }
}

function compareAction(label, expected, got) {
  const dataMatch = expected.data === got.data;
  const valueMatch = String(expected.value) === String(got.value);
  let executorMatch = true;
  try {
    executorMatch =
      getAddress(expected.executor) === getAddress(got.executor);
  } catch {
    executorMatch = expected.executor === got.executor;
  }
  if (dataMatch && valueMatch && executorMatch) {
    console.log(`  OK   ${label} (data=${expected.data.slice(0, 10)}…)`);
    return true;
  }
  console.log(`  FAIL ${label}`);
  if (!executorMatch)
    console.log(`     executor: expected=${expected.executor}  got=${got.executor}`);
  if (!valueMatch)
    console.log(`     value:    expected=${expected.value}     got=${got.value}`);
  if (!dataMatch) {
    console.log(`     data: BYTE DIVERGENCE`);
    console.log(`       expected: ${expected.data}`);
    console.log(`       got     : ${got.data}`);
    const ed = tryDecode(expected.data);
    const gd = tryDecode(got.data);
    if (ed && gd) {
      console.log(`     ABI-decoded fn: expected=${ed.name}  got=${gd.name}`);
      if (ed.name === gd.name) {
        fieldDiff(ed.name, ed.args, gd.args);
      }
    } else {
      console.log(`     (could not ABI-decode one or both sides)`);
    }
  }
  return false;
}

function loadFixtures() {
  if (!fs.existsSync(fixDir)) {
    console.error(`No fixture directory at ${fixDir}`);
    process.exit(1);
  }
  return fs
    .readdirSync(fixDir)
    .filter((f) => f.startsWith("otc-frontend-") && f.endsWith(".json"))
    .sort()
    .map((f) => ({
      file: f,
      path: path.join(fixDir, f),
      data: JSON.parse(fs.readFileSync(path.join(fixDir, f), "utf8")),
    }));
}

const fixtures = loadFixtures();
if (fixtures.length === 0) {
  console.error("No otc-frontend-*.json fixtures found.");
  process.exit(1);
}

console.log(`Running OTC frontend↔MCP byte-diff against ${fixtures.length} fixture(s):\n`);
let allOk = true;
for (const fx of fixtures) {
  const { input, expected, captureMethod } = fx.data;
  console.log(`▸ ${fx.file}  [${captureMethod}]`);
  let built;
  try {
    built = helper.buildTokenSaleMultiActions(input);
  } catch (e) {
    console.log(`  FAIL build threw: ${e instanceof Error ? e.message : String(e)}`);
    allOk = false;
    continue;
  }
  const got = built.actions;
  const exp = expected.actions;
  if (got.length !== exp.length) {
    console.log(
      `  FAIL action count: expected=${exp.length} got=${got.length}`,
    );
    allOk = false;
    continue;
  }
  let fixOk = true;
  for (let i = 0; i < exp.length; i++) {
    const decoded = tryDecode(exp[i].data);
    const label = `actions[${i}] (${decoded ? decoded.name : "unknown"})`;
    const match = compareAction(label, exp[i], got[i]);
    if (!match) fixOk = false;
  }
  // Also round-trip canonicalize: both sides decode cleanly.
  for (let i = 0; i < got.length; i++) {
    if (!tryDecode(got[i].data)) {
      console.log(
        `  FAIL actions[${i}] not decodable via TokenSaleProposal/ERC20 ABI`,
      );
      fixOk = false;
    }
  }
  if (fixOk) console.log("  ✓ all actions byte-equal + ABI round-trip");
  else allOk = false;
  console.log();
}

if (!allOk) {
  console.error(
    "Frontend↔MCP calldata diverged. Either the helper drifted, the contract " +
      "ABI changed, or the fixtures are stale (regen via " +
      "`node tests/compat/gen-otc-fixtures.mjs` after verifying the synth still " +
      "mirrors the frontend hook — see tests/compat/CAPTURE.md).",
  );
  process.exit(1);
}
console.log("All fixtures byte-identical. ✓");
