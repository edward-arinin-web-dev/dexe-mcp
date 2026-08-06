import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDegradedServer, nodeVersionWarning } from "../src/index.js";

/**
 * 0.30.1 "never die". Two ways the server used to disappear without a word:
 *   1. Node < 20.12.0 has no process.loadEnvFile(), so .env was skipped in
 *      silence and every DEXE_* var looked unset.
 *   2. A throw during startup killed the process, which an MCP host renders as
 *      "server disconnected" — no cause, and `npx dexe-mcp doctor` just as dead.
 * Both must now produce an explanation the user can actually read.
 */

/** Boot the degraded server over a linked in-memory pair (see tests/tools/gate.test.ts). */
async function bootDegraded(err: unknown, envFiles: string[] = []) {
  const server = createDegradedServer(err, envFiles);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  // client.connect resolves only after the initialize handshake succeeds.
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map(c => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

describe("nodeVersionWarning (Node engine floor)", () => {
  it("flags 20.9.0, which a string compare would call newer than 20.12.0", () => {
    const msg = nodeVersionWarning("20.9.0");
    expect(msg).not.toBeNull();
    expect("20.9.0" > "20.12.0").toBe(true); // the trap this guard exists for
  });

  it("flags every pre-20.12 release, where .env is silently ignored", () => {
    expect(nodeVersionWarning("20.0.0")).not.toBeNull();
    expect(nodeVersionWarning("20.11.1")).not.toBeNull();
    expect(nodeVersionWarning("18.20.4")).not.toBeNull();
  });

  it("passes 20.12.0 and every newer runtime", () => {
    expect(nodeVersionWarning("20.12.0")).toBeNull();
    expect(nodeVersionWarning("20.19.2")).toBeNull();
    expect(nodeVersionWarning("21.0.0")).toBeNull();
    expect(nodeVersionWarning("22.14.0")).toBeNull();
    expect(nodeVersionWarning("24.1.0-nightly20260101")).toBeNull();
  });

  it("names the running version, the required version, and the consequence", () => {
    const msg = nodeVersionWarning("20.9.0") ?? "";
    expect(msg).toContain("20.9.0");
    expect(msg).toContain("20.12.0");
    expect(msg).toContain(".env files are ignored on this runtime");
    expect(msg).toContain("MCP host env block");
  });

  it("stays quiet on a version string it cannot parse", () => {
    expect(nodeVersionWarning("")).toBeNull();
    expect(nodeVersionWarning("who-knows")).toBeNull();
  });
});

describe("degraded server (startup failure stays reachable)", () => {
  it("skips bootstrap on import, so the test worker keeps its own stdio", () => {
    // src/index.ts boots only when it IS the entrypoint. Under Vitest argv[1]
    // is the runner, not src/index.ts, so importing the module is inert. The
    // gate deliberately does NOT key on an env var: that switch would ship
    // inside dist/index.js and could silently disable the published binary.
    expect(process.argv[1] ?? "").not.toMatch(/src[\\/]index\.ts$/);
  });

  it("completes the MCP handshake and exposes only dexe_doctor", async () => {
    const { server, client } = await bootDegraded(new Error("DEXE_SIGNER_MAX_VALUE_WEI is not a number"));
    expect(client.getServerVersion()?.name).toBe("dexe-mcp");
    expect(client.getInstructions() ?? "").toContain("dexe_doctor");

    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(["dexe_doctor"]);

    await client.close();
    await server.close();
  });

  it("dexe_doctor returns the startup error plus the remediation", async () => {
    const { server, client } = await bootDegraded(new Error("DEXE_SIGNER_MAX_VALUE_WEI is not a number"), [
      "/home/u/.dexe-mcp/.env",
    ]);
    const res = await client.callTool({ name: "dexe_doctor", arguments: {} });
    const text = firstText(res);

    expect(text).toContain("DEXE_SIGNER_MAX_VALUE_WEI is not a number"); // the cause
    expect(text).toContain("npx dexe-mcp doctor"); // the fix
    expect(text).toContain("/home/u/.dexe-mcp/.env"); // where to fix it
    expect(text).toContain("Restart"); // when it takes effect
    expect(text).toContain("20.12.0"); // the runtime floor
    expect((res as { isError?: boolean }).isError).not.toBe(true);

    await client.close();
    await server.close();
  });

  it("reports a non-Error throw instead of printing [object Object]", async () => {
    const { server, client } = await bootDegraded("config.json is unreadable");
    const text = firstText(await client.callTool({ name: "dexe_doctor", arguments: {} }));
    expect(text).toContain("config.json is unreadable");

    await client.close();
    await server.close();
  });
});
