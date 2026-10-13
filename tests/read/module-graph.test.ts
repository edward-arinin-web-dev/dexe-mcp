import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { REPO, loadSrcTree, scanModule } from "../boundary/scan.js";

/**
 * A9 — the read edition never loads write code.
 *
 * `dexe-mcp-read` is the read edition's own binary: this package's bin entry,
 * src/read/bin.ts, is a shim that starts @dexe-network/dexe-mcp's. Two proofs:
 *
 *   STATIC   the shim imports no src/ module — only the read package's entry
 *            points — so no write module of this repo is reachable from it.
 *            (tests/boundary/import-boundary.test.ts holds every shim to that.)
 *   RUNTIME  start the BUILT binary under a loader hook that logs every module
 *            it loads, drive it through a session (tools, resources, calls) with
 *            a signing key in both its .env and its process env, and check what
 *            was actually loaded, what it printed and what it wrote.
 */

const ENTRY = "read/bin.ts";

/** Modules whose presence in the read process would mean write capability or write wording. */
const FORBIDDEN = [
  "lib/writeErrors.ts", // registers the write remedies on load
  "lib/signer.ts", // SignerManager, Wallet
  "lib/walletconnect.ts", // WalletConnectManager
  "lib/ipfsPin.ts", // Pinata uploads
  "lib/pinata.ts",
  "lib/agentLedger.ts",
  "lib/broadcastGuards.ts",
  "lib/reportStoreFile.ts", // reports.json on disk
  "lib/qr.ts",
  "config.ts", // the write config loader (constructs Wallets)
  "env/schema.ts",
  "tools/index.ts", // registerAll
  "index.ts",
  "bootstrap.ts",
  "hardhat.ts",
];

/** Packages the read edition may import — what its own package.json lists. */
const READ_PACKAGES = new Set(["@modelcontextprotocol/sdk", "ethers", "zod", "multiformats", "p-limit"]);
/** Packages only write code uses. */
const WRITE_PACKAGES = [
  "@walletconnect/universal-provider",
  "qrcode",
  "jpeg-js",
  "execa",
  "remark-gfm",
  "remark-parse",
  "remark-slate-transformer",
  "unified",
];

const READ_PACKAGE_ROOT = dirname(
  createRequire(join(REPO, "package.json")).resolve("@dexe-network/dexe-mcp/package.json"),
);

