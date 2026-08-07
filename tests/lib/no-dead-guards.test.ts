import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * "Written, unit-tested, and called from nothing."
 *
 * 0.33.0 shipped four guards in that state. `src/lib/protocolAdvisories.ts` even
 * carries a comment saying `checkTokensUnlocked` "had been written for exactly
 * this trap and then never called from production code" — and the same release
 * repeated the mistake four more times.
 *
 * Unit tests cannot see this. A guard tested in isolation passes whether or not
 * anything calls it, so the suite goes green, the CHANGELOG claims a protection,
 * and the user does not have one. That is strictly worse than no guard: it stops
 * anyone from looking for the hole again.
 *
 * This test is the structural half the unit tests cannot cover. The RULE:
 *
 *   every EXPORTED symbol under src/lib/ whose name says it is a check
 *   (check*, assert*, *Advisory, *Trap, *Gate, *Guard, find*) must be
 *   reachable from production code — a file under src/ that is not itself
 *   in src/lib/, directly or through a chain of src/lib/ callers.
 *
 * Deliberately NOT "is it imported somewhere": comments, doc strings, unused
 * imports and the test suite all fail to count. Only real call sites in real
 * production files do.
 *
 * Exemptions are greppable and carry a reason (see EXEMPTION_MARKER and
 * KNOWN_UNWIRED below) — never a silent list.
 */

const REPO = resolve(__dirname, "..", "..");
const SRC = join(REPO, "src");

// ---------------------------------------------------------------------------
// What counts as a guard
// ---------------------------------------------------------------------------

/**
 * Name shapes that promise a protection. Kept as separate labelled rules rather
 * than one clever regex so a failure can say WHICH promise the name made.
 */
const GUARD_NAME_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "check*", re: /^check[A-Z]/ },
  { label: "assert*", re: /^assert[A-Z]/ },
  { label: "*Advisory", re: /(?:Advisory|_ADVISORY)$/ },
  { label: "*Trap", re: /Trap$/ },
  { label: "*Gate", re: /Gate$/ },
  { label: "*Guard", re: /Guard$/ },
  { label: "find*", re: /^find[A-Z]/ },
];

function guardKinds(name: string): string[] {
  return GUARD_NAME_RULES.filter((r) => r.re.test(name)).map((r) => r.label);
}

/**
 * The sanctioned in-source exemption, mirroring the `raw-error-echo-allowed:`
 * convention in tests/lib/no-raw-error-echo.test.ts. It lives in the guard's own
 * doc comment so it is greppable (`rg "guard-unwired-allowed" src/`) and shows up
 * in review of the file that made the claim, rather than in an invisible list
 * over here.
 */
const EXEMPTION_MARKER = /guard-unwired-allowed:\s*\S+/;

/**
 * Pre-existing debt, grandfathered so this rule can land at all. Every one of
 * these was ALREADY dead before 0.33.0 (verified against the merge base), and
 * every one is named in the header comment of src/lib/preflight.ts as the
 * defence for a specific, numbered deploy/proposal trap — which is exactly the
 * disease this file exists to stop.
 *
 * They are listed here, not silently skipped, and the list is self-cleaning:
 * `the grandfather list has no stale entries` below fails if an entry is wired
 * up or deleted, so the only legal direction for this list is shorter. Nothing
 * from 0.33.0 onward belongs in it — new guards get wired or they do not ship.
 */
const KNOWN_UNWIRED: ReadonlyArray<{ symbol: string; file: string; reason: string }> = [
  {
    symbol: "checkProposalHasActions",
    file: "src/lib/preflight.ts",
    reason:
      "pre-0.33.0 debt: preflight.ts advertises it as the defence against an empty actions array, " +
      "but no builder calls it — an action-less proposal still reaches createProposal.",
  },
  {
    symbol: "checkApproveTarget",
    file: "src/lib/preflight.ts",
    reason:
      "pre-0.33.0 debt: preflight.ts line 6 maps trap 6 (approve GovPool instead of UserKeeper) to " +
      "this function; the approve builders never call it.",
  },
  {
    symbol: "checkAvatarIsJpeg",
    file: "src/lib/preflight.ts",
    reason:
      "pre-0.33.0 debt: superseded in practice by the magic-byte guards in src/lib/imageSniff.ts " +
      "(assertRasterAvatar / checkAvatarCidBytes), which ARE wired. Delete or wire — do not leave both.",
  },
  {
    symbol: "checkOffchainMetadata",
    file: "src/lib/preflight.ts",
    reason:
      "pre-0.33.0 debt: bug #27 (type=default_single_option_type, quorum decimals) is checked nowhere " +
      "on the off-chain proposal path.",
  },
  {
    symbol: "checkBlacklistRecipient",
    file: "src/lib/preflight.ts",
    reason:
      "pre-0.33.0 debt: bug #29 recipient-blacklist check. The live path uses checkBlacklist from " +
      "src/lib/blacklist.ts instead; this wrapper is orphaned.",
  },
];

