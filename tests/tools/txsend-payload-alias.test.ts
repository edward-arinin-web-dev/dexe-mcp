import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { registerTxTools } from "../../src/tools/txSend.js";
import { forbiddenSelectors } from "../../src/lib/dangerousSelectors.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";

/**
 * Live regression, 2026-09-24: every `dexe_*_build_*` tool answers
 * `{ payload: { to, data, value, chainId, description } }`, and the natural
 * next call is `dexe_tx_send { payload }` — which the schema rejected with
 * `to: Required; data: Required`. The tool now accepts the builder's object
 * as `payload`; the flat fields still work and win when both are present.
 *
 * Proven through the denylist, which runs before any signer or RPC is touched:
 * a forbidden selector delivered ONLY inside `payload` must be refused — that
 * refusal is the evidence the payload's `to`/`data` were adopted.
 */

const TO = "0x1111111111111111111111111111111111111111";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function send(args: Record<string, unknown>): Promise<ToolResult> {
  const config = await loadConfig();
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  // Neither is reached: the denylist and the arity check come first.
  const signer = { hasSigner: () => false } as unknown as SignerManager;
  const wc = { isConfigured: () => false, isConnected: () => false } as unknown as WalletConnectManager;
  registerTxTools(server, config, signer, wc);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return (await client.callTool({ name: "dexe_tx_send", arguments: args })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

describe("dexe_tx_send accepts a builder payload object", () => {
  const forbidden = forbiddenSelectors()[0]!.selector;
  const drain = forbidden + "00".repeat(64);

  it("reads to/data from `payload` — the denylist sees the calldata delivered that way", async () => {
    const res = await send({ payload: { to: TO, data: drain, value: "0", chainId: 56, description: "x" } });
    expect(res.isError).toBe(true);
    const body = JSON.parse(text(res)) as { status: string; guard: string; selector: string };
    expect(body.status).toBe("rejected");
    expect(body.guard).toBe("denylist");
    expect(body.selector.toLowerCase()).toBe(forbidden.toLowerCase());
  });

  it("the flat fields still work on their own", async () => {
    const res = await send({ to: TO, data: drain, chainId: 56 });
    expect(res.isError).toBe(true);
    expect((JSON.parse(text(res)) as { guard: string }).guard).toBe("denylist");
  });

  it("with neither, the error names both ways in", async () => {
    const res = await send({});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("`to` + `data`");
    expect(text(res)).toContain("`payload`");
  });

  it("the schema itself no longer requires to/data (the call reaches the handler)", async () => {
    // A bare `payload` used to fail MCP input validation before the handler ran;
    // an MCP validation error is not the handler's arity message.
    const res = await send({ payload: { to: TO, data: drain } });
    expect(text(res)).not.toContain("Input validation error");
  });
});
