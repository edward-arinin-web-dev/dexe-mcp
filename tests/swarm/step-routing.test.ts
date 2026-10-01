import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { routeStep, slotForEnvKey } from "../../scripts/swarm/stepRouting.js";

const INLINE = [
  "dexe_vote_user_power",
  "dexe_read_delegation_map",
  "dexe_vote_build_undelegate",
  "dexe_vote_build_withdraw",
  "dexe_vote_build_withdraw_all",
  "dexe_vote_build_erc20_approve",
  "dexe_vote_build_deposit",
  "dexe_vote_build_delegate",
  "dexe_vote_build_vote",
  "dexe_proposal_build_modify_dao_profile",
];

describe("slotForEnvKey", () => {
  const table: Array<[string, string | null]> = [
    ["AGENT_PK_3", "agent3"],
    ["DEXE_AGENT_PK_3", "agent3"],
    ["AGENT_PK_16", "agent16"],
    ["AGENT_FUNDER_PK", "funder"],
    ["DEXE_AGENT_FUNDER_PK", "funder"],
    ["SOME_PK", null],
    ["DEXE_PRIVATE_KEY", null],
    ["AGENT_PK_", null],
  ];
  for (const [envKey, slot] of table) {
    it(`${envKey} → ${slot ?? "null"}`, () => {
      expect(slotForEnvKey(envKey)).toBe(slot);
    });
  }
});

describe("routeStep", () => {
  it("keeps today's behaviour when serverSign is absent", () => {
    expect(routeStep({ step: 1, tool: "dexe_tx_send", broadcast: true }, "AGENT_PK_1")).toEqual({
      mode: "local",
    });
  });

  it("derives the keyring slot from the step's own agent wallet", () => {
    expect(
      routeStep({ step: 2, tool: "dexe_tx_send", serverSign: true }, "AGENT_PK_3", {
        inlineDispatchers: INLINE,
      }),
    ).toEqual({ mode: "server", signerKey: "agent3" });
  });

  it("refuses serverSign together with broadcast, naming the remedy", () => {
    expect(() =>
      routeStep({ step: 2, tool: "dexe_tx_send", serverSign: true, broadcast: true }, "AGENT_PK_1", {
        scenarioId: "S66-tx-send-guards",
      }),
    ).toThrow(/serverSign and broadcast cannot both be set/);
  });

  it("refuses serverSign on a tool the orchestrator dispatches inline", () => {
    expect(() =>
      routeStep({ step: 3, tool: "dexe_vote_build_vote", serverSign: true }, "AGENT_PK_1", {
        inlineDispatchers: INLINE,
      }),
    ).toThrow(/silently dropped/);
  });

  it("refuses serverSign when the agent's wallet maps to no keyring slot", () => {
    expect(() => routeStep({ step: 4, tool: "dexe_tx_send", serverSign: true }, "SOME_PK")).toThrow(
      /maps to no keyring slot/,
    );
  });
});

describe("scenario corpus", () => {
  const dir = resolve("tests/swarm/scenarios");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));

  it("no step sets both serverSign and broadcast, and no serverSign step is inline-dispatched", () => {
    for (const f of files) {
      const spec = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        id: string;
        steps?: Array<{ step?: number; tool?: string; broadcast?: boolean; serverSign?: boolean }>;
      };
      for (const step of spec.steps ?? []) {
        if (!step.serverSign) continue;
        expect(
          () => routeStep(step, "AGENT_PK_1", { inlineDispatchers: INLINE, scenarioId: spec.id }),
          `${f} step ${step.step}`,
        ).not.toThrow();
      }
    }
  });
});

describe("an explicit args.signerKey wins over the derived slot (0.34.1)", () => {
  it("keeps the scenario's signerKey — an unknown slot must reach the server to be refused there", () => {
    expect(
      routeStep({ step: 4, tool: "dexe_tx_send", serverSign: true, args: { signerKey: "agent99" } }, "AGENT_PK_1", {
        inlineDispatchers: [],
      }),
    ).toEqual({ mode: "server", signerKey: "agent99" });
  });

  it("derives the slot from the wallet when args carry none", () => {
    expect(routeStep({ step: 2, tool: "dexe_tx_send", serverSign: true, args: {} }, "AGENT_PK_1", { inlineDispatchers: [] })).toEqual({
      mode: "server",
      signerKey: "agent1",
    });
  });
});
