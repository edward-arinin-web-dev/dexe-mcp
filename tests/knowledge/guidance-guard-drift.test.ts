import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { FLOW_BY_ID, GOTCHA_BY_ID } from "../../src/knowledge/index.js";
import { QUORUM_TURNOUT_CEILING } from "../../src/lib/quorumRisk.js";
import {
  resolveQuorumSplit,
  synthesizeParams,
  computeSafetyProof,
  SAFE_DEFAULT_TREASURY_PCT,
  SAFE_DEFAULT_QUORUM_PCT,
  type SimpleConfig,
} from "../../src/tools/daoCreate.js";

/**
 * THE GUIDANCE DRIFT GUARD — D2-1 / D2-2 / D2-6 / D7-1 / D15-5.
 *
 * 0.33.0 replaced the zero-margin reachability rule with a turnout-margin rule
 * and moved the SIMPLE default from 49% treasury to 30%. Every guidance surface
 * — the `dexe_guide` corpus, the shipped create-DAO skill, USAGE, USE_CASES and
 * the generated PLAYBOOK — kept recommending 49/51, the one config the tool now
 * answers with `mode:"blocked-risky"`. Following the guide produced a blocked
 * round-trip on the flagship flow; following only its treasury default produced
 * a hard error.
 *
 * The guard: take every numeric treasury/quorum recommendation that the corpus,
 * the skills and the docs make, and run it through the SAME functions
 * `dexe_dao_create` uses to accept or refuse a deploy. Prose cannot recommend
 * what the tool refuses.
 */
const root = resolve(__dirname, "..", "..");
const DEPLOYER = "0xdEADBEeF00000000000000000000000000000001";

const baseConfig = (treasuryPercent: number, quorumPercent: number): SimpleConfig => ({
  daoName: "Guidance Drift Guard",
  symbol: "GDG",
  totalSupply: "1000000",
  treasuryPercent,
  quorumPercent,
  voteModel: "LINEAR",
  durationSeconds: 86400,
  executionDelaySeconds: 0,
  minVotesTokens: "1",
  earlyCompletion: true,
});

/** The verdict `dexe_dao_create` itself reads (daoCreate.ts) for a (t, q) pair. */
function guardVerdict(treasuryPercent: number, quorumPercent: number) {
  const proof = computeSafetyProof(synthesizeParams(baseConfig(treasuryPercent, quorumPercent), DEPLOYER));
  return {
    ok: proof.marginOk && proof.floorOk && proof.reachable,
    why:
      proof.marginMessage ??
      (proof.floorOk ? "" : `quorum ${quorumPercent}% is below the 50% treasury-drain floor`),
    maxQuorumPct: proof.maxQuorumPct,
    minVotablePct: proof.minVotablePct,
    requiredTurnoutPct: proof.requiredTurnoutPct,
  };
}

/** Same, for an explicit vote model. */
function guardVerdict2(treasuryPercent: number, quorumPercent: number, voteModel: "LINEAR" | "POLYNOMIAL") {
  const proof = computeSafetyProof(
    synthesizeParams({ ...baseConfig(treasuryPercent, quorumPercent), voteModel }, DEPLOYER),
  );
  return { marginOk: proof.marginOk, floorOk: proof.floorOk, reachable: proof.reachable };
}

