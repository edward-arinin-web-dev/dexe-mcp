import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MARKDOWN_LEN,
  markdownToSlate,
  maxMarkdownLen,
} from "../../src/lib/markdownToSlate.js";

/**
 * H-3 guardrail. markdownToSlate is synchronous and super-linear in input size
 * (~16 KB blocks the event loop ~24 s; unbounded input freezes the server).
 * The length cap rejects oversize input BEFORE parsing, so the check is O(1)
 * and the parser never runs on a hostile blob.
 */

describe("markdownToSlate input cap (H-3)", () => {
  it("converts a normal short description", () => {
    const nodes = markdownToSlate("# Hello\n\nA proposal.");
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("rejects input over the cap before reaching the parser", () => {
    const huge = "a".repeat(DEFAULT_MAX_MARKDOWN_LEN + 1);
    expect(() => markdownToSlate(huge)).toThrow(/too long/i);
  });

  it("honors DEXE_MAX_DESCRIPTION_LEN for the cap", () => {
    const prev = process.env.DEXE_MAX_DESCRIPTION_LEN;
    process.env.DEXE_MAX_DESCRIPTION_LEN = "1000";
    try {
      expect(maxMarkdownLen()).toBe(1000);
      expect(() => markdownToSlate("a".repeat(1001))).toThrow(/too long/i);
    } finally {
      if (prev === undefined) delete process.env.DEXE_MAX_DESCRIPTION_LEN;
      else process.env.DEXE_MAX_DESCRIPTION_LEN = prev;
    }
  });

  it("falls back to the default cap for a blank/invalid override", () => {
    const prev = process.env.DEXE_MAX_DESCRIPTION_LEN;
    process.env.DEXE_MAX_DESCRIPTION_LEN = "not-a-number";
    try {
      expect(maxMarkdownLen()).toBe(DEFAULT_MAX_MARKDOWN_LEN);
    } finally {
      if (prev === undefined) delete process.env.DEXE_MAX_DESCRIPTION_LEN;
      else process.env.DEXE_MAX_DESCRIPTION_LEN = prev;
    }
  });
});
