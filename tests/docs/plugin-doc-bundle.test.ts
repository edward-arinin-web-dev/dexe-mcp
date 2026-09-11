import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error -- plain .mjs helper shared with scripts/bundle-plugin.mjs
import { rehostUpTreeLinks, repoBlobRoot } from "../../scripts/lib/doc-bundle.mjs";
import { DOC_RESOURCES } from "../../src/resources.js";

/**
 * `dexe-plugin/docs/` backs the dexe://playbook, dexe://graph-schema and
 * dexe://tools resources for every plugin user. Until 0.34.0 the bundler
 * copied three files out of a twenty-five-file tree, so eleven relative links
 * inside those three resources pointed at documents that were not there —
 * dead exactly where an agent follows them.
 *
 * The whole tree ships now, and this pins the bundle to the source: a hand-
 * edited or stale copy fails here instead of shipping.
 */
const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  repository?: { url?: string };
};
const blob = repoBlobRoot(pkg);

const sourceDocs = readdirSync(resolve(ROOT, "docs"))
  .filter((f) => f.endsWith(".md"))
  .sort();

const REMEDY =
  "run `npm run bundle:plugin` and commit dexe-plugin/docs/ — the plugin serves these files back as dexe://playbook, dexe://graph-schema and dexe://tools, so a stale copy ships wrong docs to every plugin user";

describe("plugin doc bundle", () => {
  it.each(sourceDocs)("dexe-plugin/docs/%s is the rehosted copy of docs/%s", (f) => {
    const bundled = resolve(ROOT, "dexe-plugin", "docs", f);
    expect(existsSync(bundled), `dexe-plugin/docs/${f} is missing — ${REMEDY}`).toBe(true);
    const want = rehostUpTreeLinks(readFileSync(resolve(ROOT, "docs", f), "utf8"), blob);
    expect(readFileSync(bundled, "utf8"), `dexe-plugin/docs/${f} is stale — ${REMEDY}`).toBe(want);
  });

  it("carries no doc that docs/ no longer has", () => {
    const bundled = readdirSync(resolve(ROOT, "dexe-plugin", "docs"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(bundled, `orphaned bundled docs — ${REMEDY}`).toEqual(sourceDocs);
  });

  it("every MCP doc resource has a file in the bundle", () => {
    for (const r of DOC_RESOURCES) {
      expect(
        existsSync(resolve(ROOT, "dexe-plugin", "docs", r.file)),
        `dexe://${r.name} is backed by docs/${r.file}, which is not in the plugin bundle`,
      ).toBe(true);
    }
  });

  it("rehosts up-tree links and leaves sibling links alone", () => {
    expect(rehostUpTreeLinks("see [x](../README.md)", "https://host/blob/main/")).toBe(
      "see [x](https://host/blob/main/README.md)",
    );
    expect(rehostUpTreeLinks("see [x](./TOOLS.md#anchor)", "https://host/blob/main/")).toBe(
      "see [x](./TOOLS.md#anchor)",
    );
  });
});
