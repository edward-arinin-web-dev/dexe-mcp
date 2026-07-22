import { describe, it, expect } from "vitest";
import { nextAfter } from "../../src/knowledge/nextSteps.js";
import { FLOWS } from "../../src/knowledge/index.js";

describe("nextAfter (structured chaining)", () => {
  it("unknown flow or step → null (never throws)", () => {
    expect(nextAfter("nope", "x")).toBeNull();
    expect(nextAfter("create_dao", "nope")).toBeNull();
  });

  it("preview → deploy (explicit next)", () => {
    const ns = nextAfter("create_dao", "preview")!;
    expect(ns.done).toBe(false);
    expect(ns.next[0]!.tool).toBe("dexe_dao_create");
    expect(ns.flowProgress).toMatchObject({ flow: "create_dao", stepIndex: 1, of: 2 });
  });

  it("cross-flow pointer resolves to dexe_guide (create_dao.deploy → create_proposal)", () => {
    const ns = nextAfter("create_dao", "deploy")!;
    expect(ns.done).toBe(false);
    expect(ns.next[0]!.tool).toBe("dexe_guide");
    expect(ns.next[0]!.why).toContain('flow:"create_proposal"');
  });

  it("implicit next: falls through to the following step (vote_execute.vote_execute → unlock)", () => {
    const ns = nextAfter("vote_execute", "vote_execute")!;
    expect(ns.next[0]!.tool).toBe("dexe_vote_build_withdraw");
  });

  it("a final step with no next is done", () => {
    const ns = nextAfter("vote_execute", "unlock")!;
    expect(ns.done).toBe(true);
    expect(ns.next).toEqual([]);
  });

  it("launch_token_economy legs chain in order", () => {
    const legs = ["leg_dao", "leg_distribute", "leg_otc", "leg_staking"];
    for (let i = 0; i < legs.length - 1; i++) {
      const ns = nextAfter("launch_token_economy", legs[i]!)!;
      expect(ns.done, `${legs[i]} should not be final`).toBe(false);
      expect(ns.next.length).toBeGreaterThan(0);
    }
    expect(nextAfter("launch_token_economy", "leg_staking")!.done).toBe(true);
  });

  it("every step of every flow resolves without throwing", () => {
    for (const f of FLOWS) {
      for (const s of f.steps) {
        expect(nextAfter(f.id, s.id), `${f.id}.${s.id}`).not.toBeNull();
      }
    }
  });
});
