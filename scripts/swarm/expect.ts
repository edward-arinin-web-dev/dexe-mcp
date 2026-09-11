/**
 * Swarm assertion engine — pure, dependency-free, side-effect-free.
 *
 * WHY THIS IS A SEPARATE MODULE: `orchestrator.ts` calls `main()` at module
 * scope and `fail()` there is `process.exit(1)`. Importing it from a vitest
 * file would launch a real swarm run inside the test worker and kill it. Every
 * testable helper the harness grows must live somewhere with no top-level
 * statements — here.
 *
 * Until 0.34.0 the harness had NO assertion layer at all: a scenario "passed"
 * whenever no step threw (`orchestrator.ts` — `stepsLog.every(s => s.status !==
 * "fail")`), and the prose `successCriteria[].check` on all 62 scenarios was
 * read by nothing. Every 0.30–0.33 write-path guard is a SILENT behaviour
 * (dedupe returns `already-created` instead of a second tx; the vote leg
 * returns `voteAlreadyCast` instead of reverting), so a regression to the
 * pre-0.33 behaviour would still have reported ✅.
 *
 * `steps[].expect` / `steps[].expectError` are the machine-checked half.
 */

export type ExpectOp =
  | "eq"
  | "ne"
  | "in"
  | "notIn"
  | "contains"
  | "matches"
  | "present"
  | "absent"
  | "gte"
  | "lte";

export const EXPECT_OPS: readonly ExpectOp[] = [
  "eq",
  "ne",
  "in",
  "notIn",
  "contains",
  "matches",
  "present",
  "absent",
  "gte",
  "lte",
] as const;

/** Ops that carry no `value` — supplying one is a schema mistake, not fatal. */
const VALUELESS_OPS = new Set<ExpectOp>(["present", "absent"]);

export interface Expectation {
  path: string;
  op: ExpectOp;
  value?: unknown;
  note?: string;
}

export interface AssertionResult {
  path: string;
  op: ExpectOp;
  value: unknown;
  actual: unknown;
  found: boolean;
  ok: boolean;
  message?: string;
}

/** Step keys the orchestrator understands. An unknown key is a silent no-op
 * otherwise, which is exactly how `successCriteria` rotted. */
