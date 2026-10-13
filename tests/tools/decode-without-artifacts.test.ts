import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Interface, type JsonRpcProvider } from "ethers";
import {
  Artifacts,
  bundledAbiSnapshot,
  registerGovTools,
  RpcProvider,
  SelectorIndex,
  type ToolContext,
} from "@dexe-network/dexe-mcp/core";
import { type GovToolOptions } from "@dexe-network/dexe-mcp/testing";
import { LOCAL_COMPILE_DECODE_HINT } from "../../src/tools/index.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * A10 — dexe_decode_calldata / dexe_decode_proposal on an install that never
 * cloned or compiled DeXe-Protocol (the zero-config path, and the remote read
 * server). They used to return "Hardhat artifacts not found … Run dexe_compile
 * first". They now decode against the bundled ABI snapshot, and a local compile
 * still takes over when it exists.
 *
 * Real calldata throughout: proposals 1 and 2 of a BSC mainnet DAO
 * (tests/fixtures/mainnet-proposals-otc.json) and the builders' golden output
 * (tests/fixtures/calldata-golden.json). Everything runs through a real MCP
 * client, so the declared output schemas are enforced too.
 */

const ROOT = process.cwd();
const mainnet = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/mainnet-proposals-otc.json"), "utf8")) as {
  govPool: string;
  proposals: Array<{
    proposalId: number;
    state: number;
    descriptionURL: string;
    actionsOnFor: Array<{ executor: string; value: string; data: string }>;
    actionsOnAgainst: Array<{ executor: string; value: string; data: string }>;
  }>;
};
const golden = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/calldata-golden.json"), "utf8")) as {
  external: Record<string, { actions: Array<{ data: string }> }>;
};

const GOVPOOL_IFACE = new Interface(bundledAbiSnapshot().get("GovPool")[0]!.abi as never);

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

let protocolPath: string;

beforeEach(() => {
  protocolPath = mkdtempSync(join(tmpdir(), "dexe-a10-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(protocolPath, { recursive: true, force: true });
});

/** A server whose DEXE_PROTOCOL_PATH is an empty directory: no clone, no compile. */
async function session(ctxOverride?: Partial<ToolContext>, govOpts?: GovToolOptions) {
  const config = {
    protocolPath,
    defaultChainId: 56,
    chains: new Map([[56, { chainId: 56, rpcUrl: "http://127.0.0.1:9/56", rpcUrls: ["http://127.0.0.1:9/56"] }]]),
    subgraphUrls: new Map(),
  } as unknown as DexeConfig;
  const artifacts = new Artifacts(config);
  const ctx = { config, artifacts, selectors: new SelectorIndex(artifacts), ...ctxOverride } as unknown as ToolContext;

  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerGovTools(server, ctx, govOpts);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

type Decoded = { contract: string | null; signature: string; privileged?: boolean; nested?: Decoded[] };

describe("dexe_decode_calldata with no compiled artifacts", () => {
  it("decodes a real mainnet TokenSaleProposal.createTiers action against the snapshot", async () => {
    const s = await session();
    const createTiers = mainnet.proposals[0]!.actionsOnFor[1]!;
    const res = await s.call("dexe_decode_calldata", { data: createTiers.data });
    await s.close();

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { matched: boolean; abiSource: string; primary: Decoded };
    expect(sc.matched).toBe(true);
    expect(sc.abiSource).toBe("snapshot");
    expect(sc.primary.contract).toBe("TokenSaleProposal");
    expect(sc.primary.signature).toMatch(/^createTiers\(/);
    expect(text(res)).toContain("Decoded with the bundled DeXe-Protocol ABI snapshot");
    expect(text(res)).not.toMatch(/dexe_compile|artifacts not found/i);
  });

  it("labels a bare ERC20 transfer as ERC20, with the DeXe token variants as alternatives", async () => {
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: golden.external.token_transfer!.actions[0]!.data });
    await s.close();

    const sc = res.structuredContent as { primary: Decoded; alternatives: Array<{ contract: string }> };
    expect(sc.primary.contract).toBe("ERC20");
    expect(sc.primary.signature).toBe("transfer(address,uint256)");
    expect(sc.alternatives.map((a) => a.contract)).toContain("ERC20Gov");
  });

  it("unwraps a GovPool.multicall and flags the hidden privileged call, snapshot only", async () => {
    const keeper = new Interface(bundledAbiSnapshot().get("GovUserKeeper")[0]!.abi as never);
    const inner = keeper.encodeFunctionData("withdrawTokens", [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      10n ** 18n,
    ]);
    const outer = GOVPOOL_IFACE.encodeFunctionData("multicall", [[inner]]);

    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: outer });
    await s.close();

    const sc = res.structuredContent as { primary: Decoded };
    expect(sc.primary.contract).toBe("GovPool");
    expect(sc.primary.nested?.[0]?.contract).toBe("GovUserKeeper");
    expect(sc.primary.nested?.[0]?.privileged).toBe(true);
    expect(text(res)).toContain("PRIVILEGED SELECTOR");
  });

  it("an unknown selector stays an actionable error that names no dev tool", async () => {
    // custom_abi's golden output: setX(uint256) on an arbitrary third-party target.
    const data = golden.external.custom_abi!.actions[0]!.data;
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data });
    await s.close();

    expect(res.isError).toBe(true);
    const t = text(res);
    expect(t).toContain(`No matching ABI found for selector ${data.slice(0, 10)}`);
    expect(t).toContain(bundledAbiSnapshot().protocol.commit.slice(0, 10));
    expect(t).toMatch(/verified ABI/);
    expect(t).toMatch(/4byte\.directory/);
    expect(t).not.toMatch(/dexe_compile|dexe_find_selector/);
  });

  it("an unknown `contract` name lists the contracts the snapshot does have", async () => {
    const s = await session();
    const res = await s.call("dexe_decode_calldata", {
      data: golden.external.token_transfer!.actions[0]!.data,
      contract: "NoSuchContract",
    });
    await s.close();

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No ABI named "NoSuchContract"');
    expect(text(res)).toContain("GovPool");
    expect(text(res)).toContain("TokenSaleProposal");
  });

  it("a known `contract` whose ABI lacks the selector says to drop the filter", async () => {
    const s = await session();
    const res = await s.call("dexe_decode_calldata", {
      data: golden.external.token_transfer!.actions[0]!.data,
      contract: "GovSettings",
    });
    await s.close();

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("in GovSettings");
    expect(text(res)).toContain("Omit `contract`");
  });
});

