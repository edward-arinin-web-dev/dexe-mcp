import { readdirSync, readFileSync } from "node:fs";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_CLASSES, MODULE_GROUPS, type ModuleClass } from "./modules.js";

/**
 * The read/write edition boundary, enforced on the import graph.
 *
 * Walks every static import (value AND type-only — the read package has to
 * compile without the write files), every `export … from`, and every literal
 * `import("…")` (including type-position `import("./x.js").T`), starting from
 * every read-side module (`read` + `mixed` in ./modules.ts). An edge from the
 * read side into a `write` or `root` module is a CROSSING. Today's crossings are
 * listed below, each with what removes it.
 *
 * Every list here is a ratchet in both directions:
 *   - an entry that is not listed fails (nothing new sneaks onto the read side),
 *   - a listed entry that no longer exists fails too, so the lists can only
 *     shrink, and shrink in the same change that fixed them.
 *
 * Beyond crossings, read-side modules are checked for two things a static
 * import walk cannot follow:
 *   - LOCAL DISK WRITES: fs write APIs imported by name, `promises`, a default
 *     or namespace fs import, or a dynamic `import("node:fs")`.
 *   - OPAQUE LOADS: `import(expr)` with a non-literal argument, `require(…)`
 *     and `createRequire` — module loads whose target cannot be checked.
 *
 * The scanner is a small tokenizer in this file (comments, strings, template
 * literals and regex literals are understood), not the TypeScript compiler:
 * TypeScript 7 ships no JavaScript compiler API. The self-test block at the
 * bottom pins every shape it must catch and every shape it must ignore.
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
  "config.ts -> env/schema.ts":
    "the single loader validates the full env spec. Gone when config splits into a read config and a write config.",
  "config.ts -> lib/treasuryGate.ts":
    "the single loader resolves the treasury-guard posture. Gone when config splits into a read config and a write config.",
  "instructions.ts -> lib/resumeContract.ts":
    "the handshake text carries the write resume rule. Gone when each edition gets its own instructions.",
  "knowledge/index.ts -> knowledge/flows.ts":
    "the guide engine is wired to the write flow corpus. Gone when the corpus becomes a parameter.",
  "knowledge/render.ts -> knowledge/flows.ts":
    "renders flows next to topics and gotchas. Gone when knowledge/ splits into read and write halves.",
  "tools/context.ts -> hardhat.ts":
    "type-only: ToolContext carries the dev-toolchain runner. Gone when the read ToolContext drops `runner`.",
  "tools/getConfig.ts -> lib/signer.ts":
    "dexe_get_config reports signer mode. Gone when the signer half moves to a write-edition context tool.",
  "tools/guide.ts -> knowledge/nextSteps.ts":
    "dexe_guide follows the active write flow. Gone when activeFlow / nextAfter move to the write edition.",
  "tools/operationalContext.ts -> lib/agentLedger.ts":
    "dexe_context reports the persona keyring. Gone when that moves to a write-edition context tool.",
  "tools/operationalContext.ts -> lib/signer.ts":
    "dexe_context reports signer mode and persona balances. Gone when that moves to a write-edition context tool.",
};

/**
 * Read-side files that write the local disk. The read edition is meant to run
 * as a shared server, so every local write on its side is listed here.
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

/** Read-side files allowed an opaque module load. None today. */
const KNOWN_OPAQUE_LOADS: Readonly<Record<string, string>> = {};

/** node:fs exports that create, modify or delete files — or hand out the API that does. */
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
  // `import { promises as fsp } from "node:fs"` — the whole async API, writers included
  "promises",
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
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * id: identifier or keyword; str: a string, or a template literal with no
 * `${}`; tpl: start of a template literal that has substitutions (its
 * expressions follow as ordinary tokens); val: number or regex literal;
 * p: one punctuation character.
 */
interface Tok {
  k: "id" | "str" | "tpl" | "val" | "p";
  v: string;
}

