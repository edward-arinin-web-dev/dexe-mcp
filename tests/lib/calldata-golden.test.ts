/**
 * Golden-file calldata regression suite (ROADMAP: "Golden-file hex calldata
 * fixtures per proposal type").
 *
 * For every builder in PROPOSAL_BUILDERS / INTERNAL_PROPOSAL_BUILDERS we pin the
 * EXACT hex calldata it emits for a fixed, deterministic set of params (see
 * tests/fixtures/calldata-golden.json). Any future ABI drift, field-order
 * change, or encoding regression flips the emitted bytes and fails here loudly.
 *
 * Fixtures are machine-generated — never hand-edit the actions/data/internalType
 * fields. To regenerate after an INTENTIONAL builder change:
 *
 *     UPDATE_GOLDEN=1 npx vitest run tests/lib/calldata-golden.test.ts
 *
 * That rebuilds every fixture from its params and writes the JSON back; review
 * the diff before committing. Without the env var the suite asserts byte-parity.
 *
 * Determinism rules baked into the fixtures:
 *  - fixed addresses (0x1111… style, mirroring proposalBuilders.test.ts)
 *  - digits-only raw-wei amounts (no on-chain decimals() read → no RPC)
 *  - RPC-less deps (rpcUrl: undefined) so blacklist / ownership / quorum
 *    prechecks degrade to no-ops and builders run fully offline
 *  - far-future fixed timestamps so create_staking_tier's future-deadline guard
 *    keeps passing regardless of when the suite runs
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PROPOSAL_BUILDERS,
  INTERNAL_PROPOSAL_BUILDERS,
} from "../../src/lib/proposalBuilders.js";

const GOVPOOL = "0x3333333333333333333333333333333333333333";
// No RPC → prechecks (blacklist / multiplier ownership / validator quorum /
// treasury balance) degrade to no-ops → builders run without network.
const deps = { ctx: { config: { rpcUrl: undefined } } as never, govPool: GOVPOOL, chainId: 97 };

const UPDATE = process.env.UPDATE_GOLDEN === "1";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/calldata-golden.json", import.meta.url));

type ExternalFixture = { params: Record<string, unknown>; actions?: unknown };
type InternalFixture = { params: Record<string, unknown>; internalType?: number; data?: string };
interface GoldenFile {
  _comment?: string;
  external: Record<string, ExternalFixture>;
  internal: Record<string, InternalFixture>;
}

const golden = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenFile;

/**
 * Builders that genuinely cannot produce deterministic offline output belong
 * here (key → reason). Verified empty: every wired builder encodes offline with
 * digits-only amounts and explicit contract addresses. Kept as an intentional
 * escape hatch so a future RPC-only type can be documented rather than silently
 * dropped from the completeness assertion.
 */
const EXTERNAL_EXCLUSIONS: Record<string, string> = {};
const INTERNAL_EXCLUSIONS: Record<string, string> = {};

describe("golden calldata fixtures — external builders", () => {
  for (const key of Object.keys(PROPOSAL_BUILDERS)) {
    if (key in EXTERNAL_EXCLUSIONS) continue;
    it(`${key} emits pinned actions`, async () => {
      const fx = golden.external[key];
      expect(fx, `no fixture for external builder '${key}' — add one to calldata-golden.json`).toBeDefined();
      const builder = PROPOSAL_BUILDERS[key]!;
      const out = await builder.build(builder.schema.parse(fx.params), deps);
      if (UPDATE) {
        fx.actions = out.actionsOnFor;
        return;
      }
      expect(out.actionsOnFor).toEqual(fx.actions);
    });
  }
});

describe("golden calldata fixtures — internal builders", () => {
  for (const key of Object.keys(INTERNAL_PROPOSAL_BUILDERS)) {
    if (key in INTERNAL_EXCLUSIONS) continue;
    it(`${key} emits pinned internalType + data`, () => {
      const fx = golden.internal[key];
      expect(fx, `no fixture for internal builder '${key}' — add one to calldata-golden.json`).toBeDefined();
      const builder = INTERNAL_PROPOSAL_BUILDERS[key]!;
      const out = builder.build(builder.schema.parse(fx.params));
      if (UPDATE) {
        fx.internalType = out.internalType;
        fx.data = out.data;
        return;
      }
      expect({ internalType: out.internalType, data: out.data }).toEqual({
        internalType: fx.internalType,
        data: fx.data,
      });
    });
  }
});

describe("golden fixture completeness (new builders must add a fixture)", () => {
  it("every external builder key has a fixture (or a documented exclusion)", () => {
    const missing = Object.keys(PROPOSAL_BUILDERS).filter(
      (k) => !(k in EXTERNAL_EXCLUSIONS) && golden.external[k] === undefined,
    );
    expect(missing, `external builders without a golden fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("every internal builder key has a fixture (or a documented exclusion)", () => {
    const missing = Object.keys(INTERNAL_PROPOSAL_BUILDERS).filter(
      (k) => !(k in INTERNAL_EXCLUSIONS) && golden.internal[k] === undefined,
    );
    expect(missing, `internal builders without a golden fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("no stale fixtures (every fixture maps to a live builder)", () => {
    const staleExternal = Object.keys(golden.external).filter((k) => !(k in PROPOSAL_BUILDERS));
    const staleInternal = Object.keys(golden.internal).filter((k) => !(k in INTERNAL_PROPOSAL_BUILDERS));
    expect(staleExternal, `external fixtures with no builder: ${staleExternal.join(", ")}`).toEqual([]);
    expect(staleInternal, `internal fixtures with no builder: ${staleInternal.join(", ")}`).toEqual([]);
  });
});

afterAll(() => {
  if (!UPDATE) return;
  writeFileSync(FIXTURE_PATH, JSON.stringify(golden, null, 2) + "\n");
});
