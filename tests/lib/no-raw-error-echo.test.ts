import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * W36 regression guard — the inline `err instanceof Error ? err.message :
 * String(err)` ternary must not come back.
 *
 * ethers v6 appends the full provider URL to `err.message` on any non-2xx
 * response (401/429/5xx are routine under load), so a call site that echoes the
 * raw message prints the operator's Alchemy/Infura/QuickNode API key straight
 * into the tool result — the model context, the transcript, and any log that
 * captures either. `src/lib/redact.ts` exists precisely to stop that, and it
 * only helps if every call site actually routes through it.
 *
 * There is no eslint config in this repo, so this test IS the lint rule.
 *
 * No allowlist, deliberately. A call site that genuinely needs the unredacted
 * text must say so through a named helper (so the exemption is greppable and
 * reviewable) rather than by re-inlining the ternary.
 *
 * Fix a failure with one of:
 *   - `safeErrorMessage(err)`                  — src/lib/redact.ts
 *   - `toActionableError(err, step).message`   — src/lib/errors.ts (also redacts)
 */

const SRC = resolve(__dirname, "..", "..", "src");

/**
 * Equivalent spellings of "hand me the raw message". Kept as separate patterns
 * rather than one clever regex so a failure names the exact shape that matched.
 * `\1` pins all three positions to the same identifier — that is what makes
 * this an error-echo matcher and not a match on every `instanceof Error`
 * narrowing check (e.g. `err instanceof Error && err.name === "AbortError"`,
 * which is legitimate and must keep passing).
 */
const FORBIDDEN: ReadonlyArray<{ label: string; re: RegExp }> = [
  {
    label: "err instanceof Error ? err.message : String(err)",
    re: /\b([A-Za-z_$][\w$]*) instanceof Error \? \1\.message : String\(\1\)/,
  },
  {
    label: "err instanceof Error ? err.message : `${err}`",
    re: /\b([A-Za-z_$][\w$]*) instanceof Error \? \1\.message : `\$\{\1\}`/,
  },
  {
    label: "!(err instanceof Error) ? String(err) : err.message",
    re: /!\(([A-Za-z_$][\w$]*) instanceof Error\) \? String\(\1\) : \1\.message/,
  },
  {
    label: "err instanceof Error ? err.message : ... (any tail)",
    re: /\b([A-Za-z_$][\w$]*) instanceof Error \? \1\.message :/,
  },
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  label: string;
  text: string;
}

/**
 * The sanctioned exemption. A few call sites READ the message to make a
 * decision rather than to show it — `isTransportError` in src/rpc.ts matches
 * `429` / `timeout` / `50x` tokens that redaction would strip, so redacting
 * there would silently reclassify a retryable failure as a permanent one.
 *
 * The marker must carry a reason, so the exemption is greppable AND reviewable
 * (`rg "raw-error-echo-allowed" src/`) rather than an invisible allowlist
 * living in this file. Text read for classification must never be emitted.
 */
const EXEMPTION_RE = /raw-error-echo-allowed:\s*\S+/;

function scan(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of tsFilesUnder(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      // The marker sits on the line itself or anywhere in the preceding doc
      // comment, so a helper can explain itself properly instead of trailing a
      // 200-character justification off the end of the code line.
      const preceding = lines.slice(Math.max(0, i - 12), i).join("\n");
      if (EXEMPTION_RE.test(text) || EXEMPTION_RE.test(preceding)) return;
      for (const { label, re } of FORBIDDEN) {
        if (re.test(text)) {
          hits.push({
            file: relative(resolve(__dirname, "..", ".."), file).split(sep).join("/"),
            line: i + 1,
            label,
            text: text.trim(),
          });
          return; // one report per line — the broadest pattern would double-count
        }
      }
    });
  }
  return hits;
}