describe("dexe_decode_proposal with no compiled artifacts", () => {
  /** Answers GovPool.getProposals(offset, 1) with the recorded mainnet proposal. */
  function fakeChain() {
    const calls: string[] = [];
    const provider = {
      async call(tx: { data?: string | null }): Promise<string> {
        const parsed = GOVPOOL_IFACE.parseTransaction({ data: tx.data ?? "0x" });
        calls.push(parsed?.name ?? "?");
        if (parsed?.name !== "getProposals") throw new Error(`unexpected call ${parsed?.name}`);
        const p = mainnet.proposals[Number(parsed.args[0])]!;
        const settings = [true, false, false, 3600n, 3600n, 0n, 5n * 10n ** 26n, 0n, 0n, 0n, [`0x${"0".repeat(40)}`, 0n, 0n, 0n], ""];
        const core = [settings, 1n, 1n, p.state === 7, 10n ** 23n, 0n, 10n ** 23n, 0n, 0n];
        const asTuple = (a: { executor: string; value: string; data: string }) => [a.executor, BigInt(a.value), a.data];
        const proposal = [core, p.descriptionURL, p.actionsOnFor.map(asTuple), p.actionsOnAgainst.map(asTuple)];
        const validatorProposal = [[false, 0n, 0n, 0n, 0n, 0n, 0n]];
        return GOVPOOL_IFACE.encodeFunctionResult("getProposals", [[[proposal, validatorProposal, p.state, 5n * 10n ** 22n, 0n]]]);
      },
    };
    vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({ ok: provider as unknown as JsonRpcProvider });
    return calls;
  }

  it.each([1, 2])("decodes every action of mainnet proposal %i against the snapshot", async (proposalId) => {
    const calls = fakeChain();
    const s = await session();
    const res = await s.call("dexe_decode_proposal", { govPool: mainnet.govPool, proposalId });
    await s.close();

    expect(calls).toEqual(["getProposals"]);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      abiSource: string;
      stateName: string;
      forActions: Array<{ executor: string; decoded: Decoded | null }>;
    };
    expect(sc.abiSource).toBe("snapshot");
    expect(sc.stateName).toBe("ExecutedFor");
    expect(sc.forActions.map((a) => [a.decoded?.contract, a.decoded?.signature.split("(")[0]])).toEqual([
      ["ERC20", "approve"],
      ["TokenSaleProposal", "createTiers"],
    ]);
    expect(text(res)).not.toContain("(no matching ABI)");
    expect(text(res)).toContain("Decoded with the bundled DeXe-Protocol ABI snapshot");
  });
});