/** After these, a `/` starts a regex literal, not a division. */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  // Open `{` braces and open template substitutions, innermost last.
  const stack: ("brace" | "subst")[] = [];
  const n = src.length;
  let i = 0;

  const divisionAllowed = (): boolean => {
    const t = toks[toks.length - 1];
    if (!t) return false;
    if (t.k === "id") return !REGEX_AFTER_KEYWORD.has(t.v);
    if (t.k !== "p") return true;
    return t.v === ")" || t.v === "]" || t.v === "}";
  };

  /** Template text from i to the closing backtick or the next `${`. */
  const templateText = (): { cooked: string; subst: boolean } => {
    let cooked = "";
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        cooked += src[i + 1] ?? "";
        i += 2;
      } else if (c === "`") {
        i++;
        return { cooked, subst: false };
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        return { cooked, subst: true };
      } else {
        cooked += c;
        i++;
      }
    }
    return { cooked, subst: false };
  };

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === '"' || c === "'") {
      let v = "";
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          v += src[j + 1] ?? "";
          j += 2;
        } else {
          v += src[j];
          j++;
        }
      }
      toks.push({ k: "str", v });
      i = j + 1;
    } else if (c === "`") {
      i++;
      const t = templateText();
      if (t.subst) {
        toks.push({ k: "tpl", v: "" });
        stack.push("subst");
      } else {
        toks.push({ k: "str", v: t.cooked });
      }
    } else if (c === "{") {
      stack.push("brace");
      toks.push({ k: "p", v: c });
      i++;
    } else if (c === "}") {
      i++;
      if (stack.pop() === "subst") {
        // The `}` closing a `${…}`: back into the template's text.
        if (templateText().subst) stack.push("subst");
      } else {
        toks.push({ k: "p", v: c });
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      toks.push({ k: "id", v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j]!)) j++;
      toks.push({ k: "val", v: src.slice(i, j) });
      i = j;
    } else if (c === "/" && !divisionAllowed()) {
      // Regex literal: to the unescaped `/` outside a character class, then flags.
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const r = src[j]!;
        if (r === "\\") {
          j += 2;
          continue;
        }
        if (inClass) inClass = r !== "]";
        else if (r === "[") inClass = true;
        else if (r === "/") break;
        j++;
      }
      j++;
      while (j < n && /[A-Za-z]/.test(src[j]!)) j++;
      toks.push({ k: "val", v: "regex" });
      i = j;
    } else {
      toks.push({ k: "p", v: c });
      i++;
    }
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Module scan
// ---------------------------------------------------------------------------

interface ModuleScan {
  /** Static imports, `export … from`, literal `import("…")`. */
  specifiers: string[];
  /** Evidence this module can write files (see FS_WRITE_APIS). */
  fsWrites: string[];
  /** Loads whose target cannot be checked statically. */
  opaqueLoads: string[];
}

