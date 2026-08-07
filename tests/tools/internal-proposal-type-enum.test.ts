import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Interface } from "ethers";
import {
  GOV_VALIDATORS_CREATE_ABI,
  registerProposalBuildTools,
} from "../../src/tools/proposalBuild.js";
import { registerProposalBuildInternalTools } from "../../src/tools/proposalBuildInternal.js";
import { INTERNAL_PROPOSAL_TYPE_LABELS } from "../../src/lib/proposalCatalog.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { DexeConfig } from "../../src/config.js";

/**
 * 0.30.3 defect 1 — `dexe_proposal_build_internal` documented the GovValidators
 * enum inverted (0=ChangeBalances, 1=ChangeSettings) in BOTH its description and
 * its receipt label array, while every other caller used the contract order
 * (0=ChangeSettings, 1=ChangeBalances). An agent reading the description picked
 * the wrong uint8, and the receipt then named the operation it thought it asked
 * for — so a validator-settings change silently became a balances change, on a
 * tool the default toolset profile loads.
 *
 * This is a regression of bug_validator_internal_enum_inverted. The two copies
 * of the label list are what let it come back, so the parity test below derives
 * BOTH sides from the running tools and compares them — no expected array is
 * written down here, and adding a third copy anywhere cannot pass silently.
 */

const VALIDATORS = "0x5555555555555555555555555555555555555555";
const USER = "0x6666666666666666666666666666666666666666";
const TOKEN = "0x7777777777777777777777777777777777777777";
const CID = "ipfs://QmInternalProposalMetadata";

const CREATE_INTERNAL = new Interface(GOV_VALIDATORS_CREATE_ABI as unknown as string[]);

function ctx(defaultChainId = 56): ToolContext {
  return {
    config: {
      defaultChainId,
      chainId: defaultChainId,
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

/** Live MCP client over both builder modules, so the real zod schemas run. */
async function connect(defaultChainId = 56) {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerProposalBuildTools(server, ctx(defaultChainId));
  registerProposalBuildInternalTools(server, ctx(defaultChainId));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as unknown as Promise<ToolResult>;
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { client, call, close };
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

/** Label the PRIMITIVE stamps on its receipt, per enum value 0..3. */
async function labelsFromPrimitive(
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<string[]> {
  const out: string[] = [];
  for (const proposalType of [0, 1, 2, 3]) {
    const res = await call("dexe_proposal_build_internal", {
      validators: VALIDATORS,
      proposalType,
      descriptionURL: CID,
    });
    expect(res.isError, `proposalType=${proposalType} must build`).toBeFalsy();
    const description = String(res.structuredContent?.description ?? "");
    const label = /createInternalProposal\(([^)]+)\)/.exec(description)?.[1];
    expect(label, `no label in "${description}"`).toBeTruthy();
    out.push(label!);
  }
  return out;
}

/**
 * Label each dedicated WRAPPER stamps, keyed by the enum value it chose. The
 * four wrappers cover the enum exactly once, so this reconstructs the whole
 * array from `proposalBuildInternal.ts` without importing its private copy.
 */
async function labelsFromWrappers(
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<string[]> {
  const wrappers: Array<[string, Record<string, unknown>]> = [
    ["dexe_proposal_build_change_validator_settings", { duration: "3600", executionDelay: "0", quorum: "1" }],
    ["dexe_proposal_build_change_validator_balances", { changes: [{ user: USER, balance: "1" }] }],
    ["dexe_proposal_build_monthly_withdraw", { withdrawals: [{ token: TOKEN, amount: "1" }], destination: USER }],
    ["dexe_proposal_build_offchain_internal_proposal", {}],
  ];
  const byType: string[] = [];
  for (const [name, args] of wrappers) {
    const res = await call(name, args);
    expect(res.isError, `${name} must build`).toBeFalsy();
    const proposalType = Number(res.structuredContent?.proposalType);
    const label = /proposalType=\d+ \(([^)]+)\)/.exec(text(res))?.[1];
    expect(label, `no label in ${name} output`).toBeTruthy();
    expect(byType[proposalType], `two wrappers claim type ${proposalType}`).toBeUndefined();
    byType[proposalType] = label!;
  }
  return byType;
}

describe("GovValidators internal proposal type enum is one truth", () => {
  it("dexe_proposal_build_internal labels each type exactly as proposalBuildInternal.ts does", async () => {
    const { call, close } = await connect();
    try {
      const primitive = await labelsFromPrimitive(call);
      const wrappers = await labelsFromWrappers(call);
      // Both sides derived from running code — the expected array is nowhere in
      // this test, so a future edit to either copy alone fails here.
      expect(primitive).toEqual(wrappers);
      expect(primitive).toEqual([...INTERNAL_PROPOSAL_TYPE_LABELS]);
    } finally {
      await close();
    }
  });

  it("pins 0=ChangeSettings / 1=ChangeBalances against the inversion that shipped", async () => {
    const { call, close } = await connect();
    try {
      const labels = await labelsFromPrimitive(call);
      expect(labels[0]).toBe("ChangeSettings");
      expect(labels[1]).toBe("ChangeBalances");
      expect(labels[0]).not.toBe("ChangeBalances");
      expect(labels[1]).not.toBe("ChangeSettings");
    } finally {
      await close();
    }
  });

  it("encodes the uint8 the caller asked for, unmapped", async () => {
    const { call, close } = await connect();
    try {
      for (const proposalType of [0, 1, 2, 3]) {
        const res = await call("dexe_proposal_build_internal", {
          validators: VALIDATORS,
          proposalType,
          descriptionURL: CID,
        });
        const decoded = CREATE_INTERNAL.decodeFunctionData(
          "createInternalProposal",
          String(res.structuredContent?.data),
        );
        expect(Number(decoded[0])).toBe(proposalType);
      }
    } finally {
      await close();
    }
  });

  it("describes the enum without the inverted mapping an agent would copy", async () => {
    const { client, call, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const description = tools.find((t) => t.name === "dexe_proposal_build_internal")!.description!;
      expect(description).toContain("0=ChangeSettings");
      expect(description).toContain("1=ChangeBalances");
      expect(description).toContain("2=MonthlyWithdraw");
      expect(description).toContain("3=OffchainProposal");
      // The exact strings that made the wrong value look right.
      expect(description).not.toContain("0=ChangeBalances");
      expect(description).not.toContain("1=ChangeSettings");
      expect(await labelsFromPrimitive(call)).toEqual([...INTERNAL_PROPOSAL_TYPE_LABELS]);
    } finally {
      await close();
    }
  });

  it("names every enum value in the schema, so the number is never guessed", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "dexe_proposal_build_internal")!.inputSchema;
      const field = JSON.stringify(
        (schema.properties as Record<string, unknown>).proposalType,
      );
      for (const [i, label] of INTERNAL_PROPOSAL_TYPE_LABELS.entries()) {
        expect(field, `schema must name ${i}=${label}`).toContain(`${i}=${label}`);
      }
      // A bare min/max range carries no naming — that is what let 0 and 1 swap.
      expect(field).not.toMatch(/"minimum"\s*:\s*0\s*,\s*"maximum"\s*:\s*3/);
    } finally {
      await close();
    }
  });

  it("rejects an out-of-enum proposalType instead of building an unnamed one", async () => {
    const { call, close } = await connect();
    try {
      const res = await call("dexe_proposal_build_internal", {
        validators: VALIDATORS,
        proposalType: 4,
        descriptionURL: CID,
      });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
