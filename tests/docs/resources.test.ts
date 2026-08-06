import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDocResources, DOC_RESOURCES } from "../../src/resources.js";

/**
 * The shipped docs must be reachable in-band as MCP resources — a fresh AI
 * connected to the server has no other way to discover the subgraph schema or
 * the full tool catalog. Backing-file presence in the tarball is guarded
 * separately by pack-contents.test.ts.
 */

async function connect(baseDir: string): Promise<{ server: McpServer; client: Client }> {
  const server = new McpServer({ name: "dexe-mcp-test", version: "0.0.0" }, {});
  registerDocResources(server, baseDir);
  // A server with zero registered resources does not advertise the resources
  // capability, and listResources() would reject — register a probe so the
  // empty-baseDir case can still be exercised through the protocol.
  server.resource("probe", "dexe://probe", async () => ({
    contents: [{ uri: "dexe://probe", mimeType: "text/plain", text: "probe" }],
  }));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

describe("doc resources (repo layout)", () => {
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
    ({ server, client } = await connect(process.cwd()));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("lists all three doc resources with descriptions", async () => {
    const res = await client.listResources();
    const byUri = new Map(res.resources.map((r) => [r.uri, r]));
    for (const doc of DOC_RESOURCES) {
      const entry = byUri.get(doc.uri);
      expect(entry, `${doc.uri} missing from listResources`).toBeDefined();
      expect(entry!.description).toBe(doc.description);
      expect(entry!.mimeType).toBe("text/markdown");
    }
  });

  it("dexe://graph-schema serves the subgraph entity reference", async () => {
    const res = await client.readResource({ uri: "dexe://graph-schema" });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain("DaoPool");
    expect(text).toMatch(/first:/);
  });

  it("dexe://tools serves the tool catalog", async () => {
    const res = await client.readResource({ uri: "dexe://tools" });
    const text = (res.contents[0] as { text: string }).text;
    expect(text).toContain("dexe_graph_query");
  });

  it("dexe://playbook still serves the playbook (regression guard for the refactor)", async () => {
    const res = await client.readResource({ uri: "dexe://playbook" });
    const text = (res.contents[0] as { text: string }).text;
    expect(text.length).toBeGreaterThan(1000);
  });
});

describe("doc resources (partial install)", () => {
  it("a baseDir without docs registers nothing and does not throw", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dexe-resources-empty-"));
    try {
      const { server, client } = await connect(empty);
      const res = await client.listResources();
      expect(res.resources.map((r) => r.uri)).toEqual(["dexe://probe"]);
      await client.close();
      await server.close();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