function scanModule(src: string): ModuleScan {
  const t = tokenize(src);
  const specifiers: string[] = [];
  const fsWrites: string[] = [];
  const opaqueLoads: string[] = [];
  const is = (j: number, k: Tok["k"], v?: string): boolean =>
    t[j]?.k === k && (v === undefined || t[j]!.v === v);

  /** fs write evidence from an import/export clause (the tokens before `from`). */
  const fsFromClause = (clause: Tok[], spec: string): void => {
    if (!FS_MODULES.has(spec)) return;
    if (clause.some((x) => x.k === "p" && x.v === "*")) fsWrites.push(`* from ${spec}`);
    const head = clause[0]?.k === "id" && clause[0].v === "type" && clause.length > 1 ? 1 : 0;
    if (clause[head]?.k === "id" && (clause.length === head + 1 || (clause[head + 1]?.k === "p" && clause[head + 1]!.v === ","))) {
      fsWrites.push(`default import of ${spec}`);
    }
    const open = clause.findIndex((x) => x.k === "p" && x.v === "{");
    if (open < 0) return;
    const close = clause.findIndex((x, idx) => idx > open && x.k === "p" && x.v === "}");
    let entry: Tok[] = [];
    const flush = (): void => {
      const names = entry.filter((x) => x.k === "id" || x.k === "str");
      // `type X as Y` → X; `type` alone or `type as t` → the export named "type"
      const first = names[0]?.v === "type" && names[1] && names[1].v !== "as" ? names[1] : names[0];
      if (first && FS_WRITE_APIS.has(first.v)) fsWrites.push(first.v);
      entry = [];
    };
    for (const x of clause.slice(open + 1, close < 0 ? clause.length : close)) {
      if (x.k === "p" && x.v === ",") flush();
      else entry.push(x);
    }
    flush();
  };

  for (let j = 0; j < t.length; j++) {
    const tok = t[j]!;
    if (tok.k !== "id" || is(j - 1, "p", ".")) continue;

    if (tok.v === "createRequire") {
      opaqueLoads.push("createRequire");
    } else if (tok.v === "require" && is(j + 1, "p", "(")) {
      opaqueLoads.push(is(j + 2, "str") ? `require("${t[j + 2]!.v}")` : "require(<expression>)");
    } else if (tok.v === "import" && is(j + 1, "p", "(")) {
      if (is(j + 2, "str") && (is(j + 3, "p", ")") || is(j + 3, "p", ","))) {
        const spec = t[j + 2]!.v;
        specifiers.push(spec);
        if (FS_MODULES.has(spec)) fsWrites.push(`import("${spec}")`);
      } else {
        opaqueLoads.push("import(<expression>)");
      }
    } else if (tok.v === "import" && (is(j + 1, "id") || is(j + 1, "p", "{") || is(j + 1, "p", "*") || is(j + 1, "str"))) {
      // import "x" | import <clause> from "x" | import x = require("x") (the require is caught above)
      if (is(j + 1, "str")) {
        specifiers.push(t[j + 1]!.v);
        continue;
      }
      for (let m = j + 1; m < t.length && !is(m, "p", ";") && !is(m, "p", "="); m++) {
        if (is(m, "id", "from") && is(m + 1, "str")) {
          specifiers.push(t[m + 1]!.v);
          fsFromClause(t.slice(j + 1, m), t[m + 1]!.v);
          break;
        }
      }
    } else if (tok.v === "export") {
      // export { … } from "x" | export * [as ns] from "x" | export type { … } from "x"
      let k = j + 1;
      if (is(k, "id", "type")) k++;
      let fromAt = -1;
      if (is(k, "p", "{")) {
        let m = k;
        while (m < t.length && !is(m, "p", "}")) m++;
        fromAt = m + 1;
      } else if (is(k, "p", "*")) {
        fromAt = is(k + 1, "id", "as") ? k + 3 : k + 1;
      }
      if (fromAt > 0 && is(fromAt, "id", "from") && is(fromAt + 1, "str")) {
        specifiers.push(t[fromAt + 1]!.v);
        fsFromClause(t.slice(k, fromAt), t[fromAt + 1]!.v);
      }
    }
  }
  return { specifiers, fsWrites, opaqueLoads };
}

// ---------------------------------------------------------------------------
// The checks, over any tree (the real src/ or a fixture)
// ---------------------------------------------------------------------------

/** src-relative path → source text. */
type Tree = ReadonlyMap<string, string>;

interface Allowlists {
  crossings: Readonly<Record<string, string>>;
  diskWriters: Readonly<Record<string, string>>;
  opaqueLoads: Readonly<Record<string, string>>;
}

interface Report {
  files: string[];
  edgeCount: number;
  crossings: string[];
  unclassified: string[];
  staleClasses: string[];
  unresolved: string[];
  newCrossings: string[];
  staleCrossings: string[];
  newDiskWriters: string[];
  staleDiskWriters: string[];
  newOpaqueLoads: string[];
  staleOpaqueLoads: string[];
}

