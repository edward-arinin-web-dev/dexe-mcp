import { describe, it, expect } from "vitest";
import {
  EXPECT_OPS,
  evaluateExpect,
  resolvePathStrict,
  validateStepExpectations,
  type Expectation,
} from "../../scripts/swarm/expect.js";

// NEVER import scripts/swarm/orchestrator.ts here — it calls main() at module
// scope and fail() is process.exit(1); a vitest import would kill the worker.

const one = (exp: Expectation, root: Record<string, unknown>) => evaluateExpect([exp], root)[0]!;

describe("resolvePathStrict", () => {
  it("distinguishes a missing key from a present undefined/null value", () => {
    const root = { a: { b: null, c: undefined, d: "" } } as Record<string, unknown>;
    expect(resolvePathStrict("a.b", root)).toEqual({ found: true, value: null });
    expect(resolvePathStrict("a.c", root)).toEqual({ found: true, value: undefined });
    expect(resolvePathStrict("a.d", root)).toEqual({ found: true, value: "" });
    expect(resolvePathStrict("a.missing", root).found).toBe(false);
    expect(resolvePathStrict("a.b.deeper", root).found).toBe(false);
  });

  it("indexes arrays and exposes .length for arrays only", () => {
    const root = { steps: [{ skipped: true }, { skipped: false }], name: "abcdef" };
    expect(resolvePathStrict("steps.0.skipped", root)).toEqual({ found: true, value: true });
    expect(resolvePathStrict("steps.length", root)).toEqual({ found: true, value: 2 });
    expect(resolvePathStrict("steps.9", root).found).toBe(false);
    // a string's .length is deliberately NOT addressable
    expect(resolvePathStrict("name.length", root).found).toBe(false);
  });
});

describe("evaluateExpect — comparison semantics", () => {
  const root = {
    created: { proposalId: "7", mode: "payloads", steps: [{ skipped: false }] },
    built: { actions: [{ executor: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" }] },
    state: { state: "Voting" },
    bal: { wei: "12000000000000000000001" },
    empty: { s: "", n: null },
  };

  const cases: Array<[string, Expectation, boolean]> = [
    ["eq matches JSON number against a captured string", { path: "created.proposalId", op: "eq", value: 7 }, true],
    ["eq is case-insensitive for 20-byte addresses", {
      path: "built.actions.0.executor",
      op: "eq",
      value: "0xabcdef0123456789abcdef0123456789abcdef01",
    }, true],
    ["eq fails on a different address", {
      path: "built.actions.0.executor",
      op: "eq",
      value: "0x0000000000000000000000000000000000000001",
    }, false],
    ["ne passes on a real difference", { path: "created.mode", op: "ne", value: "already-created" }, true],
    ["in matches one of the canonical states", {
      path: "state.state",
      op: "in",
      value: ["Voting", "SucceededFor", "ExecutedFor"],
    }, true],
    ["notIn rejects a member", { path: "state.state", op: "notIn", value: ["Voting"] }, false],
    ["contains on a string", { path: "created.mode", op: "contains", value: "payload" }, true],
    ["matches on a regex", { path: "created.mode", op: "matches", value: "^pay" }, true],
    ["present on an empty string", { path: "empty.s", op: "present" }, true],
    ["present on a null value", { path: "empty.n", op: "present" }, true],
    ["absent on a present key fails", { path: "empty.n", op: "absent" }, false],
    ["absent on a missing key passes", { path: "empty.nope", op: "absent" }, true],
    ["gte compares wei as BigInt, not Number", {
      path: "bal.wei",
      op: "gte",
      value: "12000000000000000000000",
    }, true],
    ["lte on the same wei pair fails", {
      path: "bal.wei",
      op: "lte",
      value: "12000000000000000000000",
    }, false],
    ["eq on a boolean captured as boolean", { path: "created.steps.0.skipped", op: "eq", value: false }, true],
  ];

  for (const [name, exp, ok] of cases) {
    it(name, () => {
      expect(one(exp, root).ok).toBe(ok);
    });
  }

  it("gte over 2^53 would be wrong via Number — BigInt keeps it exact", () => {
    // Number("12000000000000000000001") === Number("12000000000000000000000")
    expect(Number("12000000000000000000001")).toBe(Number("12000000000000000000000"));
    expect(one({ path: "bal.wei", op: "gte", value: "12000000000000000000001" }, root).ok).toBe(true);
    expect(one({ path: "bal.wei", op: "gte", value: "12000000000000000000002" }, root).ok).toBe(false);
  });

  it("gte on a non-numeric actual fails and says so", () => {
    const r = one({ path: "created.mode", op: "gte", value: "1" }, root);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not numeric/);
  });

  it("an unresolved path fails EVERY op except absent, naming the path", () => {
    for (const op of EXPECT_OPS) {
      const r = one({ path: "created.nope", op, value: ["x"] } as Expectation, root);
      if (op === "absent") {
        expect(r.ok, `absent should pass on a missing path`).toBe(true);
        continue;
      }
      expect(r.ok, `${op} must not pass on an unresolved path`).toBe(false);
      expect(r.message).toContain("created.nope");
      if (op !== "present") expect(r.message).toMatch(/did not resolve/);
    }
  });

  it("an unknown op returns ok:false and never throws", () => {
    const r = one({ path: "created.mode", op: "equals" as never, value: "payloads" }, root);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unknown expect op 'equals'/);
  });

  it("returns one result per expectation, passing ones included (JSONL evidence)", () => {
    const results = evaluateExpect(
      [
        { path: "created.mode", op: "eq", value: "payloads" },
        { path: "created.proposalId", op: "present" },
      ],
      root,
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]!.actual).toBe("payloads");
  });

  it("no expectations means no assertions", () => {
    expect(evaluateExpect([], root)).toEqual([]);
  });
});

