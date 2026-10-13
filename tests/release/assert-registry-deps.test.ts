import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, no type declarations
import { isLocalSpec, localDependencies } from "../../scripts/assert-registry-deps.mjs";

/**
 * scripts/assert-registry-deps.mjs runs first in `prepublishOnly`: while the
 * read edition is a vendored tarball (file:vendor/…), `npm publish` must stop,
 * because npm publishes the spec as written and every install would fail.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "assert-registry-deps.mjs");
const work = mkdtempSync(join(tmpdir(), "dexe-registry-deps-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("isLocalSpec", () => {
  it.each([
    "file:vendor/dexe-network-dexe-mcp-1.0.0-rc.1.tgz",
    "FILE:../x",
    "link:../read",
    "git+file:///srv/repo.git",
    "./vendor/x.tgz",
    "../dexe-network-mcp",
    "..",
    "~/pkgs/x",
    "/opt/pkgs/x",
    "C:\\pkgs\\x.tgz",
    "c:/pkgs/x",
    "vendor/dexe-network-dexe-mcp-1.0.0-rc.1.tgz",
    "pkgs/x.tar.gz",
  ])("%s is local", (spec) => {
    expect(isLocalSpec(spec)).toBe(true);
  });

  it.each([
    "1.0.0-rc.1",
    "^1.31.0",
    ">=8.21.0",
    "latest",
    "npm:other@1.0.0",
    "github:owner/repo",
    "owner/repo",
    // a remote tarball ends in .tgz too, but npm fetches it
    "https://x.example/p.tgz",
    "git+https://github.com/owner/repo.git",
  ])("%s is not", (spec) => {
    expect(isLocalSpec(spec)).toBe(false);
  });

  it("scans every dependency field", () => {
    const found = localDependencies({
      dependencies: { a: "1.0.0" },
      devDependencies: { b: "file:../b" },
      optionalDependencies: { c: "vendor/c.tgz" },
      peerDependencies: { d: "~/d" },
    });
    expect(found.map((f: { field: string; name: string }) => `${f.field}.${f.name}`)).toEqual([
      "devDependencies.b",
      "optionalDependencies.c",
      "peerDependencies.d",
    ]);
  });
});

describe("the script", () => {
  const run = (pkg: unknown) => {
    const p = join(work, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(pkg));
    return spawnSync(process.execPath, [SCRIPT, p], { encoding: "utf8" });
  };

  it("exits 1 and names the dependency when one is local", () => {
    const r = run({ devDependencies: { x: "vendor/x.tgz" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('devDependencies.x is "vendor/x.tgz"');
  });

  it("exits 0 when every dependency comes from a registry", () => {
    expect(run({ dependencies: { "@dexe-network/dexe-mcp": "1.0.0-rc.1", ethers: "^6.17.0" } }).status).toBe(0);
  });

  it("is armed for this package exactly while the read edition is vendored", () => {
    const own = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(own.scripts.prepublishOnly).toMatch(/^node scripts\/assert-registry-deps\.mjs && /);
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(own.dependencies["@dexe-network/dexe-mcp"]!.startsWith("file:") ? 1 : 0);
  });
});
