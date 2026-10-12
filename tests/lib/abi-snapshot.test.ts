import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Interface } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROTOCOL_ABI_SNAPSHOT_JSON } from "../../src/abi/protocolSnapshot.generated.js";
import { AbiSnapshot, bundledAbiSnapshot, protocolAbiSnapshotData } from "../../src/lib/abiSnapshot.js";
import { CalldataDecoder, type DecodedCall } from "../../src/lib/decoders.js";
import { SelectorIndex } from "../../src/lib/selectors.js";
import { GET_PROPOSALS_FRAGMENT } from "../../src/lib/govProposalView.js";
import { registerGovTools } from "../../src/tools/gov.js";
import type { ToolContext } from "../../src/tools/context.js";

/**
 * A10 — the decode tools fall back to a committed ABI-only snapshot of
 * DeXe-Protocol (src/abi/protocolSnapshot.generated.ts, written by
 * scripts/gen-abi-snapshot.ts) when no local compile exists. These tests pin
 * that the snapshot is well-formed and covers every contract the decoders can
 * be asked for: by name in src/, in the gov catalog tool, and by selector for
 * every proposal action the server's own builders emit.
 */

const ROOT = process.cwd();
const PROTOCOL_ABI_SNAPSHOT = protocolAbiSnapshotData();
const snapshot = new AbiSnapshot();

describe("ABI snapshot is well-formed", () => {
  it("records where it came from", () => {
    const p = PROTOCOL_ABI_SNAPSHOT.protocol;
    expect(p.repository).toBe("https://github.com/dexe-network/DeXe-Protocol");
    expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.solcVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.openzeppelinContracts).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("holds ABIs only: contractName, sourceName and abi, no bytecode", () => {
    expect(PROTOCOL_ABI_SNAPSHOT.contracts.length).toBeGreaterThan(20);
    for (const c of PROTOCOL_ABI_SNAPSHOT.contracts) {
      expect(Object.keys(c).sort()).toEqual(["abi", "contractName", "sourceName"]);
      expect(c.contractName).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(c.sourceName).toMatch(/\.sol$/);
      expect(Array.isArray(c.abi) && c.abi.length > 0, `${c.contractName} has an empty ABI`).toBe(true);
    }
    // No artifact field beyond the ABI leaked in as a key.
    expect(PROTOCOL_ABI_SNAPSHOT_JSON).not.toMatch(
      /"(?:bytecode|deployedBytecode|linkReferences|deployedLinkReferences|metadata|devdoc|userdoc)"\s*:/,
    );
    expect(protocolAbiSnapshotData()).toBe(PROTOCOL_ABI_SNAPSHOT); // parsed once
  });

  it("has no mocks, and one entry per source:contract", () => {
    const keys = PROTOCOL_ABI_SNAPSHOT.contracts.map((c) => `${c.sourceName}:${c.contractName}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.startsWith("contracts/mock/"))).toEqual([]);
    expect(keys.filter((k) => k.startsWith("contracts/libs/"))).toEqual([]);
  });

  it("is in code-point order, as the generator writes it (no ICU-dependent diffs)", () => {
    const keys = PROTOCOL_ABI_SNAPSHOT.contracts.map((c) => [c.sourceName, c.contractName] as const);
    const sorted = [...keys].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
    expect(keys).toEqual(sorted);
  });

  it.each(PROTOCOL_ABI_SNAPSHOT.contracts.map((c) => [c.contractName, c] as const))(
    "%s parses as an ethers Interface with at least one function",
    (_name, c) => {
      const iface = new Interface(c.abi as never);
      let fns = 0;
      iface.forEachFunction(() => fns++);
      expect(fns).toBeGreaterThan(0);
    },
  );

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

  it("bundledAbiSnapshot() is one shared instance with a stable list (SelectorIndex builds once)", () => {
    const a = bundledAbiSnapshot();
    expect(bundledAbiSnapshot()).toBe(a);
    expect(a.list()).toBe(a.list());
  });
});

describe("ABI snapshot ships in the plugin bundle", () => {
  // esbuild inlines the snapshot module into dexe-plugin/server/index.mjs, so a
  // regenerated snapshot without `npm run bundle:plugin` would leave plugin
  // users decoding against the previous one.
  const REMEDY = "run `npm run bundle:plugin` and commit dexe-plugin/server/index.mjs";
  const bundle = readFileSync(resolve(ROOT, "dexe-plugin", "server", "index.mjs"), "utf8");

  it("carries the snapshot's commit", () => {
    expect(bundle.includes(PROTOCOL_ABI_SNAPSHOT.protocol.commit), `snapshot commit missing — ${REMEDY}`).toBe(true);
  });

  it("carries every snapshot contract", () => {
    const missing = PROTOCOL_ABI_SNAPSHOT.contracts
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
    if (file.endsWith("protocolSnapshot.generated.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) out.set(m[1]!, file.slice(ROOT.length + 1));
  }
  return out;
}

describe("ABI snapshot covers every contract the decoders can request", () => {
  it("every contract name requested by literal in src/", () => {
    const requested = namesRequestedInSrc();
    // The scan must keep finding the known call sites, or it silently checks nothing.
    expect([...requested.keys()]).toEqual(expect.arrayContaining(["GovPool", "PoolFactory"]));
    for (const [name, file] of requested) {
      expect(snapshot.get(name).length, `${file} asks for "${name}", which the snapshot lacks`).toBe(1);
    }
  });

  it("every contract in the dexe_list_gov_contract_types catalog", async () => {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<unknown>) =>
        tools.set(name, h),
    } as unknown as McpServer;
    registerGovTools(server, {
      config: { defaultChainId: 56, chains: new Map() },
      artifacts: {},
      selectors: {},
    } as unknown as ToolContext);
    const res = (await tools.get("dexe_list_gov_contract_types")!({})) as {
      structuredContent: { contracts: Array<{ name: string; sourcePath: string }> };
    };
    const catalog = res.structuredContent.contracts;
    expect(catalog.length).toBeGreaterThan(5);
    for (const c of catalog) {
      const hit = snapshot.get(c.name);
      expect(hit.length, `catalog lists ${c.name}, which the snapshot lacks`).toBe(1);
      expect(hit[0]!.sourceName).toBe(c.sourcePath);
    }
  });

  it("the helper and NFT contracts a GovPool reports (getHelperContracts / getNftContracts)", () => {
    // settings, userKeeper, validators, poolRegistry, votePower;
    // nftMultiplier, expertNft, dexeExpertNft, babt.
    for (const name of [
      "GovSettings",
      "GovUserKeeper",
      "GovValidators",
      "PoolRegistry",
      "LinearPower",
      "PolynomialPower",
      "ERC721Multiplier",
      "DexeERC721Multiplier",
      "ERC721Expert",
      "ISBT721",
    ]) {
      expect(snapshot.get(name).length, name).toBe(1);
    }
  });

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
