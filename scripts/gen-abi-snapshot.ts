/**
 * gen-abi-snapshot — writes src/abi/protocolSnapshot.generated.ts, the
 * ABI-only snapshot of the DeXe-Protocol contracts that dexe_decode_calldata
 * and dexe_decode_proposal use when no local Hardhat compile is present.
 *
 *   npm run gen:abi-snapshot -- --protocol <path>          # rewrite the snapshot
 *   npm run gen:abi-snapshot:check -- --protocol <path>    # exit 1 if it is stale
 *
 * <path> is a DeXe-Protocol checkout that has been compiled (`npm run compile`
 * there, or dexe_compile). Without --protocol: DEXE_PROTOCOL_PATH, then the
 * auto-managed clone, the same resolution the server uses.
 *
 * Which contracts go in (the compiled flow decodes against every artifact under
 * artifacts/contracts/, so the snapshot takes that set minus what is never a
 * call target or only repeats another ABI):
 *   - every artifact under artifacts/contracts/, EXCEPT
 *       contracts/mock/**        test doubles
 *       contracts/interfaces/**  re-declared by the implementations
 *       contracts/libs/**        linked libraries, never a call target
 *       abstract contracts       (bytecode "0x"), re-declared by the concrete ones
 *   - plus OpenZeppelin ERC20 and ERC721 from the same compile: treasury
 *     proposals call transfer / transferFrom on arbitrary third-party tokens;
 *   - plus ISBT721 (BABT), an external contract the protocol integrates and
 *     only has the interface of.
 *
 * Guards (the script refuses to write when one fails):
 *   - an excluded interface or abstract contract declares a function selector
 *     no included contract has (the decoder would lose it);
 *   - a contract's source in the Hardhat build-info differs from the file on
 *     disk (the artifacts are stale: recompile first);
 *   - tracked files under contracts/ are modified (pass --allow-dirty to
 *     override; the snapshot then no longer matches the recorded commit).
 *
 * Only `contractName`, `sourceName` and `abi` are kept. No bytecode.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Interface } from "ethers";
import { resolveProtocolPath } from "../src/bootstrap.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(root, "src", "abi", "protocolSnapshot.generated.ts");
const REPOSITORY = "https://github.com/dexe-network/DeXe-Protocol";

const EXCLUDED_PREFIXES = ["contracts/mock/", "contracts/interfaces/", "contracts/libs/"];
/** Excluded for redundancy, so their selectors must be covered by what is kept. */
const MUST_BE_COVERED_PREFIXES = ["contracts/interfaces/"];

/** Third-party ABIs taken from the same compile, relative to artifacts/. */
const EXTRA_ARTIFACTS = [
  "@openzeppelin/contracts/token/ERC20/ERC20.sol/ERC20.json",
  "@openzeppelin/contracts/token/ERC721/ERC721.sol/ERC721.json",
  // BABT (Binance Account Bound Token): an external contract every GovPool
  // reports in getNftContracts().babt. The protocol only has its interface.
  "contracts/interfaces/core/ISBT721.sol/ISBT721.json",
];

interface RawArtifact {
  contractName?: string;
  sourceName?: string;
  abi?: unknown[];
  bytecode?: string;
}

interface Picked {
  contractName: string;
  sourceName: string;
  abi: unknown[];
  artifactPath: string;
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(msg: string): never {
  process.stderr.write(`gen-abi-snapshot: ${msg}\n`);
  process.exit(1);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
      yield full;
    }
  }
}

function readArtifact(path: string): RawArtifact {
  return JSON.parse(readFileSync(path, "utf8")) as RawArtifact;
}

