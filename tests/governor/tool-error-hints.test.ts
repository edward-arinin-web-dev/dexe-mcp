import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The legacy-id hint and the public-fallback note only matter if they reach the
 * payload a caller actually sees.
 *
 * The read governor tools (dexe_gov_get_proposal, dexe_gov_has_voted, …) and
 * their error paths are the read edition's (@dexe-network/dexe-mcp): the
 * legacy-id hint, the redaction and the archive-refusal advice are pinned in its
 * copy of this file. What stays here is the guard over this repo's governor
 * tools that take a provider (extrasWrite, simulateWrite).
 */

describe("public-fallback note is wired into every success payload", () => {
  // Static, so it stays offline: default `npm test` must make zero network
  // calls, and actually exercising the fallback means dialing a public endpoint.
  it("every governor tool that takes a provider spreads rpcNote(pr)", () => {
    const root = resolve(__dirname, "..", "..", "src", "governor", "tools");
    const files = readdirSync(root).filter((f) => f.endsWith(".ts"));
    expect(files).toEqual(expect.arrayContaining(["extrasWrite.ts", "simulateWrite.ts"]));
    let checked = 0;
    for (const file of files) {
      const src = readFileSync(resolve(root, file), "utf8");
      const providerSites = src.match(/governorProvider\(rpc, cfg\)/g)?.length ?? 0;
      if (providerSites === 0) continue; // build.ts builds calldata and takes no provider
      checked++;
      const noteSites =
        (src.match(/\.\.\.rpcNote\(pr\)/g)?.length ?? 0) + (src.match(/\.\.\.note,/g)?.length ?? 0);
      expect(
        noteSites,
        `${file}: ${providerSites} provider site(s) but only ${noteSites} payload(s) carry the fallback note`,
      ).toBeGreaterThanOrEqual(providerSites);
    }
    expect(checked, "extrasWrite.ts and simulateWrite.ts each take a provider").toBeGreaterThanOrEqual(2);
  });
});
