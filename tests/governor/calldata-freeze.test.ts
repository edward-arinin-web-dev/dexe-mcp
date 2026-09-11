import { describe, expect, it } from "vitest";
import { resolveGovernor } from "../../src/governor/loader.js";
import {
  GOVERNOR_OZ_WRITE_ABI,
  buildCancel,
  buildDelegate,
  buildExecute,
  buildPropose,
  buildQueue,
  buildVoteCast,
} from "../../src/governor/encoder.js";

/**
 * Calldata freeze for the two fixtures 0.34.0 did NOT repoint.
 *
 * D5-1 flips `compound` from `bravo-v3` to `oz-v5`, which legitimately changes
 * every byte it emits. Nothing else may move: a Governor builder's output is
 * signed and broadcast by a human, so an accidental selector or encoding change
 * is a funds-grade defect, not a test nit.
 *
 * These strings were captured from the builders themselves; if one of them
 * fails, the encoder changed — do not "update the expectation" without knowing
 * why.
 */

const uniswap = resolveGovernor("uniswap"); // bravo-v3
const optimism = resolveGovernor("optimism"); // oz-v4
const compound = resolveGovernor("compound"); // oz-v5 after D5-1

const T = ["0x1111111111111111111111111111111111111111"];
const V = ["0"];
const C = ["0xdeadbeef"];
const DESCRIPTION = "freeze";
const OZ_ARGS = { targets: T, values: V, calldatas: C, description: DESCRIPTION };
const DELEGATEE = "0x2222222222222222222222222222222222222222";

/** Word-aligned literals below are kept readable; whitespace is not data. */
const strip = (s: string) => s.replace(/\s+/g, "");

const VOTE_FOR_42 =
  "0x56781388000000000000000000000000000000000000000000000000000000000000002a" +
  "0000000000000000000000000000000000000000000000000000000000000001";
const DELEGATE_DATA =
  "0x5c19a95c0000000000000000000000002222222222222222222222222222222222222222";
const OZ_PROPOSE_BODY = strip(`
         0000000000000000000000000000000000000000000000000000000000000080
         00000000000000000000000000000000000000000000000000000000000000c0
         0000000000000000000000000000000000000000000000000000000000000100
         0000000000000000000000000000000000000000000000000000000000000180
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000001111111111111111111111111111111111111111
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000000
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000020
         0000000000000000000000000000000000000000000000000000000000000004
         deadbeef00000000000000000000000000000000000000000000000000000000
         0000000000000000000000000000000000000000000000000000000000000006
         667265657a650000000000000000000000000000000000000000000000000000`);
/** queue/execute/cancel share one body on the OZ path; only the selector differs. */
const OZ_QEC_BODY = strip(`
         0000000000000000000000000000000000000000000000000000000000000080
         00000000000000000000000000000000000000000000000000000000000000c0
         0000000000000000000000000000000000000000000000000000000000000100
         456eb9a5c6a00ab7f657bf96233594184c525854814987356d7702a9a58fa986
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000001111111111111111111111111111111111111111
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000000
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000020
         0000000000000000000000000000000000000000000000000000000000000004
         deadbeef00000000000000000000000000000000000000000000000000000000`);

describe("uniswap (bravo-v3) calldata is byte-frozen", () => {
  it("propose keeps the 5-arg Bravo signature (signatures[] included)", () => {
    const b = buildPropose(uniswap, { ...OZ_ARGS, signatures: [""] });
    expect(b.to).toBe("0x408ED6354d4973f66138C91495F2f2FCbd8724C3");
    expect(b.selector).toBe("0xda95691a");
    expect(b.family).toBe("bravo");
    expect(b.data).toBe(
      "0xda95691a" +
        strip(`
         00000000000000000000000000000000000000000000000000000000000000a0
         00000000000000000000000000000000000000000000000000000000000000e0
         0000000000000000000000000000000000000000000000000000000000000120
         0000000000000000000000000000000000000000000000000000000000000180
         0000000000000000000000000000000000000000000000000000000000000200
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000001111111111111111111111111111111111111111
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000000
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000020
         0000000000000000000000000000000000000000000000000000000000000000
         0000000000000000000000000000000000000000000000000000000000000001
         0000000000000000000000000000000000000000000000000000000000000020
         0000000000000000000000000000000000000000000000000000000000000004
         deadbeef00000000000000000000000000000000000000000000000000000000
         0000000000000000000000000000000000000000000000000000000000000006
         667265657a650000000000000000000000000000000000000000000000000000`),
    );
  });

  it("vote cast — plain and with reason", () => {
    const plain = buildVoteCast(uniswap, "42", 1);
    expect(plain.selector).toBe("0x56781388");
    expect(plain.data).toBe(VOTE_FOR_42);
    expect(buildVoteCast(uniswap, "42", 2, "no economic impact").selector).toBe("0x7b3c71d3");
  });

  it("queue / execute / cancel take a bare proposalId", () => {
    const id = "000000000000000000000000000000000000000000000000000000000000002a";
    expect(buildQueue(uniswap, { proposalId: "42" }).data).toBe(`0xddf0b009${id}`);
    expect(buildExecute(uniswap, { proposalId: "42" }).data).toBe(`0xfe0d94c1${id}`);
    expect(buildCancel(uniswap, { proposalId: "42" }).data).toBe(`0x40e58ee5${id}`);
  });

  it("delegate targets the voting token, not the governor", () => {
    const b = buildDelegate(uniswap, DELEGATEE);
    // D5-2 re-checksummed this address; the value is the same UNI token and the
    // calldata is unchanged.
    expect(b.to).toBe("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984");
    expect(b.data).toBe(DELEGATE_DATA);
  });
});