// ── LEG A — the structured corpus the guide actually serves ─────────────────
describe("LEG A — dexe_guide's create_dao interview offers a config the tool accepts", () => {
  const flow = FLOW_BY_ID.get("create_dao")!;
  const entry = (name: string) => flow.interview.find((i) => i.name === name)!;
  const t = Number(entry("treasuryPercent").default);
  const q = Number(entry("quorumPercent").default);

  it("the offered defaults ARE the tool's own synthesis constants", () => {
    expect([t, q]).toEqual([SAFE_DEFAULT_TREASURY_PCT, SAFE_DEFAULT_QUORUM_PCT]);
  });

  it("SIMPLE mode would synthesize the same pair", () => {
    expect(resolveQuorumSplit({})).toMatchObject({ treasuryPercent: t, quorumPercent: q });
  });

  it("the offered treasury default alone is not a hard error", () => {
    // The worse half of the shipped bug: treasuryPercent:49 with no quorum was
    // not "blocked-risky", it was err("Could not synthesize a governable …").
    expect(resolveQuorumSplit({ treasuryPercent: t }).error).toBeUndefined();
  });

  it("the offered pair clears the turnout margin and the floor", () => {
    const v = guardVerdict(t, q);
    expect(v.ok, `dexe_guide create_dao offers treasury=${t}/quorum=${q}; dexe_dao_create refuses it — ${v.why}`).toBe(
      true,
    );
  });

  it("the constraint strings state the turnout rule, not the superseded bound", () => {
    const quorumConstraint = entry("quorumPercent").constraint ?? "";
    expect(quorumConstraint).toContain(String(QUORUM_TURNOUT_CEILING));
    // The refuted shape is the bound WITHOUT the ceiling factor:
    // "quorum ≤ 100 − treasuryPercent". "≤ 0.8 × (100 − treasuryPercent)" is correct.
    for (const s of [quorumConstraint, entry("treasuryPercent").riskIfUnusual ?? ""]) {
      expect(s, "the superseded zero-margin bound is still being taught").not.toMatch(
        /[≤<]=?\s*\(?\s*100\s*[−-]\s*treasuryPercent/,
      );
    }
  });
});

// ── The gotcha every blocking guard must have ───────────────────────────────
describe("the turnout guard has a gotcha", () => {
  it("quorum-turnout-margin exists and pins the real ceiling", () => {
    const g = GOTCHA_BY_ID.get("quorum-turnout-margin");
    expect(g, "no gotcha covers the rule that actually blocks a deploy").toBeDefined();
    expect(g!.severity).toBe("danger");
    expect(
      g!.text,
      "bumping QUORUM_TURNOUT_CEILING must force the gotcha text to be rewritten",
    ).toContain(`${QUORUM_TURNOUT_CEILING * 100}%`);
  });

  it("the create_dao preview step and the token-economy DAO leg both reference it", () => {
    const preview = FLOW_BY_ID.get("create_dao")!.steps.find((s) => s.id === "preview")!;
    expect(preview.gotchaIds).toContain("quorum-turnout-margin");
    const legDao = FLOW_BY_ID.get("launch_token_economy")!.steps.find((s) => s.id === "leg_dao")!;
    expect(legDao.gotchaIds).toContain("quorum-turnout-margin");
  });

  it("quorum-reachable no longer states the superseded zero-margin rule", () => {
    expect(GOTCHA_BY_ID.get("quorum-reachable")!.text).not.toContain(
      "must be ≤ the token amount actually distributed",
    );
  });
});

// ── The prose surfaces ──────────────────────────────────────────────────────
const SKILL_FILES = readdirSync(resolve(root, "dexe-plugin", "skills"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `dexe-plugin/skills/${d.name}/SKILL.md`)
  .filter((rel) => existsSync(resolve(root, rel)));

const PROSE_FILES = [
  "docs/PLAYBOOK.md",
  "docs/USAGE.md",
  "docs/USE_CASES.md",
  "docs/OTC.md",
  ...SKILL_FILES,
];

const CORPUS_FILES = ["src/knowledge/flows.ts", "src/knowledge/gotchas.ts", "src/knowledge/topics.ts"];

interface Hit {
  file: string;
  line: number;
  value: number;
  raw: string;
}

/** `treasuryPercent: 49`, `` `treasuryPercent` … default `49` ``, `"treasuryPercent": 49`. */
function findField(body: string, file: string, field: string): Hit[] {
  const out: Hit[] = [];
  body.split("\n").forEach((line, i) => {
    const re = new RegExp(`${field}["'\`]?\\s*[:=]\\s*["'\`]?(\\d+(?:\\.\\d+)?)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) out.push({ file, line: i + 1, value: Number(m[1]), raw: line.trim() });
    const gen = new RegExp(`\`${field}\`[^\\n]*?default \`(\\d+(?:\\.\\d+)?)\``, "g");
    while ((m = gen.exec(line)) !== null) out.push({ file, line: i + 1, value: Number(m[1]), raw: line.trim() });
  });
  return out;
}

describe("LEG B — every numeric treasury/quorum recommendation passes the deploy guard", () => {
  for (const rel of PROSE_FILES) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8");
    const treasuries = findField(body, rel, "treasuryPercent");
    const quorums = findField(body, rel, "quorumPercent");
    if (treasuries.length === 0) continue;

    it(`${rel}`, () => {
      const failures: string[] = [];
      for (const t of treasuries) {
        // Pair with the nearest quorum recommendation within 6 lines; when
        // there is none, the treasury must stand on its own (the tool then
        // picks the quorum, and a too-large treasury is a HARD error).
        const near = quorums
          .filter((q) => Math.abs(q.line - t.line) <= 6)
          .sort((a, b) => Math.abs(a.line - t.line) - Math.abs(b.line - t.line))[0];
        if (near) {
          const v = guardVerdict(t.value, near.value);
          if (!v.ok) {
            failures.push(
              `${rel}:${t.line} recommends treasury ${t.value}% / quorum ${near.value}% (line ${near.line}) — ` +
                `dexe_dao_create refuses it: ${v.why} Use quorum ≤ ${v.maxQuorumPct}% or votable ≥ ${v.minVotablePct}%.`,
            );
          }
        } else {
          const err = resolveQuorumSplit({ treasuryPercent: t.value }).error;
          if (err) failures.push(`${rel}:${t.line} recommends treasury ${t.value}% — dexe_dao_create errors: ${err}`);
        }
      }
      expect(failures, `guidance the deploy guard refuses:\n  ${failures.join("\n  ")}`).toEqual([]);
    });
  }
});

describe("LEG B2 — prose percentages ('30% held by the treasury') pass the guard too", () => {
  const PROSE_PATTERNS: Array<{ re: RegExp; treasuryFrom: (n: number) => number }> = [
    { re: /(\d{1,3})%\s+(?:held by|to) the (?:DAO )?treasury/gi, treasuryFrom: (n) => n },
    { re: /(\d{1,3})%\s+to (?:my|the|your) wallet/gi, treasuryFrom: (n) => 100 - n },
  ];

  for (const rel of ["docs/USE_CASES.md", "docs/USAGE.md", ...SKILL_FILES]) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    it(`${rel}`, () => {
      const failures: string[] = [];
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const { re, treasuryFrom } of PROSE_PATTERNS) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(line)) !== null) {
              const treasury = treasuryFrom(Number(m[1]));
              if (treasury < 0 || treasury > 100) continue;
              const err = resolveQuorumSplit({ treasuryPercent: treasury }).error;
              if (err) failures.push(`${rel}:${i + 1} describes a ${treasury}% treasury — dexe_dao_create errors: ${err}`);
            }
          }
        });
      expect(failures, `prose the deploy guard refuses:\n  ${failures.join("\n  ")}`).toEqual([]);
    });
  }
});

