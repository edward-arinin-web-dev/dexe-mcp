import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The governor-chain public RPC fallback (`governorProvider`): the Tier-1
 * fixtures live on chains 1 and 10, which the BSC public fallback does not
 * cover, so every governor tool must reach its provider through
 * `governorProvider(rpc, cfg)`.
 *
 * `governorProvider` itself, and the read tools that use it, are the read
 * edition's (@dexe-network/dexe-mcp): their behaviour is pinned in its copy of
 * this file. What stays here is the guard over this repo's governor tools — the
 * write ones (build, extrasWrite, simulateWrite).
 */

describe("governor tools all route through the fallback", () => {
  // Static guard, in the style of tests/governor/isolation.test.ts: a new tool
  // added on the old `rpc.tryProvider` path would silently reintroduce the
  // first-call failure on chains 1 and 10.
  it("no src/governor/tools/*.ts calls rpc.tryProvider directly", () => {
    const root = resolve(__dirname, "..", "..", "src", "governor", "tools");
    const files = readdirSync(root).filter((f) => f.endsWith(".ts"));
    expect(files).toEqual(expect.arrayContaining(["build.ts", "extrasWrite.ts", "simulateWrite.ts"]));
    for (const f of files) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, `${f} must use governorProvider(rpc, cfg)`).not.toContain("rpc.tryProvider(");
    }
  });
});