function functionSelectors(abi: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  new Interface(abi as never).forEachFunction((f) => out.set(f.selector, f.format("sighash")));
  return out;
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");

// ---------- inputs ----------

const protocol = resolve(arg("protocol") ?? process.env.DEXE_PROTOCOL_PATH ?? resolveProtocolPath());
const artifactsDir = join(protocol, "artifacts");
const contractsDir = join(artifactsDir, "contracts");
if (!existsSync(contractsDir)) {
  fail(
    `no compiled artifacts at ${contractsDir}. Compile the DeXe-Protocol checkout first ` +
      "(`npm run compile` in it), or pass --protocol <path to a compiled checkout>.",
  );
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", protocol, ...args], { encoding: "utf8" }).trim();
}

let commit = arg("commit");
if (!commit) {
  try {
    commit = git("rev-parse", "HEAD");
  } catch {
    fail(`${protocol} is not a git checkout. Pass --commit <sha> to record which commit it is.`);
  }
  const dirty = git("status", "--porcelain", "--untracked-files=no", "--", "contracts");
  if (dirty && !flag("allow-dirty")) {
    fail(`tracked files under ${protocol}/contracts are modified:\n${dirty}\nCommit or revert them, or pass --allow-dirty.`);
  }
}
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`commit "${commit}" is not a 40-hex git sha.`);

const ozPkg = join(protocol, "node_modules", "@openzeppelin", "contracts", "package.json");
const openzeppelinVersion = existsSync(ozPkg)
  ? (JSON.parse(readFileSync(ozPkg, "utf8")) as { version: string }).version
  : fail(`missing ${ozPkg}: run \`npm install\` in the protocol checkout.`);

// ---------- selection ----------

const included: Picked[] = [];
const coverageOnly: Picked[] = [];
for (const file of walk(contractsDir)) {
  const a = readArtifact(file);
  if (!a.contractName || !a.sourceName || !Array.isArray(a.abi)) continue;
  const picked = { contractName: a.contractName, sourceName: a.sourceName, abi: a.abi, artifactPath: file };
  const excludedDir = EXCLUDED_PREFIXES.some((p) => a.sourceName!.startsWith(p));
  const isAbstract = (a.bytecode ?? "0x") === "0x";
  if (excludedDir || isAbstract) {
    if (isAbstract || MUST_BE_COVERED_PREFIXES.some((p) => a.sourceName!.startsWith(p))) {
      coverageOnly.push(picked);
    }
    continue;
  }
  included.push(picked);
}
for (const rel of EXTRA_ARTIFACTS) {
  const file = join(artifactsDir, ...rel.split("/"));
  if (!existsSync(file)) fail(`missing ${file}: the compile output has no ${rel}.`);
  const a = readArtifact(file);
  if (!a.contractName || !a.sourceName || !Array.isArray(a.abi)) fail(`${file} is not a Hardhat artifact.`);
  included.push({ contractName: a.contractName, sourceName: a.sourceName, abi: a.abi, artifactPath: file });
}
// Code-point order, not localeCompare: the output must not depend on the ICU
// build of whichever machine regenerates it. "@openzeppelin/..." sorts first, so
// a bare transfer/transferFrom decodes as ERC20/ERC721 (the treasury case) with
// the ERC20Gov / NFT variants listed as alternatives.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
included.sort(
  (x, y) => byCodePoint(x.sourceName, y.sourceName) || byCodePoint(x.contractName, y.contractName),
);

// ---------- guards ----------

const covered = new Set<string>();
for (const c of included) {
  for (const sel of functionSelectors(c.abi).keys()) covered.add(sel);
}
const lost: string[] = [];
for (const c of coverageOnly) {
  for (const [sel, sig] of functionSelectors(c.abi)) {
    if (!covered.has(sel)) lost.push(`${c.contractName}.${sig} (${sel})`);
  }
}
if (lost.length > 0) {
  fail(
    `excluded interfaces/abstract contracts declare functions no included contract has:\n  ${lost.join("\n  ")}\n` +
      "Include the contract that implements them (or the interface itself) in the selection.",
  );
}

