import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Interface } from "ethers";
import {
  bundledAbiSnapshot,
  CalldataDecoder,
  GET_PROPOSALS_FRAGMENT,
  SelectorIndex,
  type DecodedCall,
} from "@dexe-network/dexe-mcp/core";

/**
 * A10 — the decode tools fall back to a committed ABI-only snapshot of
 * DeXe-Protocol when no local compile exists. The snapshot is the read
 * edition's (@dexe-network/dexe-mcp): its shape, its generator and the
 * contracts its own tools ask for are pinned in that package's copy of this
 * file. What stays here is what this repo adds on top of it: the plugin bundle
 * carries the snapshot, every contract this repo's src/ asks for by name is in
 * it, the getProposals fragment the write flows decode with matches it, and
 * every proposal action this repo's builders emit decodes against it alone.
 */

const ROOT = process.cwd();
const snapshot = bundledAbiSnapshot();

describe("ABI snapshot vs. the write flows", () => {
  it("the GovPool getProposals ABI matches the hand-written fragment the live reads use", () => {
    const fromSnapshot = new Interface(snapshot.get("GovPool")[0]!.abi as never).getFunction("getProposals")!;
    const fragment = new Interface([GET_PROPOSALS_FRAGMENT]).getFunction("getProposals")!;
    expect(fromSnapshot.selector).toBe(fragment.selector);
    // Same return types, and the same field names inside the ProposalView tuple
    // (only the outer return value's own name differs: "proposals" vs unnamed).
    expect(fromSnapshot.outputs.map((o) => o.format("sighash"))).toEqual(
      fragment.outputs.map((o) => o.format("sighash")),
    );
    expect(fromSnapshot.outputs[0]!.arrayChildren!.format("full")).toBe(
      fragment.outputs[0]!.arrayChildren!.format("full"),
    );
  });
});

describe("ABI snapshot ships in the plugin bundle", () => {
  // esbuild inlines the read edition, snapshot included, into
  // dexe-plugin/server/index.mjs, so moving to a package version with a
  // regenerated snapshot without `npm run bundle:plugin` would leave plugin
  // users decoding against the previous one.
  const REMEDY = "run `npm run bundle:plugin` and commit dexe-plugin/server/index.mjs";
  const bundle = readFileSync(resolve(ROOT, "dexe-plugin", "server", "index.mjs"), "utf8");

  it("carries the snapshot's commit", () => {
    expect(bundle.includes(snapshot.protocol.commit), `snapshot commit missing — ${REMEDY}`).toBe(true);
  });

  it("carries every snapshot contract", () => {
    const missing = snapshot
      .list()
      .map((c) => c.sourceName)
      .filter((s) => !bundle.includes(JSON.stringify(s)));
    expect(missing, `snapshot contracts missing from the bundle — ${REMEDY}`).toEqual([]);
  });
});

// ---------- coverage ----------

function* walkTs(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkTs(full);
    else if (e.name.endsWith(".ts")) yield full;
  }
}

/**
 * Every contract name src/ asks an ABI source for by literal, e.g.
 * `ctx.artifacts.get("PoolFactory")`, `source.get("GovPool")`.
 */
function namesRequestedInSrc(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:artifacts|source|snapshot|snap|abis\.bundled\(\))\.(?:get|getOne)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
  for (const file of walkTs(resolve(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) out.set(m[1]!, file.slice(ROOT.length + 1));
  }
  return out;
}

describe("ABI snapshot covers every contract the decoders can request", () => {
  it("every contract name requested by literal in src/", () => {
    const requested = namesRequestedInSrc();
    // The scan must keep finding the known call sites, or it silently checks nothing.
    expect([...requested.keys()]).toEqual(expect.arrayContaining(["PoolFactory"]));
    for (const [name, file] of requested) {
      expect(snapshot.get(name).length, `${file} asks for "${name}", which the snapshot lacks`).toBe(1);
    }
  });

  // The dexe_list_gov_contract_types catalog and the helper/NFT contracts a
  // GovPool reports are the read edition's tool and data: pinned in its copy.

  // Every action the server's own proposal builders emit (pinned byte-for-byte
  // to the frontend in calldata-golden.json) must decode against the snapshot
  // alone. That is the set of proposal actions this server can create.
  type Golden = {
    external: Record<string, { actions?: Array<{ executor: string; data: string }> }>;
    internal: Record<string, { data?: string }>;
  };
  const golden = JSON.parse(
    readFileSync(resolve(ROOT, "tests/fixtures/calldata-golden.json"), "utf8"),
  ) as Golden;
  const decoder = new CalldataDecoder(snapshot, new SelectorIndex(snapshot));

  /** custom_abi encodes a caller-chosen `setX(uint256)` on an arbitrary target: unknown by design. */
  const ARBITRARY_TARGET = new Set(["custom_abi"]);

  const external = Object.entries(golden.external).flatMap(([type, f]) =>
    (f.actions ?? []).map((a, i) => [`${type}[${i}]`, type, a.data] as const),
  );
  const internal = Object.entries(golden.internal)
    .filter(([, f]) => f.data && f.data !== "0x")
    .map(([type, f]) => [`internal.${type}`, type, f.data!] as const);

  it("the golden set is non-trivial", () => {
    expect(external.length).toBeGreaterThan(25);
    expect(internal.length).toBeGreaterThanOrEqual(3);
  });

  const allDecoded = (c: DecodedCall): boolean => (c.nested ?? []).every(allDecoded);

  it.each([...external, ...internal])("%s decodes against the snapshot", (_label, type, data) => {
    const { primary } = decoder.decodeCalldata(data);
    if (ARBITRARY_TARGET.has(type)) {
      expect(primary).toBeNull();
      return;
    }
    expect(primary, `no snapshot ABI has selector ${data.slice(0, 10)}`).not.toBeNull();
    expect(primary!.selector).toBe(data.slice(0, 10));
    expect(allDecoded(primary!)).toBe(true);
  });
});