/** Resolve a relative specifier to a tree path; null for data files (JSON). */
function resolveIn(tree: Tree, from: string, spec: string): string | null {
  const target = posix.normalize(posix.join(posix.dirname(from), spec));
  if (target.endsWith(".json")) return null; // bundled data (governor/configs), not code
  const candidates = target.endsWith(".js")
    ? [`${target.slice(0, -3)}.ts`]
    : [`${target}.ts`, posix.join(target, "index.ts")];
  return candidates.find((c) => tree.has(c)) ?? candidates[0]!;
}

const isReadSide = (c: ModuleClass | undefined): boolean => c === "read" || c === "mixed";

function analyse(tree: Tree, classes: ReadonlyMap<string, ModuleClass>, allow: Allowlists): Report {
  const files = [...tree.keys()].sort();
  const scans = new Map(files.map((f) => [f, scanModule(tree.get(f)!)] as const));
  const imports = new Map<string, string[]>();
  let edgeCount = 0;
  for (const f of files) {
    const targets = scans
      .get(f)!
      .specifiers.filter((s) => s.startsWith("."))
      .map((s) => resolveIn(tree, f, s))
      .filter((x): x is string => x !== null);
    imports.set(f, [...new Set(targets)]);
    edgeCount += targets.length;
  }

  // Breadth-first from every read-side module. Read-side targets are followed;
  // a write/root target ends the path and is a crossing.
  const crossings = new Set<string>();
  const unresolved = new Set<string>();
  const unclassifiedTargets = new Set<string>();
  const queue = files.filter((f) => isReadSide(classes.get(f)));
  const seen = new Set(queue);
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const to of imports.get(from) ?? []) {
      const cls = classes.get(to);
      if (!tree.has(to)) unresolved.add(`${from} -> ${to}`);
      else if (cls === undefined) unclassifiedTargets.add(to);
      else if (cls === "write" || cls === "root") crossings.add(`${from} -> ${to}`);
      else if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }

  const readSide = files.filter((f) => isReadSide(classes.get(f)));
  const ratchet = (found: Map<string, string>, listed: Readonly<Record<string, string>>) => ({
    added: [...found].filter(([f]) => !(f in listed)).map(([f, why]) => `${f}: ${why}`),
    stale: Object.keys(listed).filter((f) => !found.has(f)).sort(),
  });
  const disk = ratchet(
    new Map(readSide.filter((f) => scans.get(f)!.fsWrites.length > 0).map((f) => [f, scans.get(f)!.fsWrites.join(", ")])),
    allow.diskWriters,
  );
  const opaque = ratchet(
    new Map(readSide.filter((f) => scans.get(f)!.opaqueLoads.length > 0).map((f) => [f, scans.get(f)!.opaqueLoads.join(", ")])),
    allow.opaqueLoads,
  );

  return {
    files,
    edgeCount,
    crossings: [...crossings].sort(),
    unclassified: [...new Set([...files.filter((f) => !classes.has(f)), ...unclassifiedTargets])].sort(),
    staleClasses: [...classes.keys()].filter((f) => !tree.has(f)).sort(),
    unresolved: [...unresolved].sort(),
    newCrossings: [...crossings].filter((e) => !(e in allow.crossings)).sort(),
    staleCrossings: Object.keys(allow.crossings).filter((e) => !crossings.has(e)).sort(),
    newDiskWriters: disk.added,
    staleDiskWriters: disk.stale,
    newOpaqueLoads: opaque.added,
    staleOpaqueLoads: opaque.stale,
  };
}

// ---------------------------------------------------------------------------
// The rules, on the real tree
// ---------------------------------------------------------------------------

function loadSrcTree(): Tree {
  const tree = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (extname(p) === ".ts" && !p.endsWith(".d.ts")) {
        tree.set(relative(SRC, p).split(sep).join("/"), readFileSync(p, "utf8"));
      }
    }
  };
  walk(SRC);
  return tree;
}