function render(hits: Hit[]): string {
  const files = [...new Set(hits.map((h) => h.file))];
  return [
    `${hits.length} call site(s) in ${files.length} file(s) echo a raw caught error. ethers v6`,
    "appends the RPC URL (API key and all) to err.message on any non-2xx response, so these",
    "leak the operator's credentials into the model context and the transcript.",
    "",
    "Fix: replace the ternary with safeErrorMessage(<id>) — import { safeErrorMessage } from",
    '"…/lib/redact.js" — or toActionableError(<id>, step).message from "…/lib/errors.js"',
    "when the call site can also say what to do next.",
    "",
    ...hits.map((h) => `  ${h.file}:${h.line}  [${h.label}]\n      ${h.text}`),
  ].join("\n");
}

/**
 * The read surface is where a stalled/erroring endpoint is most likely to be
 * met, and where an unexplained failure does the most damage: an agent reads
 * "failed" as "no data" and reports an empty DAO. `read.ts` and `subgraph.ts`
 * are pure read files — every tool they register must hand its failures to the
 * actionable layer, labelled with its own name so the remedy's "re-run" advice
 * names a runnable call.
 */
const READ_SURFACE = ["read.ts", "subgraph.ts"] as const;

function registeredTools(source: string): string[] {
  return [...source.matchAll(/^\s*"(dexe_[a-z0-9_]+)",\s*$/gm)].map((m) => m[1]!);
}

describe("actionable-error wiring", () => {
  it.each(READ_SURFACE)("every tool in %s routes failures through toActionableError", (file) => {
    const source = readFileSync(join(SRC, "tools", file), "utf8");
    const tools = registeredTools(source);
    expect(tools.length, `no tools found in ${file} — did the registration shape change?`).toBeGreaterThan(0);
    const unwired = tools.filter(
      (t) => !new RegExp(`toActionableError\\([A-Za-z_$][\\w$]*, "${t}"\\)`).test(source),
    );
    expect(unwired, `${file}: not wired to the actionable layer: ${unwired.join(", ")}`).toEqual([]);
  });

  it("classifies the dexe_tx_send broadcast — the most common failure in the server", () => {
    // A throw out of wallet.sendTransaction used to escape the handler entirely
    // and surface as an ethers dump (RPC URL included). All three legs of the
    // send/status path must be classified.
    const source = readFileSync(join(SRC, "tools", "txSend.ts"), "utf8");
    for (const step of ["dexe_tx_send broadcast", "dexe_tx_send wait", "dexe_tx_status lookup"]) {
      expect(source, `txSend.ts must classify '${step}'`).toContain(`toActionableError(e, "${step}")`);
    }
  });
});

describe("no raw error echo in src/", () => {
  it("never inlines the raw-message ternary", () => {
    const hits = scan(SRC);
    expect(hits, render(hits)).toEqual([]);
  });

  it("matches the shapes it claims to (self-check)", () => {
    // Guards against a regex typo silently turning this whole file into a no-op.
    const positives = [
      "return err instanceof Error ? err.message : String(err);",
      "const m = e instanceof Error ? e.message : String(e);",
      "text: `boom: ${queryErr instanceof Error ? queryErr.message : String(queryErr)}`,",
      "const m = err instanceof Error ? err.message : `${err}`;",
      "const m = !(err instanceof Error) ? String(err) : err.message;",
    ];
    for (const p of positives) {
      expect(
        FORBIDDEN.some(({ re }) => re.test(p)),
        `should have been flagged: ${p}`,
      ).toBe(true);
    }

    // Legitimate narrowing and already-fixed call sites must NOT trip it.
    const negatives = [
      'if (err instanceof Error && err.name === "AbortError") {',
      "if (e instanceof BroadcastGuardError) return e.message;",
      "return safeErrorMessage(err);",
      'return toActionableError(err, "dexe_read_treasury").message;',
      "const label = err instanceof Error ? err.name : String(err);",
      "return a instanceof Error ? b.message : String(c);",
    ];
    for (const n of negatives) {
      expect(
        FORBIDDEN.some(({ re }) => re.test(n)),
        `should NOT have been flagged: ${n}`,
      ).toBe(false);
    }
  });
});
