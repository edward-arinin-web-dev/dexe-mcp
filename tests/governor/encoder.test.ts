import { describe, expect, it } from "vitest";
import { Interface, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import { resolveGovernor } from "../../src/governor/loader.js";
import {
  buildDelegate,
  buildExecute,
  buildPropose,
  buildQueue,
  buildVoteCast,
  decodeGovernorWrite,
  GOVERNOR_BRAVO_WRITE_ABI,
  GOVERNOR_OZ_WRITE_ABI,
} from "../../src/governor/encoder.js";
import type { GovernorConfig } from "../../src/governor/loader.js";

const OZ_PROPOSE_SELECTOR = "0x7d5e81e2"; // propose(address[],uint256[],bytes[],string) — plan §4.1
const CAST_VOTE_SELECTOR = "0x56781388"; // castVote(uint256,uint8) — same on OZ + Bravo
const DELEGATE_SELECTOR = "0x5c19a95c"; // delegate(address)

const uniswap = resolveGovernor("uniswap");

const ozFixture: GovernorConfig = {
  ...uniswap,
  id: "fixture-oz",
  governorVersion: "oz-v4",
};

const targets = ["0x000000000000000000000000000000000000bEEF"];
const values = ["0"];
const calldatas = ["0xdeadbeef"];
const description = "Test proposal";

describe("encoder — selectors (plan §4.1)", () => {
  it("OZ propose selector is 0x7d5e81e2", () => {
    const out = buildPropose(ozFixture, { targets, values, calldatas, description });
    expect(out.selector).toBe(OZ_PROPOSE_SELECTOR);
    expect(out.family).toBe("oz");
  });

  it("Bravo propose selector differs from OZ (5-arg signature)", () => {
    const out = buildPropose(uniswap, { targets, values, calldatas, description, signatures: [""] });
    expect(out.family).toBe("bravo");
    expect(out.selector).not.toBe(OZ_PROPOSE_SELECTOR);
    // Verify the Bravo selector matches the canonical Bravo propose signature.
    const expected = new Interface(GOVERNOR_BRAVO_WRITE_ABI as unknown as string[])
      .getFunction("propose")!
      .selector;
    expect(out.selector).toBe(expected);
  });

  it("castVote selector is 0x56781388 on both families", () => {
    const a = buildVoteCast(uniswap, "1", 1);
    const b = buildVoteCast(ozFixture, "1", 1);
    expect(a.selector).toBe(CAST_VOTE_SELECTOR);
    expect(b.selector).toBe(CAST_VOTE_SELECTOR);
  });

  it("castVoteWithReason routes correctly when reason is set", () => {
    const out = buildVoteCast(uniswap, "1", 2, "abstain — automated test");
    expect(out.method).toBe("castVoteWithReason");
    const expected = new Interface(GOVERNOR_BRAVO_WRITE_ABI as unknown as string[])
      .getFunction("castVoteWithReason")!
      .selector;
    expect(out.selector).toBe(expected);
  });

  it("delegate selector is 0x5c19a95c", () => {
    const out = buildDelegate(uniswap, "0x0000000000000000000000000000000000000001");
    expect(out.selector).toBe(DELEGATE_SELECTOR);
    expect(out.to).toBe(uniswap.votingToken.address);
  });
});

describe("encoder — calldata round-trip (AC #5)", () => {
  it("OZ propose decodes back to identical (targets, values, calldatas, description)", () => {
    const built = buildPropose(ozFixture, { targets, values, calldatas, description });
    const decoded = decodeGovernorWrite(ozFixture, built.data);
    expect(decoded.method).toBe("propose");
    const [dTargets, dValues, dCalldatas, dDesc] = decoded.args as any[];
    expect(dTargets.map((a: string) => a.toLowerCase())).toEqual(targets.map(t => t.toLowerCase()));
    expect(dValues.map((v: bigint) => v.toString())).toEqual(values);
    expect(dCalldatas).toEqual(calldatas);
    expect(dDesc).toBe(description);
  });

  it("Bravo propose decodes back to identical 5-tuple (with signatures[])", () => {
    const built = buildPropose(uniswap, {
      targets,
      values,
      calldatas,
      description,
      signatures: ["transfer(address,uint256)"],
    });
    const decoded = decodeGovernorWrite(uniswap, built.data);
    expect(decoded.method).toBe("propose");
    const [dTargets, dValues, dSignatures, dCalldatas, dDesc] = decoded.args as any[];
    expect(dTargets.map((a: string) => a.toLowerCase())).toEqual(targets.map(t => t.toLowerCase()));
    expect(dValues.map((v: bigint) => v.toString())).toEqual(values);
    expect(dSignatures).toEqual(["transfer(address,uint256)"]);
    expect(dCalldatas).toEqual(calldatas);
    expect(dDesc).toBe(description);
  });
});

describe("encoder — queue / execute family branching", () => {
  it("Bravo queue takes proposalId only", () => {
    const out = buildQueue(uniswap, { proposalId: "42" });
    expect(out.family).toBe("bravo");
    expect(out.method).toBe("queue");
    const decoded = decodeGovernorWrite(uniswap, out.data);
    expect((decoded.args[0] as bigint).toString()).toBe("42");
  });

  it("Bravo execute takes proposalId + optional msgValue", () => {
    const out = buildExecute(uniswap, { proposalId: "42" }, "1000");
    expect(out.value).toBe("1000");
    expect(out.family).toBe("bravo");
  });

  it("OZ queue computes descriptionHash from description when only description is given", () => {
    const out = buildQueue(ozFixture, { targets, values, calldatas, description });
    expect(out.family).toBe("oz");
    const decoded = decodeGovernorWrite(ozFixture, out.data);
    const expectedHash = keccak256(toUtf8Bytes(description));
    expect((decoded.args[3] as string).toLowerCase()).toBe(expectedHash.toLowerCase());
  });

  it("OZ queue accepts pre-computed descriptionHash without rehashing", () => {
    const dh = keccak256(toUtf8Bytes("other description"));
    const out = buildQueue(ozFixture, { targets, values, calldatas, descriptionHash: dh });
    const decoded = decodeGovernorWrite(ozFixture, out.data);
    expect((decoded.args[3] as string).toLowerCase()).toBe(dh.toLowerCase());
  });

  it("Bravo execute selector differs from OZ execute selector", () => {
    const bravoExec = buildExecute(uniswap, { proposalId: "1" });
    const ozExec = buildExecute(ozFixture, { targets, values, calldatas, description });
    expect(bravoExec.selector).not.toBe(ozExec.selector);
    const expectedBravo = new Interface(GOVERNOR_BRAVO_WRITE_ABI as unknown as string[])
      .getFunction("execute")!
      .selector;
    const expectedOz = new Interface(GOVERNOR_OZ_WRITE_ABI as unknown as string[])
      .getFunction("execute")!
      .selector;
    expect(bravoExec.selector).toBe(expectedBravo);
    expect(ozExec.selector).toBe(expectedOz);
  });
});

describe("encoder — validation errors", () => {
  it("rejects target/value/calldata length mismatch", () => {
    expect(() =>
      buildPropose(uniswap, {
        targets: ["0x000000000000000000000000000000000000bEEF"],
        values: ["0", "0"],
        calldatas: ["0x"],
        description: "x",
        signatures: [""],
      }),
    ).toThrow(/length mismatch/);
  });

  it("rejects invalid delegatee", () => {
    expect(() => buildDelegate(uniswap, "0xnope")).toThrow(/invalid delegatee/);
  });

  it("rejects support outside 0..2", () => {
    expect(() => buildVoteCast(uniswap, "1", 5 as any)).toThrow(/support/);
  });

  it("OZ queue without description or hash errors", () => {
    expect(() => buildQueue(ozFixture, { targets, values, calldatas })).toThrow(/description/);
  });

  it("Bravo queue without proposalId errors", () => {
    expect(() => buildQueue(uniswap, {})).toThrow(/proposalId/);
  });

  it("delegate to zero address is permitted (self-revoke)", () => {
    expect(() => buildDelegate(uniswap, ZeroAddress)).not.toThrow();
  });
});

describe("encoder action-array guards (propose + OZ queue/execute/cancel)", () => {
  it("rejects an empty propose action set", () => {
    expect(() =>
      buildPropose(ozFixture, { targets: [], values: [], calldatas: [], description: "x" }),
    ).toThrow(/at least one action/);
  });

  it("rejects a propose above MAX_ACTIONS", () => {
    const n = 51;
    expect(() =>
      buildPropose(ozFixture, {
        targets: Array(n).fill(targets[0]),
        values: Array(n).fill("0"),
        calldatas: Array(n).fill("0x"),
        description: "x",
      }),
    ).toThrow(/too many actions/);
  });

  it("OZ queue enforces target/value/calldata length parity", () => {
    expect(() =>
      buildQueue(ozFixture, { targets, values: ["0", "0"], calldatas, description: "x" }),
    ).toThrow(/length mismatch/);
  });

  it("OZ execute rejects an empty action set", () => {
    expect(() =>
      buildExecute(ozFixture, { targets: [], values: [], calldatas: [], description: "x" }),
    ).toThrow(/at least one action/);
  });
});