describe("read edition — static imports of the binary", () => {
  const specs = scanModule(loadSrcTree().get(ENTRY) ?? "").specifiers;

  it("the shim imports no src module, only the read edition's entry points", () => {
    expect(specs.length, `${ENTRY} is missing or imports nothing`).toBeGreaterThan(0);
    expect(specs.filter((s) => s.startsWith("."))).toEqual([]);
    expect(specs.filter((s) => !s.startsWith("@dexe-network/dexe-mcp/"))).toEqual([]);
  });

  it("the read package needs only the read edition's packages", () => {
    const pkg = JSON.parse(readFileSync(join(READ_PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => !READ_PACKAGES.has(d)).sort()).toEqual([]);
    for (const p of WRITE_PACKAGES) expect(deps, p).not.toContain(p);
  });
});

// ---------------------------------------------------------------------------

const BIN = resolve(REPO, "dist", "read", "bin.js");
const HOOK = pathToFileURL(resolve(REPO, "tests", "fixtures", "record-loads.mjs")).href;
// Hardhat's well-known test account #1 — public, never funded on a real chain.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DEXE_|AGENT_|SWARM_)/.test(k) || v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe.skipIf(!existsSync(BIN))("read edition — the built stdio binary at runtime", () => {
  let work: string;
  let home: string;
  let logFile: string;
  let stderr = "";
  const published: string[] = [];
  let tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let serverName: string | undefined;
  let configText = "";

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "dexe-read-bin-"));
    home = mkdtempSync(join(tmpdir(), "dexe-read-home-"));
    logFile = join(work, "loads.log");
    // The .env a user shares with the write edition: a read setting next to
    // signing and upload keys and a profile the read server does not have.
    writeFileSync(
      join(work, ".env"),
      `DEXE_RPC_URL_TESTNET=https://bsc-testnet.example.org\nDEXE_PRIVATE_KEY=${TEST_KEY}\n` +
        `DEXE_PINATA_JWT=planted-file-jwt\nDEXE_TOOLSETS=core\n`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", HOOK, BIN],
      cwd: work,
      env: cleanEnv({
        DEXE_TEST_LOAD_LOG: logFile,
        HOME: home,
        USERPROFILE: home,
        // planted by the MCP host: still dropped, never echoed
        DEXE_AGENT_PK_1: TEST_KEY,
        AGENT_FUNDER_PK: TEST_KEY,
        DEXE_WALLETCONNECT_PROJECT_ID: "planted-wc-project",
        DEXE_DISABLE_PUBLIC_RPC: "1",
      }),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d) => (stderr += d));
    const client = new Client({ name: "module-graph-test", version: "0" });
    await client.connect(transport);
    serverName = client.getServerVersion()?.name;
    published.push(client.getInstructions() ?? "");
    tools = (await client.listTools()).tools;
    published.push(JSON.stringify(tools));
    for (const r of (await client.listResources()).resources) {
      published.push(JSON.stringify(await client.readResource({ uri: r.uri })));
    }
    // Local calls (no network): orientation, config, guide, decode, CID parsing.
    const calls: Array<[string, Record<string, unknown>]> = [
      ["dexe_context", {}],
      ["dexe_get_config", {}],
      ["dexe_guide", {}],
      ["dexe_list_gov_contract_types", {}],
      ["dexe_ipfs_cid_info", { cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" }],
      ["dexe_decode_calldata", { data: "0xdeadbeef" }],
    ];
    for (const [name, args] of calls) {
      const res = await client.callTool({ name, arguments: args });
      const text = JSON.stringify(res);
      published.push(text);
      if (name === "dexe_get_config") configText = text;
    }
    await client.close();
  }, 60_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("identifies as dexe-mcp-read and lists exactly READ_TOOLS, each fully annotated and titled", () => {
    expect(serverName).toBe("dexe-mcp-read");
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(typeof t.annotations?.openWorldHint, t.name).toBe("boolean");
      expect(t.title?.trim(), t.name).toBeTruthy();
    }
  });

  it("loads no write module and no write-only package", () => {
    const loaded = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    const files = loaded
      .filter((u) => u.startsWith("file:"))
      .map((u) => fileURLToPath(u).replace(/\\/g, "/"))
      // code only: the governor configs are bundled JSON data
      .filter((p) => p.endsWith(".js"));
    const under = (root: string) => {
      const prefix = `${root.replace(/\\/g, "/").toLowerCase()}/`;
      return files.filter((p) => p.toLowerCase().startsWith(prefix)).map((p) => p.slice(prefix.length).replace(/\.js$/, ".ts"));
    };
    // This repo's own dist: the shim, and nothing else.
    expect(under(resolve(REPO, "dist"))).toEqual(["read/bin.ts"]);
    // The read edition's modules: its server, and none of the write edition's.
    const theirs = under(resolve(READ_PACKAGE_ROOT, "dist"));
    expect(theirs.length, "the hook recorded nothing — is the loader hook working?").toBeGreaterThan(60);
    expect(theirs).toContain("read/server.ts");
    expect(FORBIDDEN.filter((f) => theirs.includes(f))).toEqual([]);
    const pkgs = loaded.filter((u) => u.includes("/node_modules/"));
    for (const p of WRITE_PACKAGES) {
      expect(pkgs.filter((u) => u.includes(`/node_modules/${p}/`)), p).toEqual([]);
    }
  });

  it("publishes no write tool name: instructions, tools, resources, results", () => {
    const text = published.join("\n");
    const named = WRITE_TOOLS.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
    expect(named).toEqual([]);
  });

  it("loads the read settings from .env, drops the write ones, and never echoes a key or a signer", () => {
    // DEXE_RPC_URL_TESTNET from the .env took effect (public RPC is disabled).
    expect(configText).toContain("bsc-testnet.example.org");
    const all = `${published.join("\n")}\n${stderr}`.toLowerCase();
    for (const secret of [TEST_KEY.slice(2, 22), TEST_ADDR, "planted-file-jwt", "planted-wc-project"]) {
      expect(all, secret).not.toContain(secret.toLowerCase());
    }
    expect(stderr).not.toMatch(/signer|signing|walletconnect/i);
  });

  it("writes nothing under HOME", () => {
    expect(filesUnder(home)).toEqual([]);
  });
});
