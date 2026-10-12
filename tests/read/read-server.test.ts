import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A9 — `createReadServer` (src/read/server.ts) in process: what it registers
 * and publishes, that building and driving it never constructs a wallet or a
 * signer (with signing keys in the env), the snapshot-store rule, and the
 * per-request server pool the HTTP transport uses.
 */

const loaded = vi.hoisted(() => ({ signer: false, walletconnect: false, writeErrors: false, wallets: 0 }));

// A factory runs only if something imports the module: a flag that stays
// false proves the read server never loaded it.
vi.mock("../../src/lib/signer.js", () => {
  loaded.signer = true;
  return {};
});
vi.mock("../../src/lib/walletconnect.js", () => {
  loaded.walletconnect = true;
  return {};
});
vi.mock("../../src/lib/writeErrors.js", () => {
  loaded.writeErrors = true;
  return {};
});
// Count every Wallet constructed anywhere in the process.
vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class CountingWallet extends actual.Wallet {
    constructor(...args: ConstructorParameters<typeof actual.Wallet>) {
      loaded.wallets++;
      super(...args);
    }
  }
  return { ...actual, Wallet: CountingWallet };
});

const { loadReadConfig } = await import("../../src/configRead.js");
const { READ_TOOLS, WRITE_TOOLS } = await import("../../src/editions.js");
const { readInstructions } = await import("../../src/instructions.js");
const { READ_KNOWN_FAILURES } = await import("../../src/lib/errors.js");
const server = await import("../../src/read/server.js");
const { connectInMemory } = await import("../helpers/readEdition.js");

// Hardhat's well-known test account #1 — public, never funded on a real chain.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WRITE_ENV = {
  DEXE_PRIVATE_KEY: TEST_KEY,
  DEXE_AGENT_PK_1: TEST_KEY,
  AGENT_FUNDER_PK: TEST_KEY,
  DEXE_PINATA_JWT: "planted-jwt",
  DEXE_WALLETCONNECT_PROJECT_ID: "planted-wc",
  DEXE_SAFE_API_KEY: "planted-safe",
};

