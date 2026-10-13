import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createReadServer, loadReadConfig, type ReadServerOptions } from "@dexe-network/dexe-mcp";

/**
 * The READ edition as its binaries serve it: `createReadServer` from
 * @dexe-network/dexe-mcp (read config, the read toolset and annotation tables, the
 * read-result guard, no state store, no report snapshots, the read corpus, the
 * read doctor checks, no governor write half, the read resources).
 */
export interface ReadEditionListing {
  names: string[];
  tools: Tool[];
  instructions: string | undefined;
}

/** Connect a client to `server` over an in-memory pair. */
export async function connectInMemory(server: McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Boot the read edition over an in-memory transport and return what a host sees. */
export async function listReadEdition(
  opts: Partial<ReadServerOptions> = {},
): Promise<ReadEditionListing> {
  const config = await loadReadConfig();
  const server = createReadServer(config, { remote: false, version: "0.0.0", ...opts });
  const { client, close } = await connectInMemory(server);
  const res = await client.listTools();
  const instructions = client.getInstructions();
  await close();
  return { names: res.tools.map((t) => t.name).sort(), tools: res.tools, instructions };
}