describe("read/write edition boundary — import graph", () => {
  const report = analyse(loadSrcTree(), MODULE_CLASSES, {
    crossings: KNOWN_CROSSINGS,
    diskWriters: KNOWN_DISK_WRITERS,
    opaqueLoads: KNOWN_OPAQUE_LOADS,
  });

  it("analysed the real tree — otherwise every assertion here is vacuous", () => {
    expect(report.files.length).toBeGreaterThan(100);
    expect(report.edgeCount, "almost no imports found — is the scanner broken?").toBeGreaterThan(300);
    expect(report.crossings.length, "no crossings found at all — is the walk broken?").toBeGreaterThan(0);
  });

  it("every src module is classified exactly once in tests/boundary/modules.ts, and only real ones", () => {
    const listed = Object.values(MODULE_GROUPS).flat();
    const twice = [...new Set(listed.filter((f, i) => listed.indexOf(f) !== i))].sort();
    expect(twice, "listed more than once in tests/boundary/modules.ts").toEqual([]);
    expect(
      report.unclassified,
      "new src files need a class (read / write / mixed / root) in tests/boundary/modules.ts",
    ).toEqual([]);
    expect(report.staleClasses, "classified in tests/boundary/modules.ts but no such file under src/").toEqual([]);
    expect(report.unresolved, "relative imports that resolve to no src file").toEqual([]);
  });

  it("read-side code adds no new imports of write-side code", () => {
    expect(
      report.newCrossings,
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
    expect(report.staleCrossings, "these crossings are gone — delete them from KNOWN_CROSSINGS").toEqual([]);
  });

  it("read-side code writes the local disk only where listed", () => {
    expect(report.newDiskWriters, "read-side modules that can write files — a read tool must not persist").toEqual([]);
    expect(report.staleDiskWriters, "no longer writes the disk — delete it from KNOWN_DISK_WRITERS").toEqual([]);
  });

  it("read-side code loads no module the walk cannot see", () => {
    expect(
      report.newOpaqueLoads,
      "import(<expression>), require() or createRequire on the read side — use a static import",
    ).toEqual([]);
    expect(report.staleOpaqueLoads, "gone — delete it from KNOWN_OPAQUE_LOADS").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test: the checker on fixtures
// ---------------------------------------------------------------------------

describe("boundary checker self-test", () => {
  const CLASSES = new Map<string, ModuleClass>([
    ["r.ts", "read"],
    ["m.ts", "mixed"],
    ["w.ts", "write"],
    ["root.ts", "root"],
  ]);
  const NONE: Allowlists = { crossings: {}, diskWriters: {}, opaqueLoads: {} };

  /** Analyse a tree whose read module r.ts has `src`; m.ts and w.ts are inert. */
  const run = (src: string, allow: Allowlists = NONE, mixed = "export const m = 1;\n"): Report =>
    analyse(
      new Map([
        ["r.ts", src],
        ["m.ts", mixed],
        ["w.ts", "export const w = 1;\n"],
        ["root.ts", 'import { r } from "./r.js";\n'],
      ]),
      CLASSES,
      allow,
    );

  it("a clean read module reports nothing", () => {
    const r = run('import { readFileSync } from "node:fs";\nimport { m } from "./m.js";\nexport const r = m;\n');
    expect(r.crossings).toEqual([]);
    expect(r.newDiskWriters).toEqual([]);
    expect(r.newOpaqueLoads).toEqual([]);
  });

  describe("crossings", () => {
    it.each([
      ["value import", 'import { w } from "./w.js";'],
      ["type-only import", 'import type { W } from "./w.js";'],
      ["inline type import", 'import { type W } from "./w.js";'],
      ["side-effect import", 'import "./w.js";'],
      ["re-export", 'export { w } from "./w.js";'],
      ["star re-export", 'export * as ww from "./w.js";'],
      ["literal dynamic import", 'const mod = await import("./w.js");'],
      ["type-position import()", 'let x: typeof import("./w.js").w;'],
      ["multi-line clause", 'import {\n  w,\n  type W,\n} from "./w.js";'],
      ["after a regex with quotes in it", 'const re = /["\'`]/g;\nimport { w } from "./w.js";'],
      ["after a template with a substitution", 'const s = `${1 + 1}}`;\nimport { w } from "./w.js";'],
      ["import of the composition root", 'import { x } from "./root.js";'],
    ])("%s is a crossing", (_, src) => {
      const target = src.includes("root.js") ? "root.ts" : "w.ts";
      expect(run(src).newCrossings).toEqual([`r.ts -> ${target}`]);
    });

    it("is followed through a mixed module", () => {
      const r = run('import { m } from "./m.js";', NONE, 'import { w } from "./w.js";\nexport const m = w;\n');
      expect(r.newCrossings).toEqual(["m.ts -> w.ts"]);
    });

    it.each([
      ["a comment", '// import { w } from "./w.js";\n/* import("./w.js") */'],
      ["a string", 'const s = \'import { w } from "./w.js"\';'],
      ["a template", 'const s = `import("./w.js") ${"x"}`;'],
      ["a property named import", 'const o = { import: "./w.js" };'],
      ["a plain export", 'export const p = "./w.js";'],
    ])("text in %s is not an import", (_, src) => {
      expect(run(src).crossings).toEqual([]);
    });

    it("is ratcheted both ways", () => {
      const listed: Allowlists = { ...NONE, crossings: { "r.ts -> w.ts": "debt" } };
      expect(run('import { w } from "./w.js";', listed).newCrossings).toEqual([]);
      expect(run("export const r = 1;", listed).staleCrossings).toEqual(["r.ts -> w.ts"]);
    });
  });

  describe("disk writes", () => {
    it.each([
      ["a named write API", 'import { writeFileSync } from "node:fs";'],
      ["a renamed write API", 'import { mkdirSync as mk } from "fs";'],
      ["the promises API", 'import { promises as fsp } from "node:fs";'],
      ["fs/promises", 'import { writeFile } from "node:fs/promises";'],
      ["a namespace import", 'import * as fs from "node:fs";'],
      ["a default import", 'import fs from "node:fs";'],
      ["a dynamic import", 'import("node:fs").then((fs) => fs.writeFileSync("x", ""));'],
      ["a dynamic fs/promises import", 'const fsp = await import("node:fs/promises");'],
      ["a re-export", 'export { rmSync } from "node:fs";'],
    ])("%s is a disk writer", (_, src) => {
      expect(run(src).newDiskWriters).toHaveLength(1);
    });

    it("read-only fs APIs are not", () => {
      expect(run('import { existsSync, readFileSync, statSync } from "node:fs";').newDiskWriters).toEqual([]);
    });

    it("is ratcheted both ways", () => {
      const listed: Allowlists = { ...NONE, diskWriters: { "r.ts": "debt" } };
      expect(run('import { writeFileSync } from "node:fs";', listed).newDiskWriters).toEqual([]);
      expect(run("export const r = 1;", listed).staleDiskWriters).toEqual(["r.ts"]);
    });
  });

  describe("opaque loads", () => {
    it.each([
      ["import(expression)", "const mod = await import(name);"],
      ["import(template)", "const mod = await import(`./${name}.js`);"],
      ["require(literal)", 'const x = require("./w.js");'],
      ["require(expression)", "const x = require(name);"],
      ["createRequire", 'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);'],
    ])("%s is an opaque load", (_, src) => {
      expect(run(src).newOpaqueLoads).toHaveLength(1);
    });

    it("import.meta is not", () => {
      expect(run("const u = import.meta.url;").newOpaqueLoads).toEqual([]);
    });

    it("is ratcheted both ways", () => {
      const listed: Allowlists = { ...NONE, opaqueLoads: { "r.ts": "debt" } };
      expect(run("const m = await import(name);", listed).newOpaqueLoads).toEqual([]);
      expect(run("export const r = 1;", listed).staleOpaqueLoads).toEqual(["r.ts"]);
    });
  });

  it("flags unclassified and stale module entries", () => {
    const r = analyse(new Map([["r.ts", 'import { n } from "./new.js";'], ["new.ts", ""]]), CLASSES, NONE);
    expect(r.unclassified).toEqual(["new.ts"]);
    expect(r.staleClasses).toEqual(["m.ts", "root.ts", "w.ts"]);
  });
});