describe("optimism (oz-v4) calldata is byte-frozen", () => {
  it("propose", () => {
    const b = buildPropose(optimism, OZ_ARGS);
    expect(b.to).toBe("0xcDF27F107725988f2261Ce2256bDfCdE8B382B10");
    expect(b.selector).toBe("0x7d5e81e2");
    expect(b.family).toBe("oz");
    expect(b.data).toBe("0x7d5e81e2" + OZ_PROPOSE_BODY);
  });

  it("queue / execute / cancel take the 4-arg tuple with descriptionHash", () => {
    expect(buildQueue(optimism, OZ_ARGS).data).toBe("0x160cbed7" + OZ_QEC_BODY);
    expect(buildExecute(optimism, OZ_ARGS).data).toBe("0x2656227d" + OZ_QEC_BODY);
    expect(buildCancel(optimism, OZ_ARGS).data).toBe("0x452115d6" + OZ_QEC_BODY);
  });

  it("vote cast", () => {
    expect(buildVoteCast(optimism, "42", 1).data).toBe(VOTE_FOR_42);
  });

  it("delegate targets OP", () => {
    const b = buildDelegate(optimism, DELEGATEE);
    expect(b.to).toBe("0x4200000000000000000000000000000000000042");
    expect(b.data).toBe(DELEGATE_DATA);
  });
});

describe("compound moved to the OZ shapes (D5-1)", () => {
  it("propose uses the 4-arg OZ signature — same bytes as optimism, different `to`", () => {
    const b = buildPropose(compound, OZ_ARGS);
    expect(b.selector).toBe("0x7d5e81e2");
    expect(b.family).toBe("oz");
    expect(b.to).toBe("0x309a862bbC1A00e45506cB8A802D1ff10004c8C0");
    expect(b.data).toBe("0x7d5e81e2" + OZ_PROPOSE_BODY);
  });

  it("queue/execute now need the tuple — a bare proposalId is refused", () => {
    expect(() => buildQueue(compound, { proposalId: "605" })).toThrow();
    expect(() => buildExecute(compound, { proposalId: "605" })).toThrow();
    expect(buildQueue(compound, OZ_ARGS).data).toBe("0x160cbed7" + OZ_QEC_BODY);
    expect(buildExecute(compound, OZ_ARGS).data).toBe("0x2656227d" + OZ_QEC_BODY);
  });
});

describe("the OZ write ABI stays unambiguous", () => {
  it("declares exactly one overload per write method", () => {
    // CompoundGovernor's implementation ALSO retains Bravo-shaped
    // queue(uint256) / execute(uint256) / cancel(uint256). Adding them here to
    // "support" that would make encodeFunctionData("execute", …) ambiguous and
    // break uniswap and optimism. The 4-arg path works on Compound, so there is
    // no functional loss.
    const names = (GOVERNOR_OZ_WRITE_ABI as readonly string[]).map(
      (f) => f.match(/function (\w+)\(/)?.[1] ?? "",
    );
    expect(new Set(names).size).toBe(names.length);
    for (const frag of GOVERNOR_OZ_WRITE_ABI as readonly string[]) {
      if (/function (queue|execute|cancel)\(/.test(frag)) {
        expect(frag, "OZ queue/execute/cancel must keep the 4-arg shape").toContain("address[] targets");
      }
    }
  });
});
