import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MODULE_CLASSES, type ModuleClass } from "./modules.js";

/**
 * The read/write edition boundary, enforced on the import graph.
 *
 * Walks every static import (value AND type-only — the read package has to
 * compile without the write files) plus literal dynamic `import("…")`, starting
 * from every read-side module (`read` + `mixed` in ./modules.ts). An edge from
 * the read side into a `write` or `root` module is a CROSSING. Today's
 * crossings are listed below, each with what removes it.
 *
 * The list is a ratchet in both directions:
 *   - a crossing that is not listed fails (no new write dependencies sneak
 *     into read code), and
 *   - a listed crossing that no longer exists fails too, so the list can only
 *     shrink, and shrinks in the same change that fixed it.
 *
 * Models tests/governor/isolation.test.ts, but follows the real graph instead
 * of grepping for forbidden paths.
 */

const REPO = resolve(__dirname, "..", "..");
const SRC = join(REPO, "src");

/**
 * Read-side → write-side imports that exist today. Key: "<from> -> <to>",
 * paths relative to src/. Value: why it exists and what removes it.
 */
const KNOWN_CROSSINGS: Readonly<Record<string, string>> = {
  "config.ts -> bootstrap.ts":
    "protocolPath resolution for the dev toolchain. Gone when config splits into a read config and a write config.",
  "governor/index.ts -> governor/tools/build.ts":
    "one register function for both editions' governor tools. Gone when governor/index.ts splits per edition.",
  "governor/tools/extras.ts -> governor/encoder.ts":
    "gov_build_cancel / gov_hash_* sit beside the read tools gov_get_state / gov_has_voted. Gone when extras.ts splits.",
  "governor/tools/simulate.ts -> governor/encoder.ts":
    "gov_simulate_proposal (write) sits beside gov_simulate_vote_impact (read). Gone when simulate.ts splits.",
  "instructions.ts -> lib/resumeContract.ts":
    "the handshake text carries the write resume rule. Gone when each edition gets its own instructions.",
  "knowledge/index.ts -> knowledge/flows.ts":
    "the guide engine is wired to the write flow corpus. Gone when the corpus becomes a parameter.",
  "knowledge/render.ts -> knowledge/flows.ts":
    "renders flows next to topics and gotchas. Gone when knowledge/ splits into read and write halves.",
  "lib/protocolAdvisories.ts -> lib/preflight.ts":
    "the upstream-advisory helpers the read side needs share a file with build-time advisories. Gone once they move.",
  "tools/context.ts -> hardhat.ts":
    "type-only: ToolContext carries the dev-toolchain runner. Gone when the read ToolContext drops `runner`.",
  "tools/getConfig.ts -> lib/signer.ts":
    "dexe_get_config reports signer mode. Gone when the signer half moves to a write-edition context tool.",
  "tools/guide.ts -> knowledge/nextSteps.ts":
    "dexe_guide follows the active write flow. Gone when activeFlow / nextAfter move to the write edition.",
  "tools/ipfs.ts -> lib/avatarImage.ts":
    "IPFS reads and uploads share one register file. Gone when tools/ipfs.ts splits into read and write files.",
  "tools/ipfs.ts -> lib/avatarUpload.ts":
    "IPFS reads and uploads share one register file. Gone when tools/ipfs.ts splits into read and write files.",
  "tools/ipfs.ts -> lib/imageSniff.ts":
    "IPFS reads and uploads share one register file. Gone when tools/ipfs.ts splits into read and write files.",
  "tools/ipfs.ts -> lib/markdownToSlate.ts":
    "IPFS reads and uploads share one register file. Gone when tools/ipfs.ts splits into read and write files.",
  "tools/operationalContext.ts -> lib/agentLedger.ts":
    "dexe_context reports the persona keyring. Gone when that moves to a write-edition context tool.",
  "tools/operationalContext.ts -> lib/signer.ts":
    "dexe_context reports signer mode and persona balances. Gone when that moves to a write-edition context tool.",
  "tools/otc.ts -> lib/calldata.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> lib/flowChain.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> lib/ipfsPreview.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> lib/signer.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> lib/walletconnect.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> tools/flow.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> tools/proposalBuildComplex.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
  "tools/otc.ts -> tools/simulate.ts":
    "dexe_otc_buyer_status shares a file with the OTC write composites. Gone when it moves to its own file.",
};

/**
 * Read-side files that write the local disk. The read edition is meant to run
 * as a shared server, so every local write on its side is listed here and
 * ratcheted the same way as the crossings.
 *
 * The first entry is the one that matters for annotations: dexe_dao_report is
 * annotated `readOnlyHint: true` (tests/boundary/edition-manifest.test.ts
 * checks that for every read tool) but persists a snapshot file.
 */
const KNOWN_DISK_WRITERS: Readonly<Record<string, string>> = {
  "tools/report.ts":
    "dexe_dao_report persists reports.json beside state.json as its diff baseline, while annotated read-only. " +
    "Gone when snapshot persistence becomes pluggable and off in the read edition.",
  "lib/stateStore.ts":
    "the state.json writer. Only write flows call it; read tools call getState / findKnownDao.",
  "cli/init.ts":
    "the setup wizard writes ~/.dexe-mcp/.env and copies skills. A CLI command, not a tool.",
};

/** node:fs APIs that create, modify or delete files. */
const FS_WRITE_APIS: ReadonlySet<string> = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);
const FS_MODULES: ReadonlySet<string> = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

