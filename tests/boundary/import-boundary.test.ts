import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_CLASSES, MODULE_GROUPS, type ModuleClass } from "./modules.js";
import { REPO, loadSrcTree, resolveIn, scanModule, type Tree } from "./scan.js";

/**
 * The read/write edition boundary, enforced on the import graph.
 *
 * The read edition is a dependency of this package, @dexe-network/dexe-mcp:
 * src/ holds no read module, and this repo reaches the read code only through
 * the package's entry points (`/core`, and `/bin` for the binary's shim). The
 * package cannot import this repo at all, so read → write is closed by
 * construction; the "dependency, not a copy" block below holds src/ to that.
 *
 * What is left of the walk: every static import (value AND type-only), every
 * `export … from`, and every literal `import("…")` (including type-position
 * `import("./x.js").T`), starting from every read-side module of this repo
 * (`mixed` + `shim` in ./modules.ts). An edge from the read side into a `write`
 * or `root` module is a CROSSING. Today's crossings are listed below, each with
 * what removes it.
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
 * as a shared server, so every local write on its side is listed here. (The
 * read package's own disk writers — the state.json store — are held to the same
 * rule in its repo.)
 *
 * `dexe_dao_report` is not here: its snapshot store is injected
 * (`ReportSnapshotStore`, @dexe-network/dexe-mcp/core), the file implementation
 * lives on the write side (src/lib/reportStoreFile.ts), and the read edition
 * passes none.
 */
const KNOWN_DISK_WRITERS: Readonly<Record<string, string>> = {
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

const isReadSide = (c: ModuleClass | undefined): boolean => c === "mixed" || c === "shim";

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
    expect(report.files.length).toBeGreaterThan(80);
    expect(report.edgeCount, "almost no imports found — is the scanner broken?").toBeGreaterThan(150);
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
      "new src files need a class (write / mixed / root / shim) in tests/boundary/modules.ts — read code goes to @dexe-network/dexe-mcp",
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
        "  1. Move the shared, side-effect-free code into the read edition (@dexe-network/dexe-mcp/core) and import it from there.",
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
// The read edition is a dependency, not a copy
// ---------------------------------------------------------------------------

const READ_PACKAGE = "@dexe-network/dexe-mcp";
/** Entry points this repo may import, and from where. */
const ENTRY_POINTS: Readonly<Record<string, (from: string, cls: ModuleClass | undefined) => boolean>> = {
  // the library API: any module
  [`${READ_PACKAGE}/core`]: () => true,
  // the read edition's binary: only its bin shim
  [`${READ_PACKAGE}/bin`]: (_from, cls) => cls === "shim",
};

/**
 * src paths the read package also ships that are NOT copies: the same file name
 * for a different module. Each says what the package's file is instead.
 */
const SAME_NAME_NOT_A_COPY: Readonly<Record<string, string>> = {
  "index.ts":
    "this package's CLI and stdio server; the package's index.ts is its library entry (createReadServer, the `.` export)",
  "editions.ts":
    "lists BOTH editions' tools (READ_TOOLS + WRITE_TOOLS); the package's lists its own READ_TOOLS — " +
    "tests/boundary/edition-manifest.test.ts keeps the two READ_TOOLS equal",
};

const pkgRoot = dirname(createRequire(join(REPO, "package.json")).resolve(`${READ_PACKAGE}/package.json`));

/** dist-relative module paths the installed read package ships, as src-relative .ts names. */
function readPackageModules(): Set<string> {
  const out = new Set<string>();
  const dist = join(pkgRoot, "dist");
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extname(p) === ".js") out.add(relative(dist, p).split(sep).join("/").replace(/\.js$/, ".ts"));
    }
  };
  walk(dist);
  return out;
}

