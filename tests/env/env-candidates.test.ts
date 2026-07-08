import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveEnvCandidates } from "../../src/env/loader.js";

// cwd-independent .env resolution — the fix for plugin servers launched from an
// arbitrary working directory (any OS) never finding the user's config.
describe("resolveEnvCandidates", () => {
  const cwd = resolve("/some/project");
  const home = resolve("/home/user");
  const pkgDir = resolve("/npx/cache/dexe-mcp/dist");

  it("always includes cwd/.env, ~/.dexe-mcp/.env, and pkgDir/../.env in order", () => {
    const c = resolveEnvCandidates({ cwd, home, pkgDir });
    expect(c).toEqual([
      resolve(cwd, ".env"),
      resolve(home, ".dexe-mcp", ".env"),
      resolve(pkgDir, "..", ".env"),
    ]);
  });

  it("puts the home config ahead of the package dir (universal beats npx cache)", () => {
    const c = resolveEnvCandidates({ cwd, home, pkgDir });
    expect(c.indexOf(resolve(home, ".dexe-mcp", ".env"))).toBeLessThan(
      c.indexOf(resolve(pkgDir, "..", ".env")),
    );
  });

  it("an explicit DEXE_ENV_FILE is tried first", () => {
    const explicit = resolve("/etc/dexe/prod.env");
    const c = resolveEnvCandidates({ cwd, home, pkgDir, explicit });
    expect(c[0]).toBe(explicit);
    expect(c).toHaveLength(4);
  });

  it("blank/whitespace explicit is ignored", () => {
    expect(resolveEnvCandidates({ cwd, home, pkgDir, explicit: "   " })).toHaveLength(3);
    expect(resolveEnvCandidates({ cwd, home, pkgDir, explicit: "" })).toHaveLength(3);
  });

  it("dedups when cwd and the package parent resolve to the same file", () => {
    const repo = resolve("/repo");
    const c = resolveEnvCandidates({ cwd: repo, home, pkgDir: resolve(repo, "dist") });
    // cwd/.env === pkgDir/../.env → listed once
    expect(c.filter((p) => p === resolve(repo, ".env"))).toHaveLength(1);
    expect(c).toEqual([resolve(repo, ".env"), resolve(home, ".dexe-mcp", ".env")]);
  });
});
