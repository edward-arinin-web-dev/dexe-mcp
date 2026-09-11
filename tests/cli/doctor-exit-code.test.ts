import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorExitCode, parseDoctorArgs } from "../../src/cli/doctor.js";

/**
 * D8-2 / D10-1 — a healthy zero-config install could never exit 0. The three
 * warnings it always produces (`env.file`, `chain.publicRpcFallback`,
 * `env.sharedDefaults`) are the DOCUMENTED default state, and none of them can
 * be cleared without configuring what the product says you don't need — so
 * `warn > 0 → exit 1` made docs/SETUP.md's "confirm everything reaches green"
 * literally unachievable.
 */

describe("doctorExitCode", () => {
  const cases: Array<{ warn: number; fail: number; strict: boolean; want: 0 | 1 | 2; why: string }> = [
    { warn: 0, fail: 0, strict: false, want: 0, why: "everything green" },
    { warn: 0, fail: 0, strict: true, want: 0, why: "strict changes nothing without warnings" },
    { warn: 3, fail: 0, strict: false, want: 0, why: "the zero-config case this finding is about" },
    { warn: 3, fail: 0, strict: true, want: 1, why: "--strict promotes warnings, for CI" },
    { warn: 0, fail: 1, strict: false, want: 2, why: "a real failure" },
    { warn: 5, fail: 2, strict: true, want: 2, why: "failures dominate strict" },
    { warn: 5, fail: 2, strict: false, want: 2, why: "failures dominate warnings" },
  ];

  it.each(cases)("$warn warn / $fail fail, strict=$strict → $want ($why)", ({ warn, fail, strict, want }) => {
    expect(doctorExitCode({ warn, fail }, strict)).toBe(want);
  });
});

describe("parseDoctorArgs", () => {
  const original = process.env.DEXE_DOCTOR_STRICT;
  beforeEach(() => {
    delete process.env.DEXE_DOCTOR_STRICT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DEXE_DOCTOR_STRICT;
    else process.env.DEXE_DOCTOR_STRICT = original;
  });

  it("defaults to non-strict, no pin probe", () => {
    expect(parseDoctorArgs([])).toEqual({ strict: false, probePin: false, unknown: [] });
  });

  it("--strict opts into the CI ladder", () => {
    expect(parseDoctorArgs(["--strict"])).toMatchObject({ strict: true, probePin: false });
  });

  // For a CI wrapper that can set an env var but not add a flag.
  it("DEXE_DOCTOR_STRICT=1 is equivalent to --strict", () => {
    process.env.DEXE_DOCTOR_STRICT = "1";
    expect(parseDoctorArgs([])).toMatchObject({ strict: true });
  });

  it("--probe-pin opts into the writing probe", () => {
    expect(parseDoctorArgs(["--probe-pin"])).toMatchObject({ strict: false, probePin: true });
  });

  it("accepts both together", () => {
    expect(parseDoctorArgs(["--strict", "--probe-pin"])).toMatchObject({ strict: true, probePin: true });
  });

  // A typo'd flag used to be ignored in silence, which is how a CI pipeline
  // ends up green forever.
  it.each(["--Strict", "--strict=true", "--probe_pin", "-s"])("reports the unknown flag %s", (flag) => {
    expect(parseDoctorArgs([flag]).unknown).toEqual([flag]);
  });

  it("does not treat a bare word as a flag", () => {
    expect(parseDoctorArgs(["something"]).unknown).toEqual([]);
  });
});