/** Every .ts/.mjs/.js under scripts/ (repo-relative path → source). */
function loadScripts(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if ([".ts", ".mjs", ".js"].includes(extname(p))) out.set(relative(REPO, p).split(sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(join(REPO, "scripts"));
  return out;
}

describe("the read edition is a dependency, not a copy", () => {
  const tree = loadSrcTree();
  const pkgModules = readPackageModules();

  it("the installed package is the read edition, and the walk below has something to compare", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      name: string;
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe(READ_PACKAGE);
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining([".", "./core", "./bin"]));
    expect(pkgModules.size, "the read package ships no modules — is it installed?").toBeGreaterThan(80);
    expect(pkgModules.has("core.ts")).toBe(true);
    // No cycle: the read edition never depends on the write edition.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("dexe-mcp");
  });

  it("src/ keeps no copy of a read module", () => {
    // A src path the package also ships is a module that exists twice — the
    // copy here would drift from the one the read edition actually serves.
    // The shim is the one same-named file: it is how this package's
    // `dexe-mcp-read` bin reaches the package's binary.
    const shims = new Set(MODULE_GROUPS.shim);
    const copies = [...tree.keys()]
      .filter((f) => pkgModules.has(f) && !shims.has(f) && !(f in SAME_NAME_NOT_A_COPY))
      .sort();
    expect(copies, "these src modules are the read edition's — import them from @dexe-network/dexe-mcp/core").toEqual([]);
    for (const f of shims) expect(pkgModules.has(f), `${f} shims a package module that no longer exists`).toBe(true);
    for (const f of Object.keys(SAME_NAME_NOT_A_COPY)) {
      expect(tree.has(f) && pkgModules.has(f), `${f} no longer exists on both sides — delete it from SAME_NAME_NOT_A_COPY`).toBe(true);
    }
  });

  it("src/ and scripts/ reach the read edition only through its entry points", () => {
    const bad: string[] = [];
    const check = (file: string, text: string, cls: ModuleClass | undefined): void => {
      for (const spec of scanModule(text).specifiers) {
        if (spec !== READ_PACKAGE && !spec.startsWith(`${READ_PACKAGE}/`)) continue;
        const allowed = ENTRY_POINTS[spec];
        if (!allowed || !allowed(file, cls)) bad.push(`${file}: ${spec}`);
      }
    };
    for (const [f, text] of tree) check(`src/${f}`, text, MODULE_CLASSES.get(f));
    for (const [f, text] of loadScripts()) check(f, text, undefined);
    expect(bad, "deep or unlisted imports of the read package — use its entry points (ENTRY_POINTS)").toEqual([]);
  });

  it("no src/ module imports loadReadConfig — in the write process it would delete the signing keys", () => {
    // loadReadConfig deletes every DEXE_ / AGENT_ / SWARM_ var the read edition
    // does not read from process.env (an allowlist). The write edition loads
    // its config with config.ts's loadConfig, which runs the read loader's
    // phases (applyEnvSpec, assembleReadConfig, …) without that scrub.
    const named = (text: string): boolean => /\bloadReadConfig\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""));
    const offenders = [...tree].filter(([, text]) => named(text)).map(([f]) => f).sort();
    expect(offenders, "use loadConfig (src/config.ts); loadReadConfig scrubs process.env").toEqual([]);
    // the detector sees an import and a re-export, and not a comment
    expect(named('import { loadReadConfig } from "@dexe-network/dexe-mcp/core";')).toBe(true);
    expect(named('export { loadReadConfig } from "@dexe-network/dexe-mcp/core";')).toBe(true);
    expect(named("// loadReadConfig is not used here")).toBe(false);
  });

  it("no dynamic import in src/ reaches the read edition (it breaks the plugin bundle)", () => {
    // esbuild wraps the target of a dynamic import, and everything it reaches,
    // in a lazy init closure. Reaching @dexe-network/dexe-mcp/core that way
    // wraps zod, and the bundle dies on load ("Class2 is not a constructor").
    // Such an import must be static (src/index.ts imports the doctor, `key`
    // and `approve` statically for this).
    const reachesCore = (start: string): string | null => {
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length) {
        const f = queue.shift()!;
        const specs = scanModule(tree.get(f) ?? "").specifiers;
        if (specs.includes(`${READ_PACKAGE}/core`)) return f;
        for (const s of specs.filter((x) => x.startsWith("."))) {
          const to = resolveIn(tree, f, s);
          if (to && tree.has(to) && !seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
      return null;
    };
    const bad: string[] = [];
    for (const [f, text] of tree) {
      for (const m of text.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const target = resolveIn(tree, f, m[1]!);
        const via = target && tree.has(target) ? reachesCore(target) : null;
        if (via) bad.push(`${f}: import("${m[1]}") reaches ${READ_PACKAGE}/core via ${via}`);
      }
    }
    expect(bad, "make these imports static").toEqual([]);
  });

  it("src/ does use the read edition through core — otherwise the check above is vacuous", () => {
    const importers = [...tree].filter(([, text]) =>
      scanModule(text).specifiers.includes(`${READ_PACKAGE}/core`),
    );
    expect(importers.length).toBeGreaterThan(40);
  });

  it("a shim imports nothing but the read edition's entry points (and Node builtins)", () => {
    for (const f of MODULE_GROUPS.shim) {
      const specs = scanModule(tree.get(f)!).specifiers;
      expect(specs.filter((s) => s.startsWith(".")), `${f} imports a src module`).toEqual([]);
      expect(
        specs.filter((s) => !(s in ENTRY_POINTS) && !s.startsWith("node:")),
        `${f} imports something besides the read edition`,
      ).toEqual([]);
      expect(specs, `${f} starts nothing`).toContain(`${READ_PACKAGE}/bin`);
    }
  });

  it("the dependency is pinned: the vendored tarball, or one EXACT published version", () => {
    // Until @dexe-network/dexe-mcp is on npm the dependency is a committed
    // tarball (vendor/); a stale or missing one would make CI install something
    // else than what was tested here. Once it is on npm, the spec is an exact
    // version, never a range: the write edition is checked (tools/list,
    // doctor, bundle) against one read build, and a range would let an install
    // pick up another one.
    const own = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const spec = own.dependencies[READ_PACKAGE]!;
    expect(spec).toBeDefined();
    const installed = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string }).version;
    if (!spec.startsWith("file:")) {
      expect(spec, "an exact version, no ^ ~ >= or x").toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(spec).toBe(installed);
      return;
    }
    const tarball = join(REPO, spec.slice("file:".length));
    expect(existsSync(tarball), `${spec} is not in the repo`).toBe(true);
    expect(spec, "the tarball name and the installed version disagree — re-run npm install").toContain(`-${installed}.tgz`);
  });
});

// ---------------------------------------------------------------------------
// Self-test: the checker on fixtures
// ---------------------------------------------------------------------------

describe("boundary checker self-test", () => {
  const CLASSES = new Map<string, ModuleClass>([
    ["r.ts", "shim"],
    ["m.ts", "mixed"],
    ["w.ts", "write"],
    ["root.ts", "root"],
  ]);
  const NONE: Allowlists = { crossings: {}, diskWriters: {}, opaqueLoads: {} };

  /** Analyse a tree whose read-side module r.ts has `src`; m.ts and w.ts are inert. */
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
