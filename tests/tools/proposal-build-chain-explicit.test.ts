import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerProposalBuildTools } from "../../src/tools/proposalBuild.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.30.3 — the proposal primitives stamped `ctx.config.chainId` into every
 * payload with no way to say which chain was meant. A caller building against a
 * testnet DAO on a mainnet-default install got a payload labelled 56; whatever
 * broadcasts it then signs for the wrong chain. The envelope's `chainId` is the
 * only field that may move — the calldata bytes are chain-independent and must
 * be byte-identical however the chain is chosen.
 */

const GOV_POOL = "0x8888888888888888888888888888888888888888";
const VALIDATORS = "0x9999999999999999999999999999999999999999";
const CID = "ipfs://QmProposalMetadata";

function ctx(defaultChainId: number): ToolContext {
  return {
    config: {
      defaultChainId,
      // The stale back-compat alias the builders used to read. Deliberately
      // disagrees with defaultChainId so a reader of the wrong field is caught.
      chainId: 1,
      treasuryGuard: "off",
      rpcUrl: undefined,
      chains: new Map(),
    } as unknown as DexeConfig,
  } as unknown as ToolContext;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

async function connect(defaultChainId: number) {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalBuildTools(server, ctx(defaultChainId));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as unknown as Promise<ToolResult>;
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { call, close };
}

const EXTERNAL_ARGS = { govPool: GOV_POOL, descriptionURL: CID, actionsOnFor: [] };
const INTERNAL_ARGS = { validators: VALIDATORS, proposalType: 0, descriptionURL: CID };

const CASES: Array<[string, Record<string, unknown>]> = [
  ["dexe_proposal_build_external", EXTERNAL_ARGS],
  ["dexe_proposal_build_external", { ...EXTERNAL_ARGS, andVote: true, voteAmount: "1000" }],
  ["dexe_proposal_build_internal", INTERNAL_ARGS],
];

describe.each(CASES)("%s honours an explicit chainId (%#)", (tool, args) => {
  it("stamps the requested chain, not the install default", async () => {
    const { call, close } = await connect(56);
    try {
      const res = await call(tool, { ...args, chainId: 97 });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.chainId).toBe(97);
    } finally {
      await close();
    }
  });

  it("falls back to the default chain when chainId is omitted", async () => {
    const { call, close } = await connect(97);
    try {
      const res = await call(tool, args);
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.chainId).toBe(97);
      // Never the stale `config.chainId` alias (1 in this fixture).
      expect(res.structuredContent?.chainId).not.toBe(1);
    } finally {
      await close();
    }
  });

  it("changes only the envelope — calldata, to and value are byte-identical", async () => {
    const { call, close } = await connect(56);
    try {
      const [omitted, mainnet, testnet] = await Promise.all([
        call(tool, args),
        call(tool, { ...args, chainId: 56 }),
        call(tool, { ...args, chainId: 97 }),
      ]);
      const bytes = (r: ToolResult) => ({
        to: r.structuredContent?.to,
        data: r.structuredContent?.data,
        value: r.structuredContent?.value,
      });
      expect(bytes(mainnet)).toEqual(bytes(omitted));
      expect(bytes(testnet)).toEqual(bytes(omitted));
      expect(String(bytes(omitted).data)).toMatch(/^0x[0-9a-f]{8,}$/);
    } finally {
      await close();
    }
  });
});

describe("proposal builders advertise the chain switch", () => {
  it("both primitives accept chainId in their published schema", async () => {
    const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
    registerProposalBuildTools(server, ctx(56));
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const { tools } = await client.listTools();
      for (const name of ["dexe_proposal_build_external", "dexe_proposal_build_internal"]) {
        const props = tools.find((t) => t.name === name)!.inputSchema.properties as Record<
          string,
          unknown
        >;
        expect(props.chainId, `${name} must take chainId`).toBeDefined();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
