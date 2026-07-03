import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { StateStore } from "../../src/lib/stateStore.js";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.DEXE_STATE_PATH;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function callContext(statePath: string) {
  process.env.DEXE_STATE_PATH = statePath;
  const config = await loadConfig();
  const server = new McpServer({ name: "ctx-test", version: "0.0.0" }, {});
  registerAll(server, config);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = (await client.callTool({ name: "dexe_context", arguments: { includeDepositedPower: false } })) as {
    content: { type: string; text: string }[];
  };
  const parsed = JSON.parse(res.content[0]!.text);
  await client.close();
  await server.close();
  return parsed;
}

describe("dexe_context persistence (Phase 3 acceptance)", () => {
  it("surfaces a DAO recorded in a prior session, without any lookup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");

    // "Session 1" — a deploy auto-records the DAO.
    new StateStore(statePath).recordDao({
      name: "Meridian Collective",
      govPool: "0xf113630C0000000000000000000000000000abcd",
      chainId: 97,
      token: "0xToken",
      txHash: "0xdeadbeef",
      deployedAt: "2026-07-04T00:00:00.000Z",
    });

    // "Session 2" — a fresh server + dexe_context reads it back.
    const ctx = await callContext(statePath);
    expect(ctx.knownDaos).toHaveLength(1);
    expect(ctx.knownDaos[0].name).toBe("Meridian Collective");
    expect(ctx.chain.lastUsedChainId).toBe(97);
    expect(ctx.signer.mode).toBe("readonly"); // no key in tests
    expect(ctx.env).toHaveProperty("toolsets");
    expect(ctx.hint).toContain("Meridian Collective");
  });

  it("reports an empty-but-valid context on a fresh install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dexe-ctx-"));
    dirs.push(dir);
    const ctx = await callContext(join(dir, "state.json"));
    expect(ctx.knownDaos).toEqual([]);
    expect(ctx.recentProposals).toEqual([]);
    expect(ctx.hint).toMatch(/No DAOs recorded/);
  });
});