describe("a local compile still wins (dev flow unchanged)", () => {
  const MOCK_ABI = [
    {
      type: "function",
      name: "transfer",
      stateMutability: "nonpayable",
      inputs: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
  ];

  function writeArtifact() {
    const dir = join(protocolPath, "artifacts", "contracts", "LocalToken.sol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "LocalToken.json"),
      JSON.stringify({ contractName: "LocalToken", sourceName: "contracts/LocalToken.sol", abi: MOCK_ABI, bytecode: "0x60" }),
    );
  }

  it("decodes against the compiled artifacts when they exist, with no snapshot note", async () => {
    writeArtifact();
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: golden.external.token_transfer!.actions[0]!.data });
    await s.close();

    const sc = res.structuredContent as { abiSource: string; primary: Decoded; alternativeCount: number };
    expect(sc.abiSource).toBe("artifacts");
    expect(sc.primary.contract).toBe("LocalToken");
    expect(sc.alternativeCount).toBe(0);
    expect(text(res)).not.toContain("snapshot");
  });

  it("an unknown selector against local artifacts keeps the dev hint where the server has the dev tools", async () => {
    writeArtifact();
    const s = await session(undefined, { localCompileHint: LOCAL_COMPILE_DECODE_HINT });
    const res = await s.call("dexe_decode_calldata", { data: "0xdeadbeef" });
    await s.close();

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("No matching ABI found for selector 0xdeadbeef in the compiled artifacts");
    expect(text(res)).toContain("dexe_find_selector");

    // A server without the dev tools names none.
    const bare = await session();
    const res2 = await bare.call("dexe_decode_calldata", { data: "0xdeadbeef" });
    await bare.close();
    expect(text(res2)).toContain("No matching ABI found for selector 0xdeadbeef in the compiled artifacts");
    expect(text(res2)).not.toContain("dexe_find_selector");
  });

  it("is decided per call: a compile that lands mid-session takes over on the next call", async () => {
    const s = await session();
    const data = golden.external.token_transfer!.actions[0]!.data;
    const before = await s.call("dexe_decode_calldata", { data });
    writeArtifact();
    const after = await s.call("dexe_decode_calldata", { data });
    await s.close();

    expect((before.structuredContent as { abiSource: string }).abiSource).toBe("snapshot");
    expect((after.structuredContent as { abiSource: string }).abiSource).toBe("artifacts");
    expect((after.structuredContent as { primary: Decoded }).primary.contract).toBe("LocalToken");
  });
});