const namesWriteTool = (text: string): string[] => WRITE_TOOLS.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
const textOf = (res: unknown): string =>
  ((res as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

describe("createReadServer", () => {
  const saved: Record<string, string | undefined> = {};
  let published = "";
  let session: Awaited<ReturnType<typeof connectInMemory>>;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(WRITE_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const config = await loadReadConfig();
    session = await connectInMemory(server.createReadServer(config, { remote: false, version: "9.9.9" }));
  });

  afterAll(async () => {
    await session?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("identifies as dexe-mcp-read with the read handshake", () => {
    expect(session.client.getServerVersion()).toEqual({ name: "dexe-mcp-read", version: "9.9.9" });
    expect(session.client.getInstructions()).toBe(readInstructions());
    const caps = session.client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeUndefined();
  });

  it("registers exactly READ_TOOLS", async () => {
    const { tools } = await session.client.listTools();
    published += JSON.stringify(tools);
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it("publishes three read resources, rendered from read sources only", async () => {
    const { resources } = await session.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["dexe://graph-schema", "dexe://playbook", "dexe://tools"]);
    const read = async (uri: string) => {
      const res = await session.client.readResource({ uri });
      const text = res.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
      published += text;
      return text;
    };

    const catalog = await read("dexe://tools");
    const listed = [...catalog.matchAll(/^\| `(dexe_[a-z0-9_]+)` \|/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual([...READ_TOOLS].sort());

    const playbook = await read("dexe://playbook");
    // The READ failure table, explicitly: every read slug, no write-only one.
    for (const k of READ_KNOWN_FAILURES) expect(playbook).toContain(`\`${k.slug}\``);
    expect(playbook).not.toMatch(/`(gas-|nonce|pinata|wallet|insufficient-funds)/i);

    const graph = await read("dexe://graph-schema");
    expect(graph).toMatch(/pools|interactions/i);
  });

  it("nothing it publishes names a write tool", () => {
    expect(published.length).toBeGreaterThan(10_000);
    expect(namesWriteTool(published + (session.client.getInstructions() ?? ""))).toEqual([]);
  });

  it("orientation and diagnostics run, with signing keys in the env, without constructing a wallet or loading signer code", async () => {
    for (const name of ["dexe_context", "dexe_get_config", "dexe_guide", "dexe_list_gov_contract_types"]) {
      const res = await session.client.callTool({ name, arguments: {} });
      expect(res.isError, name).toBeFalsy();
      const text = textOf(res);
      expect(namesWriteTool(text), name).toEqual([]);
      for (const v of Object.values(WRITE_ENV)) expect(text, name).not.toContain(v.slice(2, 20));
    }
    expect(loaded.wallets).toBe(0);
    expect(loaded.signer).toBe(false);
    expect(loaded.walletconnect).toBe(false);
    expect(loaded.writeErrors).toBe(false);
  });

  it("dexe_context has no inputs and no recorded-DAO fields without a state store", async () => {
    const { tools } = await session.client.listTools();
    const ctx = tools.find((t) => t.name === "dexe_context")!;
    expect(Object.keys((ctx.inputSchema as { properties?: object }).properties ?? {})).toEqual([]);
    expect(ctx.description).not.toMatch(/recorded|user/);
  });
});

describe("report snapshots", () => {
  it("a remote server refuses a snapshot store; the binaries never pass one", async () => {
    const config = await loadReadConfig();
    const store = { get: () => null, put: () => undefined };
    expect(() => server.createReadServer(config, { remote: true, version: "0", reportStore: store })).toThrow(
      /keeps no report snapshots/,
    );
    // An embedding program may pass one locally: dexe_dao_report then publishes `persist`.
    const local = await connectInMemory(server.createReadServer(config, { remote: false, version: "0", reportStore: store }));
    try {
      const report = (await local.client.listTools()).tools.find((t) => t.name === "dexe_dao_report")!;
      expect((report.inputSchema as { properties: object }).properties).toHaveProperty("persist");
    } finally {
      await local.close();
    }
  });
});

describe("createReadServerFactory (the HTTP pool)", () => {
  it("builds one server up front, reuses released ones, and builds more only under concurrency", async () => {
    const config = await loadReadConfig();
    const f = server.createReadServerFactory(config, { remote: true, version: "0" });
    expect(f.built()).toBe(1);
    expect(f.toolNames()).toEqual([...READ_TOOLS].sort());
    const a = f.acquire();
    const b = f.acquire(); // `a` is still out: a second server
    expect(b).not.toBe(a);
    expect(f.built()).toBe(2);
    f.release(a);
    f.release(b);
    const c = f.acquire();
    expect([a, b]).toContain(c);
    expect(f.built()).toBe(2);
    f.release(c);
    f.release(c); // a second release of the same server is ignored
    const d = f.acquire();
    const e = f.acquire();
    expect(new Set([d, e]).size).toBe(2);
    expect(f.built()).toBe(2);
  });

  it("with reuse off, every request gets a new server", async () => {
    const config = await loadReadConfig();
    const f = server.createReadServerFactory(config, { remote: true, version: "0", reuse: false });
    const a = f.acquire();
    f.release(a);
    expect(f.acquire()).not.toBe(a);
  });

  it("a server comes back from the pool without the previous caller's initialize", async () => {
    const config = await loadReadConfig();
    const f = server.createReadServerFactory(config, { remote: true, version: "0" });
    const s = f.acquire();
    const first = await connectInMemory(s); // initialize from "test-client"
    expect(s.server.getClientVersion()?.name).toBe("test-client");
    await first.close();
    f.release(s);
    const again = f.acquire();
    expect(again).toBe(s);
    expect(again.server.getClientVersion()).toBeUndefined();
    expect(again.server.getClientCapabilities()).toBeUndefined();
    // …and serves the next caller on a fresh transport.
    const second = await connectInMemory(again);
    try {
      expect((await second.client.listTools()).tools).toHaveLength(READ_TOOLS.length);
    } finally {
      await second.close();
    }
  });

  it("every server lists the same tools from one cached tools/list answer", async () => {
    const config = await loadReadConfig();
    const kit = server.createReadServerKit(config, { remote: true, version: "0" });
    const one = await connectInMemory(server.createReadServerFromKit(kit));
    const two = await connectInMemory(server.createReadServerFromKit(kit));
    try {
      const l1 = await one.client.listTools();
      expect(kit.toolsList.result).toBeDefined();
      const l2 = await two.client.listTools();
      expect(JSON.stringify(l2)).toBe(JSON.stringify(l1));
    } finally {
      await one.close();
      await two.close();
    }
  });
});

describe("remote wording", () => {
  it("the remote playbook's remedies never ask the caller to edit .env", () => {
    const remote = server.renderReadPlaybook(server.REMOTE_KNOWN_FAILURES);
    expect(remote).not.toMatch(/\.env\b/);
    for (const k of server.REMOTE_KNOWN_FAILURES) expect(k.remedy, k.slug).not.toMatch(/\.env\b|restart/);
    // Same slugs, same order as the read table: only the wording differs.
    expect(server.REMOTE_KNOWN_FAILURES.map((k) => k.slug)).toEqual(READ_KNOWN_FAILURES.map((k) => k.slug));
  });
});