describe("LEG C — no surface states a rule 0.33.0 superseded", () => {
  /** Rule-shapes that were true before the turnout margin and are false now. */
  const REFUTED: Array<{ re: RegExp; say: string }> = [
    { re: /reachable\s*[≤<]=?\s*votable/i, say: "state the turnout rule: quorum ≤ 0.8 × (100 − treasury)" },
    { re: /quorum%?\s*[≤<]=?\s*\(?\s*100\s*[−-]\s*treasury/i, say: "the bound is 0.8 × (100 − treasury%)" },
    { re: /100\s*[−-]\s*treasuryPercent\s+(?:must|the quorum|is)/i, say: "the bound is 0.8 × (100 − treasuryPercent)" },
    { re: /quorum%?\s*×\s*totalSupply\s+must be\s*[≤<]/i, say: "reachability alone is no longer the rule" },
    { re: /Treasury\s*>\s*49%/i, say: "the treasury cap is 37.5% of supply, not 49%" },
    { re: /treasury%?\s*[≤<]=?\s*50%/i, say: "the treasury cap is 37.5% of supply" },
  ];

  for (const rel of [...CORPUS_FILES, ...PROSE_FILES]) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    it(`${rel}`, () => {
      const failures: string[] = [];
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const { re, say } of REFUTED) {
            if (re.test(line)) failures.push(`${rel}:${i + 1} — ${say}\n      ${line.trim()}`);
          }
        });
      expect(failures, `superseded rule statements:\n  ${failures.join("\n  ")}`).toEqual([]);
    });
  }
});

describe("the documented caveats are real", () => {
  it("POLYNOMIAL supports no ≥50% quorum at any split — the corpus says so, the tool must agree", () => {
    // Synthesis (both fields omitted) is where the model choice actually bites.
    const err = resolveQuorumSplit({ voteModel: "POLYNOMIAL" }).error ?? "";
    expect(err, "the corpus claims POLYNOMIAL cannot hold a ≥50% quorum — pin it").toMatch(/LINEAR/);
    // An EXPLICIT pair is never rewritten (daoCreate.ts returns it verbatim), so
    // the refusal for 30/51 under POLYNOMIAL lands on the safety proof instead.
    const v = guardVerdict2(SAFE_DEFAULT_TREASURY_PCT, SAFE_DEFAULT_QUORUM_PCT, "POLYNOMIAL");
    expect(v.marginOk).toBe(false);
  });

  it("an 80% treasury is still a hard error naming the cap", () => {
    const err = resolveQuorumSplit({ treasuryPercent: 80 }).error ?? "";
    expect(err).toContain("≤37.5");
  });
});
