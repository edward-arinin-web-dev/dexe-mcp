import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `SECURITY.md` ships in the npm tarball (package.json `files`) and is the
 * GitHub-recognized policy file, so a stale claim there is published, not just
 * committed. Three paragraphs were written at 0.5.x and never revisited: CI's
 * test step described as a no-op, the WalletConnect relay described as
 * unshipped with no added dependency, and a guard table two guards short. The
 * last two understate the attack surface, which is the worst direction for a
 * security document to be wrong in.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const security = read("SECURITY.md");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  dependencies: Record<string, string>;
};

/** literal → what it should say now. */
const STALE: Array<[string, string]> = [
  ["--passWithNoTests", "ci.yml runs `npm test` as an enforcing gate"],
  ["Phase A (current)", "the WalletConnect relay session shipped in v0.7.0"],
  ["lands in v0.6.0", "the WalletConnect relay session shipped in v0.7.0"],
  ["no new dependency", "@walletconnect/universal-provider is a runtime dependency"],
  ["four opt-in guards", "six guards run, three of them always on"],
];

describe("SECURITY.md carries no known-stale 0.5.x claims", () => {
  it.each(STALE)("does not contain %j", (literal, remedy) => {
    expect(security, `SECURITY.md still says ${JSON.stringify(literal)} — ${remedy}`).not.toContain(
      literal,
    );
  });
});

describe("SECURITY.md tracks the shipped package", () => {
  it("the supported-version pin matches package.json", () => {
    const m = /Pin to the latest minor \(`\^(\d+\.\d+)`\)/.exec(security);
    expect(m, "SECURITY.md lost its `Pin to the latest minor (^x.y)` sentence").not.toBeNull();
    const [major, minor] = pkg.version.split(".");
    expect(
      m![1],
      `SECURITY.md pins ^${m![1]} but this release is ${pkg.version} — a 0.x caret range does not cross minors, so that pin freezes users off the line that gets the updates`,
    ).toBe(`${major}.${minor}`);
  });

  it("the guard table lists every guard id the code can throw", () => {
    const sources = [read("src/lib/broadcastGuards.ts"), read("src/tools/safe.ts")].join("\n");
    const ids = [...sources.matchAll(/BroadcastGuardError\(\s*"(B\d+)"/g)].map((m) => m[1]!);
    expect(ids.length, "no BroadcastGuardError ids found — did the constructor change?").toBeGreaterThan(0);
    for (const id of new Set(ids)) {
      expect(
        security,
        `guard ${id} is thrown in code but has no **${id}** row in SECURITY.md's guard table`,
      ).toContain(`**${id}**`);
    }
  });

  it("acknowledges the WalletConnect runtime dependency", () => {
    if (!pkg.dependencies["@walletconnect/universal-provider"]) return;
    expect(
      security,
      "@walletconnect/universal-provider is a runtime dependency and SECURITY.md does not name it",
    ).toContain("@walletconnect/universal-provider");
  });
});
