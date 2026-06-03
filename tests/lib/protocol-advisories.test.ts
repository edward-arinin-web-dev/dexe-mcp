import { describe, expect, it } from "vitest";
import {
  CHANGE_VOTE_POWER_ADVISORY,
  CUSTOM_ABI_DEFAULT_ROUTING_ADVISORY,
  DURATION_VALIDATORS_SANITY_CAP,
  settingsAdvisories,
} from "../../src/lib/protocolAdvisories.js";

/**
 * Governance-safety advisories for risky proposal / DAO settings — these pin
 * the warning logic.
 */

const base = {
  validatorsVote: false,
  durationValidators: "3600",
  executionDelay: "86400",
  quorumValidators: "0",
};

describe("settingsAdvisories", () => {
  it("flags executionDelay=0 (no timelock)", () => {
    expect(settingsAdvisories({ ...base, executionDelay: "0" }).join("\n")).toMatch(/executionDelay=0/);
  });

  it("does not flag a healthy config", () => {
    expect(settingsAdvisories(base)).toEqual([]);
  });

  it("flags quorumValidators=0 only when validatorsVote is true", () => {
    expect(settingsAdvisories({ ...base, quorumValidators: "0" })).toEqual([]);
    expect(
      settingsAdvisories({ ...base, validatorsVote: true, quorumValidators: "0" }).join("\n"),
    ).toMatch(/quorumValidators=0/);
  });

  it("flags an unbounded validator phase", () => {
    const huge = (DURATION_VALIDATORS_SANITY_CAP + 1n).toString();
    const adv = settingsAdvisories({
      ...base,
      validatorsVote: true,
      quorumValidators: "10",
      durationValidators: huge,
    }).join("\n");
    expect(adv).toMatch(/durationValidators/);
    expect(adv).toMatch(/locked/);
  });

  it("does not flag a normal validator phase", () => {
    expect(
      settingsAdvisories({
        ...base,
        validatorsVote: true,
        quorumValidators: "10",
        durationValidators: "86400",
      }),
    ).toEqual([]);
  });

  it("exposes the changeVotePower and custom_abi advisories", () => {
    expect(CHANGE_VOTE_POWER_ADVISORY).toMatch(/changeVotePower/);
    expect(CUSTOM_ABI_DEFAULT_ROUTING_ADVISORY).toMatch(/registered executor/);
  });
});
