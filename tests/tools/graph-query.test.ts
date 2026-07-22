import { describe, expect, it } from "vitest";
import { graphQueryGuard } from "../../src/tools/subgraph.js";
import { downsample } from "../../src/tools/read.js";

describe("graphQueryGuard", () => {
  it("accepts query documents and bare selection sets", () => {
    expect(graphQueryGuard("{ daoPools(first: 5) { id } }")).toBeNull();
    expect(graphQueryGuard("query X($a: BigInt!) { proposals(first: 1) { id } }")).toBeNull();
    expect(graphQueryGuard("# comment\nquery { transactions(first: 1) { id } }")).toBeNull();
  });

  it("rejects mutations, subscriptions, empty and junk input", () => {
    expect(graphQueryGuard("mutation { x }")).toMatch(/read/i);
    expect(graphQueryGuard("subscription { x }")).toMatch(/read/i);
    expect(graphQueryGuard("   ")).toMatch(/empty/i);
    expect(graphQueryGuard("SELECT * FROM daos")).toMatch(/must start/i);
  });
});

describe("downsample", () => {
  const series = Array.from({ length: 741 }, (_, i) => i);

  it("keeps short series untouched", () => {
    expect(downsample([1, 2, 3], 30)).toEqual([1, 2, 3]);
  });

  it("caps long series, keeping first and last", () => {
    const out = downsample(series, 30);
    expect(out.length).toBe(30);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(740);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });

  it("max 2 returns endpoints only", () => {
    expect(downsample(series, 2)).toEqual([0, 740]);
  });
});
