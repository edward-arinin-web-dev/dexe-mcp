import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(__dirname, "..", "..");
const bundle = resolve(root, "dexe-plugin/server/index.mjs");
const dist = resolve(root, "dist/index.js");

async function listTools(entry: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { DEXE_TOOLSETS: "full" },
    stderr: "ignore",
  });
  const client = new Client({ name: "bundle-smoke", version: "0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// The committed plugin bundle is what end users actually run, and nothing else
// loads it. A bundler change once left it dying at import time ("Class2 is not
// a constructor") while every other test stayed green.
describe.skipIf(!existsSync(dist))("plugin bundle (dexe-plugin/server/index.mjs)", () => {
  it("starts over stdio and lists the same tools as dist/index.js", async () => {
    const [fromBundle, fromDist] = await Promise.all([listTools(bundle), listTools(dist)]);
    expect(fromDist.length).toBeGreaterThan(100);
    expect(fromBundle.map((t) => t.name).sort()).toEqual(fromDist.map((t) => t.name).sort());
  }, 60_000);
});
