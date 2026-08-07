import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { checkAddSettingsTrap, ADD_SETTINGS_SELECTOR } from "../../src/lib/protocolAdvisories.js";

/**
 * The `custom` proposal type takes caller-supplied `actionsOnFor` verbatim and
 * never touches PROPOSAL_BUILDERS, so it bypassed the registry-level #36 guard
 * the same release had just wired.
 *
 * This is the THIRD time a raw-calldata path in this codebase walked around a
 * check every other path passes through:
 *
 *   0.32.0  the GovUserKeeper denylist — refused at dexe_tx_send, waved through
 *           by dexe_proposal_create{proposalType:"custom"}
 *   0.33.0  checkAddSettingsTrap — wired onto the builder registry, which
 *           `custom` does not use
 *
 * Both were fixed the same way and for the same reason: move the check to the
 * point where every branch has already converged (the assembled actions, just
 * before the metadata pin), so the branch that produced them cannot matter —
 * including a branch someone adds next year.
 */

const IFACE = new Interface([
  "function addSettings(tuple(bool earlyCompletion, bool delegatedVotingAllowed, bool validatorsVote, uint64 duration, uint64 durationValidators, uint64 executionDelay, uint128 quorum, uint128 quorumValidators, uint256 minVotesForVoting, uint256 minVotesForCreating, tuple(address rewardToken, uint256 creationReward, uint256 executionReward, uint256 voteRewardsCoefficient) rewardsInfo, string executorDescription)[] _settings)",
]);

const GOV_SETTINGS = "0x" + "aa".repeat(20);

/** Hand-rolled calldata of exactly the shape a `custom` proposal would carry. */
function addSettingsAction() {
  const data = IFACE.encodeFunctionData("addSettings", [
    [
      {
        earlyCompletion: true,
        delegatedVotingAllowed: false,
        validatorsVote: false,
        duration: 432000n,
        durationValidators: 432000n,
        executionDelay: 0n,
        quorum: 10n ** 25n,
        quorumValidators: 10n ** 25n,
        minVotesForVoting: 0n,
        minVotesForCreating: 0n,
        rewardsInfo: {
          rewardToken: "0x" + "00".repeat(20),
          creationReward: 0n,
          executionReward: 0n,
          voteRewardsCoefficient: 0n,
        },
        executorDescription: "custom",
      },
    ],
  ]);
  return { executor: GOV_SETTINGS, value: 0n, data };
}

describe("the #36 trap is caught on assembled actions, whatever branch built them", () => {
  it("the fixture really carries the guarded selector", () => {
    expect(addSettingsAction().data.slice(0, 10)).toBe(ADD_SETTINGS_SELECTOR);
  });

  it("is blocked on chain 97 — the chain where it passes the vote and bricks at execute", () => {
    const trap = checkAddSettingsTrap({ chainId: 97, actions: [addSettingsAction()] });
    expect(trap.blocked).toBe(true);
    expect(trap.advisory?.severity).toBe("DANGER");
    // The advisory must say what to do INSTEAD, not merely that something is wrong.
    expect(trap.advisory?.text ?? "").toMatch(/settingsIds|editSettings|56/);
  });

  it("is NOT blocked on chain 56", () => {
    expect(checkAddSettingsTrap({ chainId: 56, actions: [addSettingsAction()] }).blocked).toBe(false);
  });

  it("is selector-keyed, so a hand-rolled action is caught like a catalog one", () => {
    // Same bytes, arriving as an opaque caller-supplied action rather than from
    // a builder — this is precisely the `custom` shape.
    const opaque = { executor: GOV_SETTINGS, value: 0n, data: addSettingsAction().data };
    expect(checkAddSettingsTrap({ chainId: 97, actions: [opaque] }).blocked).toBe(true);
  });

  it("names which action carries it, so a multi-action proposal is actionable", () => {
    const benign = { executor: "0x" + "bb".repeat(20), value: 0n, data: "0xa9059cbb" };
    const trap = checkAddSettingsTrap({
      chainId: 97,
      actions: [benign, benign, addSettingsAction()],
    });
    expect(trap.blocked).toBe(true);
    expect(trap.actionIndices).toContain(2);
  });

  it("leaves an ordinary action alone", () => {
    const benign = { executor: "0x" + "bb".repeat(20), value: 0n, data: "0xa9059cbb" };
    expect(checkAddSettingsTrap({ chainId: 97, actions: [benign] }).blocked).toBe(false);
  });
});

/**
 * Structural: the guard must be applied where the branches converge, not inside
 * one of them. If this assertion has to change, check first that the new call
 * site still covers `custom` — that is the branch that has now bypassed two
 * separate guards.
 */
describe("the trap check sits on the converged path in flow.ts", () => {
  it("runs on the assembled actionsOnFor, not inside a single branch", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "..", "..", "src", "tools", "flow.ts"), "utf8");

    const callIdx = src.indexOf("checkAddSettingsTrap({ chainId, actions: actionsOnFor })");
    expect(callIdx, "flow.ts must check the assembled actions").toBeGreaterThan(0);

    // It has to come AFTER the branch that handles `custom`, or that branch is
    // still uncovered.
    const customIdx = src.indexOf('input.proposalType === "custom"');
    expect(customIdx).toBeGreaterThan(0);
    expect(callIdx).toBeGreaterThan(customIdx);
  });
});
