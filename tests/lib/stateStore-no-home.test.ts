import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { StateStore, resolveStatePath } from "../../src/lib/stateStore.js";

/**
 * `resolveStatePath()` runs inside `loadConfig()`, i.e. on the startup path,
 * and `os.homedir()` is not total: on a host with neither HOME nor USERPROFILE
 * (scrubbed containers, some CI images, locked-down corporate Windows
 * profiles) libuv's lookup fails and Node throws. A throw there would send the
 * entire server into degraded mode — no DAO tools at all — over a cache file
 * that nothing depends on.
 *
 * node:os is mocked for this whole file, which is why it lives apart from the
 * other stateStore suites.
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: actual,
    homedir: () => {
      throw new Error("ENOENT: uv_os_homedir failed");
    },
  };
});

const prev = process.env.DEXE_STATE_PATH;
afterEach(() => {
  if (prev === undefined) delete process.env.DEXE_STATE_PATH;
  else process.env.DEXE_STATE_PATH = prev;
});

describe("resolveStatePath with no home directory", () => {
  it("does not throw — startup must not die over a cache file", () => {
    delete process.env.DEXE_STATE_PATH;
    expect(() => resolveStatePath()).not.toThrow();
  });

  it("falls back to the temp dir, keeping the same layout", () => {
    delete process.env.DEXE_STATE_PATH;
    const p = resolveStatePath();
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p).toContain(".dexe-mcp");
    expect(p.endsWith("state.json")).toBe(true);
  });

  it("still honours an explicit DEXE_STATE_PATH", () => {
    process.env.DEXE_STATE_PATH = "/data/dexe/state.json";
    expect(resolveStatePath()).toBe("/data/dexe/state.json");
  });

  it("an explicit override argument still wins", () => {
    expect(resolveStatePath("/opt/state.json")).toBe("/opt/state.json");
  });

  it("a store built on the fallback path reads without throwing", () => {
    delete process.env.DEXE_STATE_PATH;
    const store = new StateStore(resolveStatePath());
    expect(() => store.getState()).not.toThrow();
  });
});
