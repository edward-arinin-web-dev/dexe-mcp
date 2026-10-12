import { readdirSync, readFileSync } from "node:fs";
import { extname, join, posix, relative, resolve, sep } from "node:path";

/**
 * The import scanner behind tests/boundary/import-boundary.test.ts and
 * tests/read/module-graph.test.ts: a small tokenizer (comments, strings,
 * template literals and regex literals are understood — TypeScript 7 ships no
 * JavaScript compiler API), the per-module scan (static imports, `export … from`,
 * literal `import("…")`, fs write APIs, opaque loads), specifier resolution and
 * the src/ tree loader. Not a test file; the self-test block in
 * import-boundary.test.ts pins every shape it must catch and ignore.
 */

export const REPO = resolve(__dirname, "..", "..");
export const SRC = join(REPO, "src");

/** src-relative path → source text. */
export type Tree = ReadonlyMap<string, string>;

/** node:fs exports that create, modify or delete files — or hand out the API that does. */
export const FS_WRITE_APIS: ReadonlySet<string> = new Set([
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
export const FS_MODULES: ReadonlySet<string> = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * id: identifier or keyword; str: a string, or a template literal with no
 * `${}`; tpl: start of a template literal that has substitutions (its
 * expressions follow as ordinary tokens); val: number or regex literal;
 * p: one punctuation character.
 */
export interface Tok {
  k: "id" | "str" | "tpl" | "val" | "p";
  v: string;
}

/** After these, a `/` starts a regex literal, not a division. */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

export function tokenize(src: string): Tok[] {
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

export interface ModuleScan {
  /** Static imports, `export … from`, literal `import("…")`. */
  specifiers: string[];
  /** Evidence this module can write files (see FS_WRITE_APIS). */
  fsWrites: string[];
  /** Loads whose target cannot be checked statically. */
  opaqueLoads: string[];
}

export function scanModule(src: string): ModuleScan {
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

/** Resolve a relative specifier to a tree path; null for data files (JSON). */
export function resolveIn(tree: Tree, from: string, spec: string): string | null {
  const target = posix.normalize(posix.join(posix.dirname(from), spec));
  if (target.endsWith(".json")) return null; // bundled data (governor/configs), not code
  const candidates = target.endsWith(".js")
    ? [`${target.slice(0, -3)}.ts`]
    : [`${target}.ts`, posix.join(target, "index.ts")];
  return candidates.find((c) => tree.has(c)) ?? candidates[0]!;
}

export function loadSrcTree(): Tree {
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
