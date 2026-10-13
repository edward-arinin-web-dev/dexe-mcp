import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMainModule } from "@dexe-network/dexe-mcp/core";

/**
 * npm installs a package's bins on Linux and macOS as SYMLINKS
 * (`node_modules/.bin/dexe-mcp`, `/usr/local/bin/dexe-mcp`). Both binaries
 * decide whether to boot by asking "am I the entrypoint?"; from 0.30.1 to
 * 0.36.0 `dexe-mcp` compared `import.meta.url` (the resolved file) with
 * `process.argv[1]` (the link) as strings, so every npx or global install off
 * Windows exited 0 without serving, or printing --version / --help.
 *
 * Windows bins are .cmd shims, and creating a symlink there needs Developer
 * Mode; the symlink cases skip when the OS refuses one. CI runs on Linux.
 */

const ROOT = resolve(__dirname, "..", "..");
const version = (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string }).version;
const work = mkdtempSync(join(tmpdir(), "dexe-symlink-bin-"));

function canSymlink(): boolean {
  const target = join(work, "probe-target.js");
  writeFileSync(target, "");
  try {
    symlinkSync(target, join(work, "probe-link.js"));
    return true;
  } catch {
    return false;
  }
}
const symlinks = canSymlink();

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("isMainModule", () => {
  const file = join(work, "entry.js");
  writeFileSync(file, "");
  const url = pathToFileURL(file).href;

  it("matches the file itself and nothing else", () => {
    expect(isMainModule(url, file)).toBe(true);
    expect(isMainModule(url, join(work, "other.js"))).toBe(false);
    expect(isMainModule(url, undefined)).toBe(false);
  });

  it.skipIf(!symlinks)("matches through a symlink, as npm installs a bin", () => {
    const link = join(work, "entry-link");
    symlinkSync(file, link);
    expect(isMainModule(url, link)).toBe(true);
  });
});

describe.skipIf(!symlinks)("the built binaries, launched through a symlink", () => {
  it.each([
    ["dexe-mcp", resolve(ROOT, "dist", "index.js")],
    ["dexe-mcp-read", resolve(ROOT, "dist", "read", "bin.js")],
  ])("%s --version answers", (name, target) => {
    if (!existsSync(target)) return; // needs `npm run build`, like tests/cli/usage.test.ts
    const link = join(work, name);
    symlinkSync(target, link);
    const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8", timeout: 15_000, input: "" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });
});