/** Each artifact's source must be the file on disk, byte for byte (modulo CRLF). */
const buildInfoCache = new Map<string, { solcVersion: string; sources: Record<string, { content: string }> }>();
const solcVersions = new Set<string>();
for (const c of included) {
  const dbgPath = c.artifactPath.replace(/\.json$/, ".dbg.json");
  const dbg = JSON.parse(readFileSync(dbgPath, "utf8")) as { buildInfo: string };
  const biPath = resolve(dirname(dbgPath), ...dbg.buildInfo.split(/[\\/]/));
  let bi = buildInfoCache.get(biPath);
  if (!bi) {
    const parsed = JSON.parse(readFileSync(biPath, "utf8")) as {
      solcVersion: string;
      input: { sources: Record<string, { content: string }> };
    };
    bi = { solcVersion: parsed.solcVersion, sources: parsed.input.sources };
    buildInfoCache.set(biPath, bi);
  }
  solcVersions.add(bi.solcVersion);
  if (c.sourceName.startsWith("contracts/")) {
    const onDisk = join(protocol, ...c.sourceName.split("/"));
    const compiled = bi.sources[c.sourceName]?.content;
    if (compiled === undefined) fail(`${c.sourceName} is not in its build-info ${biPath}.`);
    if (!existsSync(onDisk)) fail(`${c.sourceName} has an artifact but no source file: recompile (stale artifacts).`);
    if (lf(compiled) !== lf(readFileSync(onDisk, "utf8"))) {
      fail(`${c.sourceName} changed since it was compiled: recompile the protocol before generating.`);
    }
  }
}
if (solcVersions.size !== 1) fail(`artifacts come from several solc versions: ${[...solcVersions].join(", ")}.`);
const solcVersion = [...solcVersions][0]!;

// ---------- emit ----------

// The data is JSON text inside String.raw, parsed once on first use: tsc and
// esbuild emit a template literal verbatim (an object literal this size came
// out 15% larger, with a source map as big as the code), and JSON.parse is the
// fastest way for V8 to build it. One ABI entry per line keeps diffs readable.
const meta = { repository: REPOSITORY, commit, solcVersion, openzeppelinContracts: openzeppelinVersion };
const contractsJson = included.map((c) =>
  [
    "    {",
    `      "contractName": ${JSON.stringify(c.contractName)},`,
    `      "sourceName": ${JSON.stringify(c.sourceName)},`,
    '      "abi": [',
    c.abi.map((item) => `        ${JSON.stringify(item)}`).join(",\n"),
    "      ]",
    "    }",
  ].join("\n"),
);
const json = ["{", `  "protocol": ${JSON.stringify(meta)},`, '  "contracts": [', contractsJson.join(",\n"), "  ]", "}"].join(
  "\n",
);
// A backtick or `${` would end or interpolate the template; a backslash would
// survive String.raw but is not something an ABI should contain either.
if (/[`\\]|\$\{/.test(json)) fail("ABI JSON contains a backtick, backslash or ${, which the String.raw wrapper cannot hold.");
JSON.parse(json); // must round-trip

const output = [
  "// GENERATED by scripts/gen-abi-snapshot.ts. Do not edit by hand.",
  `// ABI-only snapshot of ${REPOSITORY} at ${commit}`,
  `// (solc ${solcVersion}, @openzeppelin/contracts ${openzeppelinVersion}): ${included.length} contracts, no bytecode.`,
  "// Regenerate: npm run gen:abi-snapshot -- --protocol <compiled DeXe-Protocol checkout>",
  "",
  "/** JSON text of an `AbiSnapshotData` (src/lib/abiSnapshot.ts parses it on first use). */",
  `export const PROTOCOL_ABI_SNAPSHOT_JSON = String.raw\`${json}\`;`,
  "",
].join("\n");

const summary =
  `${included.length} contracts from ${protocol} @ ${commit.slice(0, 10)} ` +
  `(solc ${solcVersion}, OZ ${openzeppelinVersion}), ${(Buffer.byteLength(output) / 1024).toFixed(1)} KiB`;

if (flag("check")) {
  const existing = existsSync(OUT) ? lf(readFileSync(OUT, "utf8")) : "";
  if (existing !== output) {
    fail(`src/abi/protocolSnapshot.generated.ts is out of date (${summary}). Run \`npm run gen:abi-snapshot\`.`);
  }
  console.log(`gen-abi-snapshot: up to date: ${summary}`);
} else {
  writeFileSync(OUT, output);
  console.log(`gen-abi-snapshot: wrote src/abi/protocolSnapshot.generated.ts: ${summary}`);
  for (const c of included) console.log(`  ${c.sourceName}:${c.contractName}`);
}
