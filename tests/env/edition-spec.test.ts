import { describe, expect, it } from "vitest";
import {
  ENV_DISPLAY_ORDER,
  ENV_SPEC,
  ENV_SPEC_DEV,
  ENV_SPEC_WRITE,
  FULL_ENV_SURFACE,
} from "../../src/env/schema.js";
import { ENV_SPEC_READ, FOREIGN_WRITE_ENV_KEYS, READ_ENV_SURFACE } from "../../src/env/schemaRead.js";

/**
 * The env spec split into read / write / dev halves (A5). The single server
 * must see exactly the spec it saw before the split — same vars, same order,
 * same entries — and the read edition must know every write and dev var by
 * name, so a shared `.env` never reads as a page of typos.
 */

const keys = (o: object) => Object.keys(o);

describe("edition env specs", () => {
  it("the three halves are disjoint", () => {
    const seen = new Map<string, string>();
    for (const [name, spec] of Object.entries({ read: ENV_SPEC_READ, write: ENV_SPEC_WRITE, dev: ENV_SPEC_DEV })) {
      for (const k of keys(spec)) {
        expect(seen.get(k), `${k} is in both ${seen.get(k)} and ${name}`).toBeUndefined();
        seen.set(k, name);
      }
    }
  });

  it("ENV_SPEC is exactly their union, in ENV_DISPLAY_ORDER, entry for entry", () => {
    const union = [...keys(ENV_SPEC_READ), ...keys(ENV_SPEC_WRITE), ...keys(ENV_SPEC_DEV)];
    expect([...ENV_DISPLAY_ORDER].sort()).toEqual([...union].sort());
    expect(new Set(ENV_DISPLAY_ORDER).size, "a var is listed twice in ENV_DISPLAY_ORDER").toBe(ENV_DISPLAY_ORDER.length);
    expect(keys(ENV_SPEC)).toEqual([...ENV_DISPLAY_ORDER]);
    const halves: Record<string, unknown> = { ...ENV_SPEC_READ, ...ENV_SPEC_WRITE, ...ENV_SPEC_DEV };
    for (const k of keys(ENV_SPEC)) {
      expect((ENV_SPEC as Record<string, unknown>)[k], k).toBe(halves[k]);
    }
  });

  it("the read edition names every write and dev var as foreign — and nothing else", () => {
    expect([...FOREIGN_WRITE_ENV_KEYS].sort()).toEqual([...keys(ENV_SPEC_WRITE), ...keys(ENV_SPEC_DEV)].sort());
    for (const k of keys(ENV_SPEC_READ)) expect(READ_ENV_SURFACE.isForeign?.(k), k).toBe(false);
    for (const k of FOREIGN_WRITE_ENV_KEYS) expect(READ_ENV_SURFACE.isForeign?.(k), k).toBe(true);
  });

  it("the full surface walks ENV_SPEC and treats nothing as foreign", () => {
    expect(FULL_ENV_SURFACE.spec).toBe(ENV_SPEC);
    expect(FULL_ENV_SURFACE.isForeign).toBeUndefined();
    expect(READ_ENV_SURFACE.spec).toBe(ENV_SPEC_READ);
  });

  it("no read entry is a secret signing or upload credential", () => {
    // The two read secrets authenticate READS (a dedicated gateway, the Graph gateway).
    const secrets = Object.entries(ENV_SPEC_READ)
      .filter(([, e]) => (e as { secret?: boolean }).secret)
      .map(([k]) => k)
      .sort();
    expect(secrets).toEqual(["DEXE_GRAPH_API_KEY", "DEXE_PINATA_GATEWAY_TOKEN"]);
  });
});
