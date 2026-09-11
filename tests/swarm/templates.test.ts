import { describe, it, expect } from "vitest";
import {
  DAO_TEMPLATE_KEYS,
  isDaoTemplateKey,
  resolveTimeTemplate,
  unknownDaoKeyMessage,
} from "./lib/templates.js";

describe("resolveTimeTemplate", () => {
  const FIXED = 1_700_000_000;

  const table: Array<[string, string]> = [
    ["now", "1700000000"],
    ["now+2592000", "1702592000"],
    ["now-3600", "1699996400"],
    ["now+0", "1700000000"],
    ["now+600", "1700000600"],
  ];
  for (const [token, want] of table) {
    it(`{{${token}}} → ${want}`, () => {
      expect(resolveTimeTemplate(token, FIXED)).toBe(want);
    });
  }

  it("returns null for tokens it does not own, so expand() falls through", () => {
    for (const t of ["dao", "dao.userKeeper", "firstAllowlistedToken", "agent:A:address", "created.proposalId"]) {
      expect(resolveTimeTemplate(t, FIXED)).toBeNull();
    }
  });

  it("does not hijack a capture whose name merely starts with 'now'", () => {
    // A capture named `nowState` must fall through to the captures lookup, not
    // blow up as a malformed now-template.
    for (const t of ["nowState", "nowState.value", "nowhere", "now_state"]) {
      expect(resolveTimeTemplate(t, FIXED), t).toBeNull();
    }
  });

  it("throws loudly on a malformed now-template instead of resolving to ''", () => {
    // "" would become BigInt("") === 0n downstream and the operator would see
    // "the sale window is in the PAST" instead of "bad template".
    for (const bad of ["now+abc", "now++600", "now+6.5", "now+", "now-", "now-1x"]) {
      expect(() => resolveTimeTemplate(bad, FIXED), bad).toThrow(/malformed/);
    }
  });

  it("uses the live clock when no clock is injected", () => {
    const v = resolveTimeTemplate("now");
    expect(v).toMatch(/^\d{10}$/);
    expect(Math.abs(Number(v) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
  });

  it("returns a decimal STRING — every consuming field is z.string()", () => {
    expect(typeof resolveTimeTemplate("now+1", FIXED)).toBe("string");
  });
});

describe("dao template keys", () => {
  it("covers the five helper contracts, the four NFT contracts and the two predicted helpers", () => {
    expect([...DAO_TEMPLATE_KEYS]).toEqual([
      "settings",
      "userKeeper",
      "validators",
      "poolRegistry",
      "votePower",
      "nftMultiplier",
      "expertNft",
      "dexeExpertNft",
      "babt",
      "tokenSale",
      "distributionProposal",
    ]);
  });

  it("rejects a typo and says which keys exist", () => {
    expect(isDaoTemplateKey("nftMultiplierr")).toBe(false);
    expect(isDaoTemplateKey("expertNft")).toBe(true);
    expect(unknownDaoKeyMessage("nftMultiplierr")).toContain("nftMultiplier");
  });
});