describe("validateStepExpectations", () => {
  const wrap = (steps: unknown[]) => validateStepExpectations({ id: "S99-x", steps });

  it("accepts a well-formed step asserting on its own capture", () => {
    expect(
      wrap([
        {
          step: 1,
          agent: "A",
          tool: "dexe_proposal_create",
          args: {},
          broadcast: false,
          captureAs: "created",
          expect: [{ path: "created.mode", op: "eq", value: "dryRun" }],
        },
      ]),
    ).toEqual([]);
  });

  it("rejects a misspelled step key instead of ignoring it", () => {
    const errs = wrap([{ step: 1, tool: "t", args: {}, expcet: [] }]);
    expect(errs.join(" ")).toMatch(/unknown key 'expcet'/);
  });

  it("rejects an unknown op", () => {
    const errs = wrap([
      { step: 2, tool: "t", args: {}, captureAs: "c", expect: [{ path: "c.x", op: "equals", value: 1 }] },
    ]);
    expect(errs.join(" ")).toMatch(/op 'equals' is not one of/);
  });

  it("rejects eq with no value", () => {
    const errs = wrap([{ step: 3, tool: "t", args: {}, captureAs: "c", expect: [{ path: "c.x", op: "eq" }] }]);
    expect(errs.join(" ")).toMatch(/op 'eq' needs a 'value'/);
  });

  it("accepts present/absent with no value", () => {
    expect(
      wrap([{ step: 4, tool: "t", args: {}, captureAs: "c", expect: [{ path: "c.x", op: "present" }] }]),
    ).toEqual([]);
  });

  it("rejects a path root that no earlier step captures", () => {
    const errs = wrap([
      { step: 1, tool: "t", args: {}, captureAs: "first", expect: [{ path: "later.x", op: "present" }] },
    ]);
    expect(errs.join(" ")).toMatch(/path root 'later'/);
  });

  it("allows a later step to reference an earlier capture, and the reserved roots", () => {
    expect(
      wrap([
        { step: 1, tool: "t", args: {}, captureAs: "first" },
        { step: 2, tool: "t", args: {}, expect: [{ path: "first.proposalId", op: "present" }] },
        { step: 3, tool: "t", args: {}, expect: [{ path: "result.mode", op: "eq", value: "dryRun" }] },
      ]),
    ).toEqual([]);
  });

  it("rejects a non-string expectError", () => {
    const errs = wrap([{ step: 1, tool: "t", args: {}, expectError: 42 }]);
    expect(errs.join(" ")).toMatch(/expectError must be a string/);
  });
});
