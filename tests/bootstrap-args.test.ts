import { describe, expect, it } from "vitest";
import { buildCloneArgs, buildNpmInstallArgs } from "../src/bootstrap.js";

/**
 * H-1 / H-2 guardrail. The first-run bootstrap cloned DeXe-Protocol at a
 * floating HEAD and ran `npm install` WITHOUT `--ignore-scripts`, so a
 * postinstall script in the tree or a transitive dep could execute arbitrary
 * code as the MCP user (and exfiltrate DEXE_PRIVATE_KEY from the env). These
 * pin the security-relevant arg construction.
 */

const REPO = "https://github.com/dexe-network/DeXe-Protocol.git";

describe("buildNpmInstallArgs (H-1/H-2)", () => {
  it("always passes --ignore-scripts to block postinstall RCE", () => {
    const args = buildNpmInstallArgs([]);
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("install");
  });

  it("preserves npm-cli prefix args (e.g. node + npm-cli.js path)", () => {
    const args = buildNpmInstallArgs(["/path/npm-cli.js"]);
    expect(args[0]).toBe("/path/npm-cli.js");
    expect(args).toContain("--ignore-scripts");
  });
});

describe("buildCloneArgs (H-1/H-2)", () => {
  it("shallow-clones the default branch when no ref is pinned", () => {
    expect(buildCloneArgs(REPO, "DeXe-Protocol")).toEqual([
      "clone",
      "--depth",
      "1",
      REPO,
      "DeXe-Protocol",
    ]);
  });

  it("pins to a branch/tag when DEXE_PROTOCOL_REF is set", () => {
    expect(buildCloneArgs(REPO, "DeXe-Protocol", "v2.0.0")).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "v2.0.0",
      REPO,
      "DeXe-Protocol",
    ]);
  });

  it("ignores a blank ref", () => {
    expect(buildCloneArgs(REPO, "DeXe-Protocol", "   ")).not.toContain("--branch");
  });
});
