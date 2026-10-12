import { describe, expect, it } from "vitest";
import { MODULE_CLASSES, MODULE_GROUPS, type ModuleClass } from "./modules.js";
import { loadSrcTree, resolveIn, scanModule, type Tree } from "./scan.js";

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
 * The scanner is a small tokenizer (./scan.ts; comments, strings, template
 * literals and regex literals are understood), not the TypeScript compiler:
 * TypeScript 7 ships no JavaScript compiler API. The self-test block at the
 * bottom pins every shape it must catch and every shape it must ignore.
 *
 * Models tests/governor/isolation.test.ts, but follows the real graph instead
 * of grepping for forbidden paths.
 */

/**
 * Read-side → write-side imports that exist today. Key: "<from> -> <to>",
 * paths relative to src/. Value: why it exists and what removes it.
 */
const KNOWN_CROSSINGS: Readonly<Record<string, string>> = {};

/**
 * Read-side files that write the local disk. The read edition is meant to run
 * as a shared server, so every local write on its side is listed here.
 *
 * `dexe_dao_report` is not here: its snapshot store is injected
 * (src/tools/report.ts `ReportSnapshotStore`), the file implementation lives on
 * the write side (src/lib/reportStoreFile.ts), and the read edition passes none.
 */
const KNOWN_DISK_WRITERS: Readonly<Record<string, string>> = {
  "lib/stateStore.ts":
    "the state.json writer. Only write flows call it; read tools call getState / findKnownDao.",
  "cli/init.ts":
    "the setup wizard writes ~/.dexe-mcp/.env and copies skills. A CLI command, not a tool.",
};

/** Read-side files allowed an opaque module load. None today. */
const KNOWN_OPAQUE_LOADS: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// The checks, over any tree (the real src/ or a fixture)
// ---------------------------------------------------------------------------

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

describe("read/write edition boundary — import graph", () => {
  const report = analyse(loadSrcTree(), MODULE_CLASSES, {
    crossings: KNOWN_CROSSINGS,
    diskWriters: KNOWN_DISK_WRITERS,
    opaqueLoads: KNOWN_OPAQUE_LOADS,
  });

  it("analysed the real tree — otherwise every assertion here is vacuous", () => {
    expect(report.files.length).toBeGreaterThan(100);
    expect(report.edgeCount, "almost no imports found — is the scanner broken?").toBeGreaterThan(300);
    // Zero crossings since A7. That is only meaningful if the walk can still SEE
    // one: the fixture block below proves detection, and this proves the real
    // graph does reach write modules — from the composition roots, which are
    // allowed to import both sides.
    const tree = loadSrcTree();
    const roots = [...MODULE_CLASSES].filter(([, c]) => c === "root").map(([f]) => f);
    const rootReachesWrite = roots.some((f) =>
      scanModule(tree.get(f)!)
        .specifiers.filter((s) => s.startsWith("."))
        .some((s) => MODULE_CLASSES.get(resolveIn(tree, f, s) ?? "") === "write"),
    );
    expect(rootReachesWrite, "no composition root imports a write module — is the resolver broken?").toBe(true);
  });

  it("no read-side module imports a write or root module (A7: zero crossings)", () => {
    expect(report.crossings).toEqual([]);
    expect(Object.keys(KNOWN_CROSSINGS)).toEqual([]);
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
