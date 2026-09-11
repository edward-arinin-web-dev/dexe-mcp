import { describe, expect, it } from "vitest";
import { cidForJson, pinataCidForJson, pinJsonOrPreview, type PinataClient } from "../../src/lib/ipfs.js";

/**
 * The load-bearing claim of the 0.34.0 dryRun work: a preview's CID is the SAME
 * CID a real Pinata pin returns, so preview calldata and real calldata are byte
 * identical and nobody has to choose between "a side-effect-free preview" and "a
 * preview that shows the real bytes".
 *
 * Before this, previews used `cidForJson` — a multiformats json-codec CIDv1
 * (`bagaaiera…`) — while Pinata's `pinJSONToIPFS` returns a UnixFS dag-pb CIDv0
 * (`Qm…`). They can never be equal, so a preview's `descriptionURL` was a value
 * the real run would never emit, and a payload copied out of a preview deployed
 * a DAO whose profile resolved to nothing.
 *
 * The two vectors below are REAL Pinata responses: `dexe_dao_create` pinned them
 * during the 2026-09-11 audit (findings D4-1 / D4-5 recorded the CIDs; the bytes
 * were fetched back from gateway.pinata.cloud). They are the regression lock —
 * if `pinataCidForJson` ever stops reproducing them, previews have gone back to
 * lying about the calldata.
 */

/** The `default` settings slot of a SIMPLE-mode DAO (558 B as Pinata stored it). */
const SETTINGS_DEFAULT = {
  earlyCompletion: true,
  delegatedVotingAllowed: false,
  validatorsVote: true,
  duration: "86400",
  durationValidators: "86400",
  quorum: "510000000000000000000000000",
  quorumValidators: "510000000000000000000000000",
  minVotesForVoting: "1000000000000000000",
  minVotesForCreating: "1000000000000000000",
  executionDelay: "0",
  rewardsInfo: {
    rewardToken: "0x0000000000000000000000000000000000000000",
    creationReward: "0",
    executionReward: "0",
    voteRewardsCoefficient: "0",
  },
  minVotesForReadProposalDiscussion: "0",
  minVotesForCreatingComment: "1000000000000000000",
};

/** The `distributionProposal` slot — same shape, earlyCompletion false (559 B). */
const SETTINGS_DISTRIBUTION = { ...SETTINGS_DEFAULT, earlyCompletion: false };

const RECORDED: Array<[string, unknown, string]> = [
  ["dao-settings default", SETTINGS_DEFAULT, "QmdFNFNZ2Uku589i8fm8kFsyRjXYSBzoG9tDQAffZ8ixN4"],
  ["dao-settings distributionProposal", SETTINGS_DISTRIBUTION, "QmZXSnHWDRtSRKvLKJLx6QEx4TNUDz9sVv3pDsiARPdLLE"],
];

describe("pinataCidForJson — parity with a real Pinata pin", () => {
  it.each(RECORDED)("%s reproduces the CID Pinata actually returned", async (_label, value, expected) => {
    const r = await pinataCidForJson(value);
    expect(r.cid).toBe(expected);
    expect(r.exact).toBe(true);
  });

  it("is NOT the json-codec CID — that is the bug this replaced", async () => {
    const local = await cidForJson(SETTINGS_DEFAULT);
    expect(local).toMatch(/^bagaaiera/);
    expect(local).not.toBe("QmdFNFNZ2Uku589i8fm8kFsyRjXYSBzoG9tDQAffZ8ixN4");
  });

  it("flags a non-ASCII payload as not provably exact", async () => {
    const ascii = await pinataCidForJson({ daoName: "Aurora Collective" });
    expect(ascii.exact).toBe(true);
    const unicode = await pinataCidForJson({ daoName: "Café Collective ☕" });
    expect(unicode.exact).toBe(false);
    // Still a well-formed dag-pb CIDv0 — the shape never degrades.
    expect(unicode.cid).toMatch(/^Qm/);
  });

  it("flags a payload past the single-chunk boundary as not provably exact", async () => {
    const big = await pinataCidForJson({ blob: "a".repeat(300_000) });
    expect(big.exact).toBe(false);
  });
});

describe("pinJsonOrPreview", () => {
  it("under dryRun returns the pin-identical CID and never touches the client", async () => {
    let called = 0;
    const pinata = {
      pinJson: async () => {
        called++;
        return { cid: "QmSHOULD_NOT_HAPPEN", size: 1, pinnedAt: "x" };
      },
    } as unknown as PinataClient;
    const r = await pinJsonOrPreview(SETTINGS_DEFAULT, { dryRun: true, pinata, name: "x" });
    expect(called).toBe(0);
    expect(r.pinned).toBe(false);
    expect(r.exact).toBe(true);
    expect(r.cid).toBe("QmdFNFNZ2Uku589i8fm8kFsyRjXYSBzoG9tDQAffZ8ixN4");
    expect(r.uri).toBe("ipfs://QmdFNFNZ2Uku589i8fm8kFsyRjXYSBzoG9tDQAffZ8ixN4");
  });

  it("on a real run pins once and reports pinned:true", async () => {
    const calls: unknown[] = [];
    const pinata = {
      pinJson: async (v: unknown, o: unknown) => {
        calls.push([v, o]);
        return { cid: "QmFAKE", size: 1, pinnedAt: "x" };
      },
    } as unknown as PinataClient;
    const r = await pinJsonOrPreview({ a: 1 }, { dryRun: false, pinata, name: "label" });
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ uri: "ipfs://QmFAKE", cid: "QmFAKE", pinned: true, exact: true });
  });

  it("refuses a real pin with no client rather than silently faking a CID", async () => {
    await expect(pinJsonOrPreview({ a: 1 }, { dryRun: false })).rejects.toThrow(/DEXE_PINATA_JWT/);
  });
});
