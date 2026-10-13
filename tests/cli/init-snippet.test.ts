import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsonSnippet } from "../../src/cli/init.js";

/**
 * `dexe-mcp init` prints the `mcpServers` block for the host config (it never
 * edits that file). Since 1.0.0 the write server registers write tools only,
 * so the block carries TWO servers: `dexe` (this package) and `dexe-read` (the
 * DeXe read server, started from the @dexe-network/dexe-mcp dependency this
 * install carries — no npx, no network at launch).
 */
const ROOT = resolve(__dirname, "..", "..");

describe("init's host-config snippet", () => {
  const snippet = JSON.parse(jsonSnippet(ROOT)) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };

  it("is valid JSON with exactly the write and the read server", () => {
    expect(Object.keys(snippet.mcpServers)).toEqual(["dexe", "dexe-read"]);
  });

  it("starts both with node from this install", () => {
    expect(snippet.mcpServers.dexe).toEqual({ command: "node", args: [resolve(ROOT, "dist", "index.js")] });
    expect(snippet.mcpServers["dexe-read"]).toEqual({ command: "node", args: [resolve(ROOT, "dist", "read", "bin.js")] });
  });

  it("points the read server at the file the package ships (and a build produces)", () => {
    // tests/docs/pack-contents.test.ts keeps dist/read/bin.js in the npm package.
    expect(readFileSync(resolve(ROOT, "src", "read", "bin.ts"), "utf8")).toContain("runReadBin");
    if (existsSync(resolve(ROOT, "dist", "index.js"))) {
      expect(existsSync(resolve(ROOT, "dist", "read", "bin.js"))).toBe(true);
    }
  });

  it("the package no longer declares the dexe-mcp-read bin (the read package owns it)", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ "dexe-mcp": "dist/index.js" });
  });
});