// ---------------------------------------------------------------------------
// Source analysis
// ---------------------------------------------------------------------------

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (extname(p) === ".ts" && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const rel = (abs: string): string => relative(SRC, abs).split(sep).join("/");

interface ParsedModule {
  /** Relative specifiers: static imports, re-exports, literal dynamic imports. */
  specifiers: string[];
  /** fs write APIs this module imports (or "* as fs" for a namespace import). */
  fsWrites: string[];
}

function parseModule(abs: string): ParsedModule {
  const sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  const fsWrites: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      specifiers.push(spec);
      if (ts.isImportDeclaration(node) && FS_MODULES.has(spec)) {
        const clause = node.importClause;
        if (clause?.name) fsWrites.push(`default import of ${spec}`);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) fsWrites.push(`* as ${bindings.name.text}`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (FS_WRITE_APIS.has(imported)) fsWrites.push(imported);
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specifiers, fsWrites };
}

/** Resolve a relative specifier to a src-relative .ts path; null for data files. */
function resolveSpecifier(fromAbs: string, spec: string): string | null {
  const target = resolve(dirname(fromAbs), spec);
  if (target.endsWith(".json")) return null; // bundled data (governor/configs), not code
  const candidates = target.endsWith(".js")
    ? [`${target.slice(0, -3)}.ts`]
    : [`${target}.ts`, join(target, "index.ts")];
  const hit = candidates.find((c) => existsSync(c));
  return rel(hit ?? candidates[0]!);
}

interface Graph {
  files: string[];
  imports: Map<string, string[]>;
  fsWrites: Map<string, string[]>;
}

function loadGraph(): Graph {
  const files = tsFilesUnder(SRC).map(rel).sort();
  const imports = new Map<string, string[]>();
  const fsWrites = new Map<string, string[]>();
  for (const f of files) {
    const abs = join(SRC, f);
    const parsed = parseModule(abs);
    const targets = parsed.specifiers
      .filter((s) => s.startsWith("."))
      .map((s) => resolveSpecifier(abs, s))
      .filter((t): t is string => t !== null);
    imports.set(f, [...new Set(targets)]);
    if (parsed.fsWrites.length > 0) fsWrites.set(f, parsed.fsWrites);
  }
  return { files, imports, fsWrites };
}

const isReadSide = (c: ModuleClass | undefined): boolean => c === "read" || c === "mixed";

/**
 * Breadth-first from every read-side module. Read-side targets are followed;
 * a write/root target ends the path and is recorded as a crossing; an
 * unclassified target is recorded so the classification test can name it.
 */
function walk(graph: Graph): { crossings: Set<string>; unclassifiedTargets: Set<string> } {
  const crossings = new Set<string>();
  const unclassifiedTargets = new Set<string>();
  const queue = graph.files.filter((f) => isReadSide(MODULE_CLASSES.get(f)));
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const to of graph.imports.get(from) ?? []) {
      const cls = MODULE_CLASSES.get(to);
      if (cls === undefined) unclassifiedTargets.add(`${from} -> ${to}`);
      else if (cls === "write" || cls === "root") crossings.add(`${from} -> ${to}`);
      else if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return { crossings, unclassifiedTargets };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("read/write edition boundary — import graph", () => {
  const graph = loadGraph();
  const { crossings, unclassifiedTargets } = walk(graph);

  it("analysed the real tree — otherwise every assertion here is vacuous", () => {
    expect(graph.files.length).toBeGreaterThan(100);
    const edges = [...graph.imports.values()].reduce((n, t) => n + t.length, 0);
    expect(edges, "almost no imports found — is the parser broken?").toBeGreaterThan(300);
    expect(crossings.size, "no crossings found at all — is the walk broken?").toBeGreaterThan(0);
  });

  it("every src module is classified in tests/boundary/modules.ts, and only real ones", () => {
    const unclassified = graph.files.filter((f) => !MODULE_CLASSES.has(f));
    const stale = [...MODULE_CLASSES.keys()].filter((f) => !graph.files.includes(f)).sort();
    expect(
      unclassified,
      "new src files need a class (read / write / mixed / root) in tests/boundary/modules.ts",
    ).toEqual([]);
    expect(stale, "classified in tests/boundary/modules.ts but no such file under src/").toEqual([]);
    expect([...unclassifiedTargets], "imports that resolve to no classified src file").toEqual([]);
  });

  it("read-side code adds no new imports of write-side code", () => {
    const added = [...crossings].filter((e) => !(e in KNOWN_CROSSINGS)).sort();
    expect(
      added,
      [
        "New read → write import(s). The read edition must build without the write files.",
        "Fix one of:",
        "  1. Move the shared, side-effect-free code into a read-side module and import it from both.",
        "  2. If the importing file is really write code, classify it `write` in tests/boundary/modules.ts.",
        "Listing the edge in KNOWN_CROSSINGS is for pre-existing debt only.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the crossing allowlist has no stale entries (it may only shrink)", () => {
    const stale = Object.keys(KNOWN_CROSSINGS).filter((e) => !crossings.has(e)).sort();
    expect(stale, "these crossings are gone — delete them from KNOWN_CROSSINGS").toEqual([]);
  });

  it("read-side code writes the local disk only where listed", () => {
    const writers = [...graph.fsWrites.keys()].filter((f) => isReadSide(MODULE_CLASSES.get(f)));
    const added = writers
      .filter((f) => !(f in KNOWN_DISK_WRITERS))
      .map((f) => `${f}: ${graph.fsWrites.get(f)!.join(", ")}`);
    const stale = Object.keys(KNOWN_DISK_WRITERS).filter((f) => !writers.includes(f)).sort();
    expect(added, "read-side modules importing fs write APIs — a read tool must not persist").toEqual([]);
    expect(stale, "no longer writes the disk — delete it from KNOWN_DISK_WRITERS").toEqual([]);
  });
});