export const KNOWN_STEP_KEYS = [
  "step",
  "agent",
  "tool",
  "args",
  "broadcast",
  "captureAs",
  "skipIf",
  "comment",
  "expect",
  "expectError",
  "serverSign",
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INT_RE = /^-?\d+$/;

/**
 * Dotted-path resolver that distinguishes "resolved to undefined" from "did not
 * resolve". `orchestrator.ts`'s own `resolvePath` collapses both to
 * `undefined`, which would make `ne` / `notIn` / `absent` trivially true on a
 * typo'd path — the silent-pass trap this whole module exists to close.
 *
 * Keeps the array `.length` shortcut the orchestrator already has (arrays
 * only — a string's `.length` is not addressable, by design, so a scenario
 * cannot accidentally assert on the character count of an address).
 */
export function resolvePathStrict(
  path: string,
  root: Record<string, unknown>,
): { found: boolean; value: unknown } {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return { found: false, value: undefined };
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (part === "length" && Array.isArray(cur)) {
      cur = cur.length;
      continue;
    }
    if (Array.isArray(cur)) {
      if (!INT_RE.test(part)) return { found: false, value: undefined };
      const idx = Number(part);
      if (idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object") return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
}

/**
 * Normalized scalar compare.
 *  - two 20-byte addresses compare case-insensitively (the allowlist env is
 *    arbitrary case while builder output is checksummed — the orchestrator
 *    already lowercases for exactly this reason).
 *  - everything else compares as `String(a) === String(b)`, so JSON `7`
 *    matches a captured `"7"` and `true` matches `"true"`. Captures are
 *    BigInt-stringified all over the orchestrator; a scenario author writing
 *    the number is right, not wrong.
 */
function sameScalar(a: unknown, b: unknown): boolean {
  const sa = a === null || a === undefined ? "" : String(a);
  const sb = b === null || b === undefined ? "" : String(b);
  if (ADDRESS_RE.test(sa) && ADDRESS_RE.test(sb)) return sa.toLowerCase() === sb.toLowerCase();
  return sa === sb;
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** BigInt when both sides are integral strings (wei exceeds 2^53), else Number. */
function compareNumeric(actual: unknown, expected: unknown): number | null {
  const sa = String(actual ?? "");
  const sb = String(expected ?? "");
  if (INT_RE.test(sa) && INT_RE.test(sb)) {
    const a = BigInt(sa);
    const b = BigInt(sb);
    return a === b ? 0 : a > b ? 1 : -1;
  }
  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
  return na === nb ? 0 : na > nb ? 1 : -1;
}

function evaluateOne(exp: Expectation, root: Record<string, unknown>): AssertionResult {
  const { found, value: actual } = resolvePathStrict(exp.path, root);
  const base = { path: exp.path, op: exp.op, value: exp.value, actual, found };

  if (!EXPECT_OPS.includes(exp.op)) {
    return {
      ...base,
      ok: false,
      message:
        `expect ${exp.path}: unknown expect op '${String(exp.op)}' ` +
        `(supported: ${EXPECT_OPS.join(", ")})`,
    };
  }

  // An unresolved path fails EVERY op except `absent`. Without this rule
  // `ne` / `notIn` pass trivially on a typo'd path — a green assertion that
  // asserts nothing.
  if (!found && exp.op !== "absent") {
    return {
      ...base,
      ok: false,
      message: `expect ${exp.path} ${exp.op} ${fmt(exp.value)} — path did not resolve`,
    };
  }

  const fail = (why: string): AssertionResult => ({
    ...base,
    ok: false,
    message: `expect ${exp.path} ${exp.op} ${fmt(exp.value)} — ${why}`,
  });
  const pass = (): AssertionResult => ({ ...base, ok: true });

  switch (exp.op) {
    case "present":
      return found ? pass() : fail("path did not resolve");
    case "absent":
      return found ? fail(`got ${fmt(actual)}`) : pass();
    case "eq":
      return sameScalar(actual, exp.value) ? pass() : fail(`got ${fmt(actual)}`);
    case "ne":
      return sameScalar(actual, exp.value) ? fail(`got ${fmt(actual)}`) : pass();
    case "in":
    case "notIn": {
      if (!Array.isArray(exp.value)) return fail(`'${exp.op}' needs an array value, got ${fmt(exp.value)}`);
      const hit = exp.value.some((v) => sameScalar(actual, v));
      if (exp.op === "in") return hit ? pass() : fail(`got ${fmt(actual)}`);
      return hit ? fail(`got ${fmt(actual)}`) : pass();
    }
    case "contains": {
      if (Array.isArray(actual)) {
        return actual.some((v) => sameScalar(v, exp.value)) ? pass() : fail(`got ${fmt(actual)}`);
      }
      const hay = actual === null || actual === undefined ? "" : String(actual);
      const needle = exp.value === null || exp.value === undefined ? "" : String(exp.value);
      return hay.includes(needle) ? pass() : fail(`got ${fmt(actual)}`);
    }
    case "matches": {
      let re: RegExp;
      try {
        re = new RegExp(String(exp.value));
      } catch {
        return fail(`'${String(exp.value)}' is not a valid regular expression`);
      }
      return re.test(String(actual ?? "")) ? pass() : fail(`got ${fmt(actual)}`);
    }
    case "gte":
    case "lte": {
      const cmp = compareNumeric(actual, exp.value);
      if (cmp === null) return fail(`actual is not numeric (${fmt(actual)})`);
      const ok = exp.op === "gte" ? cmp >= 0 : cmp <= 0;
      return ok ? pass() : fail(`got ${fmt(actual)}`);
    }
    default:
      return fail("unreachable");
  }
}

/**
 * Evaluate every expectation and return one result each — INCLUDING the
 * passing ones, so the JSONL state log keeps the evidence of what was checked.
 * Never throws: a schema typo in a scenario must not crash a live broadcast
 * run half way through.
 */
export function evaluateExpect(
  expectations: Expectation[],
  root: Record<string, unknown>,
): AssertionResult[] {
  if (!Array.isArray(expectations) || expectations.length === 0) return [];
  return expectations.map((e) => evaluateOne(e, root));
}

/** Shape of one step as it appears in scenario JSON, before validation. */
interface RawStep {
  step?: unknown;
  tool?: unknown;
  captureAs?: unknown;
  expect?: unknown;
  expectError?: unknown;
  [k: string]: unknown;
}

/** Roots an `expect` path may start from, beyond an earlier step's captureAs. */
export const EXPECT_ROOTS = ["result", "self"] as const;

/**
 * Load-time validation of a scenario's `steps[]`. Returns human-readable
 * errors ([] when clean) — the orchestrator turns them into a `fail()`.
 *
 * `_schema.md` claimed "The orchestrator validates this on load" since Phase 0
 * while `loadScenarios` did a bare `JSON.parse(...) as ScenarioSpec`. A
 * misspelled `expcet:` key or an unknown op would be dropped in silence,
 * re-introducing the exact decorative-assertion bug this module fixes.
 */
export function validateStepExpectations(spec: unknown): string[] {
  const errors: string[] = [];
  const s = spec as { id?: unknown; steps?: unknown };
  const steps = Array.isArray(s?.steps) ? (s.steps as RawStep[]) : [];
  const declaredCaptures = new Set<string>();

  for (const step of steps) {
    const label = `step ${String(step?.step ?? "?")}`;
    // A step may assert on its OWN capture: the orchestrator stores the capture
    // before it evaluates the assertions, so `{{captureAs}}.field` resolves for
    // the step that produced it. Every other root must already exist.
    const ownCapture = typeof step?.captureAs === "string" ? step.captureAs : null;
    const visibleCaptures = new Set(declaredCaptures);
    if (ownCapture) visibleCaptures.add(ownCapture);

    for (const key of Object.keys(step ?? {})) {
      if (!(KNOWN_STEP_KEYS as readonly string[]).includes(key)) {
        errors.push(
          `${label}: unknown key '${key}' (known: ${KNOWN_STEP_KEYS.join(", ")}) — ` +
            `it would be silently ignored`,
        );
      }
    }

    if (step?.expectError !== undefined && typeof step.expectError !== "string") {
      errors.push(`${label}: expectError must be a string substring of the expected error`);
    }

    if (step?.expect !== undefined) {
      if (!Array.isArray(step.expect)) {
        errors.push(`${label}: expect must be an array of {path, op, value?}`);
      } else {
        step.expect.forEach((rawExp, i) => {
          const where = `${label} expect[${i}]`;
          const e = rawExp as Partial<Expectation> | null;
          if (!e || typeof e !== "object") {
            errors.push(`${where}: must be an object {path, op, value?}`);
            return;
          }
          for (const key of Object.keys(e)) {
            if (!["path", "op", "value", "note"].includes(key)) {
              errors.push(`${where}: unknown key '${key}' (known: path, op, value, note)`);
            }
          }
          if (typeof e.path !== "string" || e.path.length === 0) {
            errors.push(`${where}: path must be a non-empty dotted string`);
          }
          if (typeof e.op !== "string" || !(EXPECT_OPS as readonly string[]).includes(e.op)) {
            errors.push(`${where}: op '${String(e.op)}' is not one of ${EXPECT_OPS.join(", ")}`);
          } else if (!VALUELESS_OPS.has(e.op as ExpectOp) && e.value === undefined) {
            errors.push(`${where}: op '${e.op}' needs a 'value'`);
          }
          if (typeof e.path === "string" && e.path.length > 0) {
            const head = e.path.split(".")[0]!;
            if (!(EXPECT_ROOTS as readonly string[]).includes(head) && !visibleCaptures.has(head)) {
              errors.push(
                `${where}: path root '${head}' is neither ${EXPECT_ROOTS.join("/")} nor a captureAs ` +
                  `of this or an earlier step (visible here: ${
                    visibleCaptures.size ? [...visibleCaptures].join(", ") : "none"
                  })`,
              );
            }
          }
        });
      }
    }

    if (ownCapture && ownCapture.length > 0) declaredCaptures.add(ownCapture);
  }

  return errors;
}
