import { describe, expect, it } from "vitest";
import { Interface, keccak256, toUtf8Bytes } from "ethers";
import { resolveGovernor } from "../../src/governor/loader.js";
import {
  buildCancel,
  decodeGovernorWrite,
  GOVERNOR_BRAVO_WRITE_ABI,
  GOVERNOR_OZ_WRITE_ABI,
} from "../../src/governor/encoder.js";
import {
  GOVERNOR_BRAVO_READ_ABI,
  GOVERNOR_OZ_READ_ABI,
} from "../../src/governor/adapter.js";
import type { GovernorConfig } from "../../src/governor/loader.js";

const uniswap = resolveGovernor("uniswap");
const ozFixture: GovernorConfig = { ...uniswap, id: "fixture-oz", governorVersion: "oz-v4" };

const targets = ["0x000000000000000000000000000000000000bEEF"];
const values = ["0"];
const calldatas = ["0xdeadbeef"];
const description = "Cancel proposal";

describe("buildCancel — family branching", () => {
  it("Bravo cancel takes proposalId only", () => {
    const out = buildCancel(uniswap, { proposalId: "11" });
    expect(out.family).toBe("bravo");
    expect(out.method).toBe("cancel");
    const expected = new Interface(GOVERNOR_BRAVO_WRITE_ABI as unknown as string[])
      .getFunction("cancel")!
      .selector;
    expect(out.selector).toBe(expected);
    const decoded = decodeGovernorWrite(uniswap, out.data);
    expect((decoded.args[0] as bigint).toString()).toBe("11");
  });

  it("OZ cancel uses 4-arg shape with descriptionHash", () => {
    const out = buildCancel(ozFixture, { targets, values, calldatas, description });
    expect(out.family).toBe("oz");
    const expected = new Interface(GOVERNOR_OZ_WRITE_ABI as unknown as string[])
      .getFunction("cancel")!
      .selector;
    expect(out.selector).toBe(expected);
    const decoded = decodeGovernorWrite(ozFixture, out.data);
    const expectedHash = keccak256(toUtf8Bytes(description));
    expect((decoded.args[3] as string).toLowerCase()).toBe(expectedHash.toLowerCase());
  });

  it("Bravo cancel selector differs from OZ cancel selector", () => {
    const bravoCancel = buildCancel(uniswap, { proposalId: "1" });
    const ozCancel = buildCancel(ozFixture, { targets, values, calldatas, description });
    expect(bravoCancel.selector).not.toBe(ozCancel.selector);
  });
});

describe("decodeGovernorWrite — round-trips every build* output", () => {
  it("Bravo cancel decodes back to proposalId", () => {
    const out = buildCancel(uniswap, { proposalId: "42" });
    const decoded = decodeGovernorWrite(uniswap, out.data);
    expect(decoded.method).toBe("cancel");
    expect((decoded.args[0] as bigint).toString()).toBe("42");
  });
});

describe("has_voted — family read surface", () => {
  // Regression: GovernorBravo (Uniswap/Compound) has no hasVoted(proposalId,account);
  // it exposes getReceipt(...).hasVoted. The OZ family does implement hasVoted.
  it("Bravo read ABI exposes getReceipt and NOT hasVoted", () => {
    const iface = new Interface(GOVERNOR_BRAVO_READ_ABI as unknown as string[]);
    expect(iface.getFunction("getReceipt")).toBeTruthy();
    expect(iface.getFunction("getReceipt")!.outputs.some((o) => o.name === "hasVoted")).toBe(true);
    expect(iface.getFunction("hasVoted")).toBeNull();
  });

  it("OZ read ABI exposes hasVoted", () => {
    const iface = new Interface(GOVERNOR_OZ_READ_ABI as unknown as string[]);
    expect(iface.getFunction("hasVoted")).toBeTruthy();
  });
});

describe("description hash helpers", () => {
  it("keccak256(toUtf8Bytes(description)) matches what OZ builders use", () => {
    const desc = "Test description #42";
    const hash = keccak256(toUtf8Bytes(desc));
    expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });
});