describe("an empty or partial local compile falls back to the snapshot", () => {
  /** What a failed or interrupted `npm run compile` can leave behind. */
  function emptyArtifactsDir() {
    mkdirSync(join(protocolPath, "artifacts", "contracts"), { recursive: true });
  }

  function writeLocal(name: string, abi: unknown[]) {
    const dir = join(protocolPath, "artifacts", "contracts", `${name}.sol`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: `contracts/${name}.sol`, abi, bytecode: "0x60" }),
    );
  }

  const MULTICALL_ONLY = [
    {
      type: "function",
      name: "multicall",
      stateMutability: "nonpayable",
      inputs: [{ name: "data", type: "bytes[]" }],
      outputs: [{ name: "results", type: "bytes[]" }],
    },
  ];

  it("an empty artifacts/contracts/ counts as no compile", async () => {
    emptyArtifactsDir();
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: golden.external.token_transfer!.actions[0]!.data });
    await s.close();

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { abiSource: string; primary: Decoded };
    expect(sc.abiSource).toBe("snapshot");
    expect(sc.primary.contract).toBe("ERC20");
    expect(text(res)).not.toMatch(/dexe_compile|dexe_find_selector/);
  });

  it("a selector the partial compile lacks is decoded by the snapshot, and says so", async () => {
    writeLocal("LocalPool", MULTICALL_ONLY);
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: mainnet.proposals[0]!.actionsOnFor[1]!.data });
    await s.close();

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { abiSource: string; primary: Decoded & { abiSource?: string } };
    expect(sc.abiSource).toBe("snapshot");
    expect(sc.primary.contract).toBe("TokenSaleProposal");
    expect(sc.primary.abiSource).toBe("snapshot");
    expect(text(res)).toContain("The local compile has no ABI for some of these calls");
  });

  it("a `contract` the partial compile lacks is looked up in the snapshot", async () => {
    writeLocal("LocalPool", MULTICALL_ONLY);
    const s = await session();
    const res = await s.call("dexe_decode_calldata", {
      data: mainnet.proposals[0]!.actionsOnFor[1]!.data,
      contract: "TokenSaleProposal",
    });
    await s.close();

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { primary: Decoded }).primary.contract).toBe("TokenSaleProposal");
  });

  it("nested calls fall back too: local wrapper, snapshot inner call → abiSource mixed", async () => {
    writeLocal("LocalPool", MULTICALL_ONLY);
    const keeper = new Interface(bundledAbiSnapshot().get("GovUserKeeper")[0]!.abi as never);
    const inner = keeper.encodeFunctionData("withdrawTokens", [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      1n,
    ]);
    const outer = GOVPOOL_IFACE.encodeFunctionData("multicall", [[inner]]);

    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: outer });
    await s.close();

    const sc = res.structuredContent as { abiSource: string; primary: Decoded & { abiSource?: string; nested?: Array<Decoded & { abiSource?: string }> } };
    expect(sc.abiSource).toBe("mixed");
    expect(sc.primary.contract).toBe("LocalPool");
    expect(sc.primary.abiSource).toBe("artifacts");
    expect(sc.primary.nested?.[0]?.contract).toBe("GovUserKeeper");
    expect(sc.primary.nested?.[0]?.abiSource).toBe("snapshot");
    expect(sc.primary.nested?.[0]?.privileged).toBe(true);
  });

  it("dexe_decode_proposal decodes every action through the snapshot when the compile lacks them", async () => {
    writeLocal("LocalPool", MULTICALL_ONLY);
    const p = mainnet.proposals[0]!;
    vi.spyOn(RpcProvider.prototype, "tryProvider").mockReturnValue({
      ok: {
        async call(): Promise<string> {
          const settings = [true, false, false, 1n, 1n, 0n, 1n, 0n, 0n, 0n, [`0x${"0".repeat(40)}`, 0n, 0n, 0n], ""];
          const core = [settings, 1n, 1n, true, 1n, 0n, 1n, 0n, 0n];
          const actions = p.actionsOnFor.map((a) => [a.executor, BigInt(a.value), a.data]);
          return GOVPOOL_IFACE.encodeFunctionResult("getProposals", [
            [[[core, p.descriptionURL, actions, []], [[false, 0n, 0n, 0n, 0n, 0n, 0n]], p.state, 1n, 0n]],
          ]);
        },
      } as unknown as JsonRpcProvider,
    });
    const s = await session();
    const res = await s.call("dexe_decode_proposal", { govPool: mainnet.govPool, proposalId: 1 });
    await s.close();

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { abiSource: string; forActions: Array<{ decoded: Decoded | null }> };
    expect(sc.abiSource).toBe("snapshot");
    expect(sc.forActions.map((a) => a.decoded?.contract)).toEqual(["ERC20", "TokenSaleProposal"]);
  });
});

describe("ambiguous selectors", () => {
  it("ERC20 vs ERC721 approve: same selector and types, different meaning → ambiguous", async () => {
    // The approve leg of mainnet proposal 1: an ERC20 allowance, but ERC721
    // reads the same bytes as approve(to, tokenId).
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: mainnet.proposals[0]!.actionsOnFor[0]!.data });
    await s.close();

    const sc = res.structuredContent as { ambiguous: boolean; primary: Decoded; alternatives: Array<{ contract: string }> };
    expect(sc.ambiguous).toBe(true);
    expect(sc.primary.contract).toBe("ERC20");
    expect(sc.alternatives.map((a) => a.contract)).toContain("ERC721");
    expect(text(res)).toContain("AMBIGUOUS");
    expect(text(res)).toContain("tokenId");
  });

  it("alternatives that read the arguments identically are not ambiguous", async () => {
    const s = await session();
    const res = await s.call("dexe_decode_calldata", { data: mainnet.proposals[0]!.actionsOnFor[1]!.data });
    await s.close();
    expect((res.structuredContent as { ambiguous: boolean }).ambiguous).toBe(false);
    expect(text(res)).not.toContain("AMBIGUOUS");
  });
});