// ---------------------------------------------------------------------------
// Source analysis
//
// Everything below works on an in-memory Map<path, source> rather than the
// filesystem, so the non-vacuity test can re-run the exact same analysis over a
// tree with one real call site deleted.
// ---------------------------------------------------------------------------

export type Tree = Map<string, string>;

/**
 * Blank out `import ... ;` statements, preserving line count.
 *
 * An import is not a call site. This is the difference between "somebody
 * remembered the guard exists" and "somebody put it on the path" — and it is the
 * whole point of the rule.
 */
function blankImports(src: string): string {
  return src.replace(/^import\b[^;]*;/gm, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Remove comments and string-literal text, keeping `${...}` expressions inside
 * template literals (those ARE code) and preserving every newline so reported
 * line numbers still match the file on disk.
 *
 * Without this, the doc comment above `lockedPowerAdvisory` — which names the
 * function while explaining it — would count as its own call site, and the guard
 * would certify itself as live.
 */
function stripNonCode(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let mode: "code" | "line" | "block" | "sq" | "dq" = "code";
  // "tpl" = inside a template literal's raw text; "expr" = inside its ${ }.
  const stack: ("tpl" | "expr")[] = [];
  const braces: number[] = [];

  while (i < n) {
    const c = src[i]!;
    const d = i + 1 < n ? src[i + 1]! : "";

    if (mode === "line") {
      if (c === "\n") {
        out += "\n";
        mode = "code";
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        i += 2;
      } else {
        if (c === "\n") out += "\n";
        i++;
      }
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"')) mode = "code";
      if (c === "\n") out += "\n";
      i++;
      continue;
    }

    if (stack.length > 0 && stack[stack.length - 1] === "tpl") {
      // Raw template text: dropped, but `${` opens real code again.
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && d === "{") {
        stack.push("expr");
        braces.push(0);
        out += " ";
        i += 2;
        continue;
      }
      if (c === "\n") out += "\n";
      i++;
      continue;
    }

    // Real code.
    if (c === "\\") {
      // Only reachable inside a regex literal; consuming the pair stops `\/\/`
      // from being misread as the start of a line comment.
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && d === "/") {
      mode = "line";
      i += 2;
      continue;
    }
    if (c === "/" && d === "*") {
      mode = "block";
      i += 2;
      continue;
    }
    if (c === "'") {
      mode = "sq";
      i++;
      continue;
    }
    if (c === '"') {
      mode = "dq";
      i++;
      continue;
    }
    if (c === "`") {
      stack.push("tpl");
      i++;
      continue;
    }
    if (stack.length > 0 && stack[stack.length - 1] === "expr") {
      if (c === "{") {
        braces[braces.length - 1]!++;
      } else if (c === "}") {
        if (braces[braces.length - 1] === 0) {
          stack.pop();
          braces.pop();
          out += " ";
          i++;
          continue;
        }
        braces[braces.length - 1]!--;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Top-level declarations only — `^` anchored, so the nested helpers inside a
 * function body belong to their enclosing declaration instead of becoming
 * owners of their own.
 */
const DECL_RE =
  /^(export\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|const|let|var|abstract\s+class|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Declaration keywords that vanish at compile time — they cannot guard anything. */
const TYPE_ONLY = new Set(["interface", "type", "enum"]);

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

interface Decl {
  readonly name: string;
  readonly exported: boolean;
  /** False for `interface` / `type` / `enum`: erased at runtime, so never reportable. */
  readonly runtime: boolean;
  /** 1-based, matching the file on disk. */
  readonly line: number;
  readonly endLine: number;
}

interface Parsed {
  readonly file: string;
  readonly decls: readonly Decl[];
  /** Identifiers referenced, grouped by the top-level declaration they sit in. */
  readonly refsByOwner: ReadonlyMap<string, ReadonlySet<string>>;
  /** Raw source, for doc comments and exemption markers. */
  readonly raw: string;
}

const MODULE_OWNER = "<module>";

function parseFile(file: string, raw: string): Parsed {
  const code = stripNonCode(blankImports(raw));
  const lines = code.split(/\r?\n/);

  const decls: Decl[] = [];
  const starts: { name: string; exported: boolean; runtime: boolean; index: number }[] = [];
  lines.forEach((text, idx) => {
    const m = DECL_RE.exec(text);
    if (m) {
      starts.push({
        name: m[3]!,
        exported: Boolean(m[1]),
        runtime: !TYPE_ONLY.has(m[2]!.trim()),
        index: idx,
      });
    }
  });
  starts.forEach((s, k) => {
    const nextIndex = k + 1 < starts.length ? starts[k + 1]!.index : lines.length;
    decls.push({
      name: s.name,
      exported: s.exported,
      runtime: s.runtime,
      line: s.index + 1,
      endLine: nextIndex,
    });
  });

  const owners: string[] = new Array(lines.length).fill(MODULE_OWNER);
  for (const d of decls) {
    for (let l = d.line - 1; l < d.endLine && l < owners.length; l++) owners[l] = d.name;
  }

  const refsByOwner = new Map<string, Set<string>>();
  lines.forEach((text, idx) => {
    const owner = owners[idx] ?? MODULE_OWNER;
    let bucket = refsByOwner.get(owner);
    if (!bucket) {
      bucket = new Set<string>();
      refsByOwner.set(owner, bucket);
    }
    for (const m of text.matchAll(IDENT_RE)) bucket.add(m[0]);
  });

  return { file, decls, refsByOwner, raw };
}

/**
 * parseFile is pure, so a per-(file, exact source) cache is safe. The non-vacuity
 * sweep below re-analyses the whole tree once per candidate call site; without this
 * it would re-parse ~150 unchanged files every time.
 */
const parseCache = new Map<string, { raw: string; parsed: Parsed }>();
function parseCached(file: string, raw: string): Parsed {
  const hit = parseCache.get(file);
  if (hit && hit.raw === raw) return hit.parsed;
  const parsed = parseFile(file, raw);
  parseCache.set(file, { raw, parsed });
  return parsed;
}

function isLib(file: string): boolean {
  return file.startsWith("src/lib/");
}

interface GuardRecord {
  readonly file: string;
  readonly symbol: string;
  readonly line: number;
  readonly kinds: string[];
  readonly live: boolean;
}

/**
 * Mark every guard in the tree live or dead.
 *
 * Seeds are references from production files OUTSIDE src/lib (src/tools, src/index.ts,
 * src/rpc.ts, src/governor, …). Liveness then propagates backwards through src/lib:
 * a lib symbol referenced from the body of a live symbol is itself live. That is what
 * keeps `assertChainCoherence` (called only by `runBroadcastGuards`, which the tools
 * call) and `findAddSettingsActions` (a private step of a wired trap check) out of the
 * report, while still catching a guard whose only "caller" is another dead guard.
 */
function analyze(tree: Tree): GuardRecord[] {
  const parsed = [...tree.entries()].map(([f, s]) => parseCached(f, s));

  const declaredIn = new Map<string, Set<string>>();
  for (const p of parsed) {
    for (const d of p.decls) {
      let files = declaredIn.get(d.name);
      if (!files) {
        files = new Set<string>();
        declaredIn.set(d.name, files);
      }
      files.add(p.file);
    }
  }

  const key = (file: string, symbol: string) => `${file}::${symbol}`;
  const edges = new Map<string, Set<string>>();
  const seeds: string[] = [];

  for (const p of parsed) {
    for (const [owner, refs] of p.refsByOwner) {
      for (const name of refs) {
        const targets = declaredIn.get(name);
        if (!targets) continue;
        for (const targetFile of targets) {
          const target = key(targetFile, name);
          if (!isLib(p.file)) {
            // Production code outside src/lib — an unconditional seed.
            seeds.push(target);
            continue;
          }
          const from = key(p.file, owner);
          if (from === target) continue; // the declaration naming itself
          let outs = edges.get(from);
          if (!outs) {
            outs = new Set<string>();
            edges.set(from, outs);
          }
          outs.add(target);
        }
      }
    }
  }

  const live = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const k = queue.pop()!;
    if (live.has(k)) continue;
    live.add(k);
    for (const t of edges.get(k) ?? []) queue.push(t);
  }

  const out: GuardRecord[] = [];
  for (const p of parsed) {
    if (!isLib(p.file)) continue;
    for (const d of p.decls) {
      // Exported values only. An `interface AddSettingsTrap` matches the name
      // rules but is erased at compile time, so it can neither protect nor fail
      // to protect anything — reporting it would be noise, not a finding.
      if (!d.exported || !d.runtime) continue;
      const kinds = guardKinds(d.name);
      if (kinds.length === 0) continue;
      out.push({
        file: p.file,
        symbol: d.name,
        line: d.line,
        kinds,
        live: live.has(key(p.file, d.name)),
      });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** First sentence of the guard's doc comment — what it CLAIMS to protect. */
function docSummary(raw: string, line: number): string {
  const lines = raw.split(/\r?\n/);
  const collected: string[] = [];
  for (let i = line - 2; i >= 0 && i >= line - 30; i--) {
    const t = lines[i]!.trim();
    if (t.startsWith("*/") || t === "") continue;
    if (t.startsWith("*") || t.startsWith("/**") || t.startsWith("//")) {
      collected.unshift(t.replace(/^\/\*\*|^\*\/|^\*|^\/\//, "").trim());
      continue;
    }
    break;
  }
  const text = collected.filter(Boolean).join(" ").replace(/\s+/g, " ");
  if (!text) return "(no doc comment — it does not even say what it protects)";
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

function render(dead: GuardRecord[], tree: Tree): string {
  return [
    `${dead.length} guard(s) under src/lib are DEAD — exported, named as a protection, and`,
    "called from nothing in production. A guard that is not on the path is worse than no",
    "guard: the doc comment, the unit test and the CHANGELOG all claim a protection the",
    "user does not have, so nobody goes looking for the hole again.",
    "",
    ...dead.flatMap((g) => [
      `  ${g.file}:${g.line}  ${g.symbol}   [${g.kinds.join(", ")}]`,
      `      claims: ${docSummary(tree.get(g.file) ?? "", g.line)}`,
      "      reality: no file under src/ outside its own module ever references it.",
      "               (tests do not count — a guard tested in isolation passes whether",
      "                or not anything calls it. That is how this shipped.)",
      "",
    ]),
    "Fix exactly ONE of:",
    "",
    "  1. Wire it into the SINGLE function every relevant path already funnels through.",
    "     Not into several call sites — that is how 0.32.0 shipped a denylist that a",
    "     second entrypoint walked straight past.",
    "  2. Delete it, together with the unit test and the doc line that advertise it.",
    "  3. If it genuinely protects nothing by design, say so where the claim is made:",
    "         // guard-unwired-allowed: <why this one is not on a path>",
    '     anywhere in its doc comment. Greppable (rg "guard-unwired-allowed" src/) and',
    "     reviewed with the file that made the promise, never as a silent list in a test.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Loading the real tree
// ---------------------------------------------------------------------------

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function loadTree(): Tree {
  const tree: Tree = new Map();
  for (const abs of tsFilesUnder(SRC)) {
    tree.set(relative(REPO, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
  }
  return tree;
}

function isExemptInSource(tree: Tree, g: GuardRecord): boolean {
  const lines = (tree.get(g.file) ?? "").split(/\r?\n/);
  const window = lines.slice(Math.max(0, g.line - 1 - 20), g.line).join("\n");
  return EXEMPTION_MARKER.test(window);
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe("no dead guards under src/lib", () => {
  const tree = loadTree();
  const guards = analyze(tree);
  const grandfathered = new Set(KNOWN_UNWIRED.map((k) => k.symbol));

  it("found guards to check at all — otherwise every assertion here is vacuous", () => {
    // A rename sweep or a change to the declaration shape must not be allowed to
    // quietly turn this whole file into a no-op.
    expect(guards.length, "no exported guard-shaped symbols found under src/lib").toBeGreaterThan(20);
    expect(
      guards.some((g) => g.file === "src/lib/protocolAdvisories.ts"),
      "src/lib/protocolAdvisories.ts contributed no guards — did the module move?",
    ).toBe(true);
    expect(
      guards.filter((g) => g.live).length,
      "nothing at all reported live — the reachability analysis is broken",
    ).toBeGreaterThan(10);
  });

  it("every guard is wired into a production path", () => {
    const dead = guards.filter(
      (g) => !g.live && !grandfathered.has(g.symbol) && !isExemptInSource(tree, g),
    );
    expect(dead, render(dead, tree)).toEqual([]);
  });

  it("the grandfather list has no stale entries", () => {
    // The list may only ever get shorter. An entry that has been wired up or
    // deleted must be removed from it, so the debt cannot quietly rot in place
    // and cannot be reused as cover for a newly dead guard.
    const stale = KNOWN_UNWIRED.filter((k) => {
      const g = guards.find((x) => x.symbol === k.symbol && x.file === k.file);
      return g === undefined || g.live;
    }).map((k) => `${k.file}::${k.symbol}`);
    expect(
      stale,
      `KNOWN_UNWIRED entries that are no longer dead (wire-up landed, or the symbol was ` +
        `renamed/deleted). Delete them from tests/lib/no-dead-guards.test.ts — this list is ` +
        `allowed to shrink and nothing else:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every grandfathered entry carries a real reason", () => {
    for (const k of KNOWN_UNWIRED) {
      expect(k.reason.length, `${k.symbol} is exempt with no reason`).toBeGreaterThan(40);
      expect(k.file.startsWith("src/"), `${k.symbol} has a bogus file path`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Proof the rule is not vacuous
// ---------------------------------------------------------------------------

describe("the rule actually detects a dead guard", () => {
  it("flags a REAL guard the moment its only call site is deleted", () => {
    // The strongest available proof: take the live tree, delete the call sites of
    // one genuinely-wired guard, and confirm the analysis flips it to dead. Chosen
    // dynamically, so this keeps proving itself as call sites move around.
    const tree = loadTree();
    const before = analyze(tree);
    const liveGuards = before.filter((g) => g.live);
    expect(liveGuards.length, "no live guards to falsify against").toBeGreaterThan(0);

    let proof: { symbol: string; removedFrom: string } | null = null;

    for (const g of liveGuards) {
      const callers = [...tree.keys()]
        .filter((f) => f !== g.file && new RegExp(`(?<![\\w$])${g.symbol}(?![\\w$])`).test(tree.get(f)!))
        .sort();
      if (callers.length === 0 || callers.length > 3) continue;
      const mutated: Tree = new Map(tree);
      for (const c of callers) {
        mutated.set(
          c,
          tree.get(c)!.replace(new RegExp(`(?<![\\w$])${g.symbol}(?![\\w$])`, "g"), "__deleted_call_site__"),
        );
      }
      const after = analyze(mutated);
      const rec = after.find((x) => x.file === g.file && x.symbol === g.symbol);
      if (rec && !rec.live) {
        proof = { symbol: g.symbol, removedFrom: callers.join(", ") };
        // The failure message must NAME the guard, not just count it.
        expect(render([rec], mutated)).toContain(g.symbol);
        expect(render([rec], mutated)).toContain("DEAD");
        break;
      }
    }

    expect(
      proof,
      "removing the call sites of every live guard left them all reported live — the " +
        "reachability analysis is not reading call sites, so this whole file is a no-op",
    ).not.toBeNull();
  });

  it("counts only real call sites — not comments, strings, or unused imports", () => {
    const tree: Tree = new Map([
      [
        "src/lib/guards.ts",
        [
          "export function checkAlpha() { return 1; }",
          "export function checkBeta() { return 2; }",
          "export function checkGamma() { return 3; }",
          "export function checkDelta() { return 4; }",
          "function helper() { return checkDelta(); }",
          "export function checkEpsilon() { return helper(); }",
          "export function checkZeta() { return 6; }",
          "export function checkEta() { return 7; }",
          "/** checkTheta is named right here, in its own doc comment, and nowhere else. */",
          "export function checkTheta() { return 8; }",
          "export interface checkIota { readonly x: number }",
        ].join("\n"),
      ],
      [
        "src/tools/thing.ts",
        [
          'import { checkBeta, checkEpsilon, checkZeta } from "../lib/guards.js";',
          "// checkAlpha is named only in this comment",
          'const note = "checkGamma is named only inside this string literal";',
          "export function run(x: number) {",
          "  return checkEpsilon() + Number(`${checkZeta()}`) + Number(`checkEta ${x}`) + note.length;",
          "}",
        ].join("\n"),
      ],
    ]);

    const byName = new Map(analyze(tree).map((g) => [g.symbol, g.live]));

    expect(byName.get("checkEpsilon"), "a plain call must count").toBe(true);
    expect(byName.get("checkDelta"), "reached through a private helper of a live guard").toBe(true);
    expect(byName.get("checkZeta"), "a call inside a template ${} expression is a call").toBe(true);

    expect(byName.get("checkAlpha"), "a comment is not a call site").toBe(false);
    expect(byName.get("checkGamma"), "a string literal is not a call site").toBe(false);
    expect(byName.get("checkEta"), "template literal TEXT is not a call site").toBe(false);
    expect(byName.get("checkBeta"), "an unused import is not a call site").toBe(false);
    expect(byName.get("checkTheta"), "being described in a doc comment is not being called").toBe(false);

    expect(
      byName.has("checkIota"),
      "an interface is erased at compile time — it cannot guard anything, so it must not be reported",
    ).toBe(false);
  });

  it("does not let one dead guard keep another alive", () => {
    // The failure mode that makes a naive 'is it imported anywhere' check useless:
    // two guards that only call each other, wired to nothing.
    const tree: Tree = new Map([
      [
        "src/lib/pair.ts",
        [
          "export function checkOuter(x: number) { return checkInner(x); }",
          "export function checkInner(x: number) { return x > 0; }",
        ].join("\n"),
      ],
      ["src/tools/none.ts", "export function run() { return 1; }"],
    ]);
    const byName = new Map(analyze(tree).map((g) => [g.symbol, g.live]));
    expect(byName.get("checkOuter")).toBe(false);
    expect(byName.get("checkInner"), "called only by a dead guard is still dead").toBe(false);
  });

  it("honours an in-source exemption that carries a reason", () => {
    const raw = [
      "/**",
      " * Kept for the CLI surface only.",
      " * guard-unwired-allowed: reference implementation quoted by docs/SECURITY.md.",
      " */",
      "export function checkOrphan() { return true; }",
    ].join("\n");
    const tree: Tree = new Map([["src/lib/orphan.ts", raw]]);
    const g = analyze(tree).find((x) => x.symbol === "checkOrphan")!;
    expect(g.live).toBe(false);
    expect(isExemptInSource(tree, g), "marker in the doc comment must exempt it").toBe(true);

    const unmarked: Tree = new Map([
      ["src/lib/orphan.ts", raw.replace(/ \* guard-unwired-allowed.*\n/, "")],
    ]);
    const g2 = analyze(unmarked).find((x) => x.symbol === "checkOrphan")!;
    expect(isExemptInSource(unmarked, g2), "no marker, no exemption").toBe(false);
  });

  it("names the dead guard and what its deadness means", () => {
    const tree: Tree = new Map([
      [
        "src/lib/x.ts",
        ["/** Refuses a vesting tier that would strand funds. */", "export function checkVestingTrap() { return true; }"].join(
          "\n",
        ),
      ],
    ]);
    const dead = analyze(tree).filter((g) => !g.live);
    const msg = render(dead, tree);
    expect(msg).toContain("checkVestingTrap");
    expect(msg).toContain("src/lib/x.ts:2");
    expect(msg).toContain("Refuses a vesting tier that would strand funds.");
    expect(msg).toContain("claim a protection the");
    expect(msg).toContain("guard-unwired-allowed");
  });
});
