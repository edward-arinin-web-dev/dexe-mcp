import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";

const root = resolve(__dirname, "..", "..");
const pluginDir = resolve(root, "dexe-plugin");
const writeBundle = resolve(pluginDir, "server/index.mjs");
const readBundle = resolve(pluginDir, "server/read/bin.mjs");
const dist = resolve(root, "dist/index.js");

async function connect(entry: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { DEXE_TOOLSETS: "full", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "bundle-smoke", version: "0" });
  await client.connect(transport);
  return client;
}

async function listTools(entry: string, env: Record<string, string> = {}) {
  const client = await connect(entry, env);
  try {
    return { tools: (await client.listTools()).tools, server: client.getServerVersion() };
  } finally {
    await client.close().catch(() => undefined);
  }
}

// The committed plugin bundles are what end users actually run, and nothing
// else loads them. A bundler change once left the server dying at import time
// ("Class2 is not a constructor") while every other test stayed green.
describe.skipIf(!existsSync(dist))("plugin bundles (dexe-plugin/server/)", () => {
  it("the write server starts over stdio and lists the same tools as dist/index.js — WRITE_TOOLS", async () => {
    const [fromBundle, fromDist] = await Promise.all([listTools(writeBundle), listTools(dist)]);
    const names = fromBundle.tools.map((t) => t.name).sort();
    expect(names).toEqual(fromDist.tools.map((t) => t.name).sort());
    expect(names).toEqual([...WRITE_TOOLS].sort());
    expect(fromBundle.server?.name).toBe("dexe-mcp");
  }, 60_000);

  it("the write server registers the read tools too with DEXE_WRITE_STANDALONE=1", async () => {
    const { tools } = await listTools(writeBundle, { DEXE_WRITE_STANDALONE: "1" });
    const names = new Set(tools.map((t) => t.name));
    for (const t of [...READ_TOOLS, ...WRITE_TOOLS]) expect(names.has(t), t).toBe(true);
  }, 60_000);

  it("the read server starts over stdio as dexe-mcp-read and lists exactly READ_TOOLS", async () => {
    const { tools, server } = await listTools(readBundle);
    expect(server?.name).toBe("dexe-mcp-read");
    // The read package's version (baked in by scripts/bundle-plugin.mjs), not dexe-mcp's.
    const readPkg = JSON.parse(
      readFileSync(resolve(root, "node_modules/@dexe-network/dexe-mcp/package.json"), "utf8"),
    ) as { version: string };
    expect(server?.version).toBe(readPkg.version);
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  }, 60_000);

  it("the read bundle carries no write code", () => {
    const text = readFileSync(readBundle, "utf8");
    // Names only the write edition registers or constructs.
    for (const marker of ["dexe_tx_send", "dexe_proposal_create", "WalletConnectManager", "SignerManager"]) {
      expect(text.includes(marker), marker).toBe(false);
    }
  });

  it("the plugin declares both servers, each launched with plain node from a file it ships", () => {
    const mcp = JSON.parse(readFileSync(resolve(pluginDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["dexe", "dexe-read"]);
    for (const [name, srv] of Object.entries(mcp.mcpServers)) {
      expect(srv.command, name).toBe("node");
      const file = srv.args[0]!.replace("${CLAUDE_PLUGIN_ROOT}", pluginDir);
      expect(existsSync(file), `${name}: ${file}`).toBe(true);
    }
  });
});
