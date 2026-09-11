import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertDistFresh, fileMtime, newestMtime } from "../../scripts/swarm/dist-freshness.mjs";

describe("assertDistFresh", () => {
  it("a missing dist/index.js is fatal and names the build command", () => {
    const r = assertDistFresh(null, 123);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.level).toBe("missing");
    expect(r.message).toMatch(/dist\/index\.js not found/);
    expect(r.message).toMatch(/npm run build/);
  });

  it("src newer than dist is stale, and the message names the override", () => {
    const r = assertDistFresh(100, 200);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.level).toBe("stale");
    expect(r.message).toMatch(/npm run build/);
    expect(r.message).toMatch(/SWARM_SKIP_DIST_CHECK/);
  });

  it("dist newer than, or equal to, src is fresh", () => {
    expect(assertDistFresh(200, 100)).toEqual({ ok: true });
    expect(assertDistFresh(200, 200)).toEqual({ ok: true });
  });

  it("no src/ at all (installed-package layout) skips the check", () => {
    expect(assertDistFresh(200, null)).toEqual({ ok: true });
  });
});

describe("fs helpers", () => {
  it("newestMtime returns null for a directory that does not exist", () => {
    expect(newestMtime(resolve("no/such/dir/anywhere"))).toBeNull();
  });

  it("newestMtime walks a real tree", () => {
    const m = newestMtime(resolve("scripts/swarm"));
    expect(typeof m).toBe("number");
    expect(m).toBeGreaterThan(0);
  });

  it("fileMtime returns null for a missing file and a number for a real one", () => {
    expect(fileMtime(resolve("no/such/file.js"))).toBeNull();
    expect(typeof fileMtime(resolve("package.json"))).toBe("number");
  });
});

describe("nightly.sh wiring", () => {
  const sh = readFileSync(resolve("scripts/swarm/nightly.sh"), "utf8");

  it("builds before it runs the broadcast sweep", () => {
    const build = sh.indexOf("npm run build");
    // The command invocation, not the word — a comment mentioning swarm:run
    // must not satisfy this.
    const sweep = sh.indexOf("npm run --silent swarm:run");
    expect(build, "nightly.sh must run `npm run build`").toBeGreaterThan(-1);
    expect(sweep, "nightly.sh must invoke the sweep").toBeGreaterThan(-1);
    expect(build).toBeLessThan(sweep);
  });

  it("builds unconditionally, not only when package files changed", () => {
    // The conditional install block ends at its `fi`; the build must come after.
    const installGuard = sh.indexOf("package-lock.json package.json");
    const closingFi = sh.indexOf("\nfi", installGuard);
    expect(sh.indexOf("npm run build")).toBeGreaterThan(closingFi);
  });
});
