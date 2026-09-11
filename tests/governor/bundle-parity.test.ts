import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadGovernorConfigs } from "../../src/governor/loader.js";

/**
 * 0.34.0 repointed three Tier-1 Governor fixtures: Compound's retired
 * GovernorBravo → CompoundGovernor, Uniswap's timelock (the shipped address had
 * no contract at it), and Optimism's newly-added timelock. Those configs are
 * compiled INTO `dexe-plugin/server/index.mjs` by esbuild, so a release that
 * bumps the version without re-running `npm run bundle:plugin` ships a plugin
 * that still talks to the dead addresses — with no other signal.
 *
 * Every fixture address must therefore appear verbatim in the bundle.
 */
const ROOT = process.cwd();
const BUNDLE = resolve(ROOT, "dexe-plugin", "server", "index.mjs");

const addresses = (() => {
  const out: Array<[string, string]> = [];
  for (const [key, cfg] of loadGovernorConfigs()) {
    out.push([`${key}.governorAddress`, cfg.governorAddress]);
    out.push([`${key}.votingToken.address`, cfg.votingToken.address]);
    if (cfg.timelock?.address) out.push([`${key}.timelock.address`, cfg.timelock.address]);
  }
  return out;
})();

describe("plugin bundle carries the shipped Governor fixtures", () => {
  it("the bundle exists (run `npm run bundle:plugin`)", () => {
    expect(existsSync(BUNDLE), `${BUNDLE} missing — run \`npm run bundle:plugin\``).toBe(true);
  });

  it.each(addresses)("%s (%s) is in dexe-plugin/server/index.mjs", (label, address) => {
    const bundle = readFileSync(BUNDLE, "utf8");
    expect(
      bundle.includes(address),
      `${label} = ${address} is not in the plugin bundle — it was changed in src/governor/configs without re-running \`npm run bundle:plugin\`, so plugin users would still hit the previous address`,
    ).toBe(true);
  });
});
