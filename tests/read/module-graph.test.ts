import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { READ_TOOLS, WRITE_TOOLS } from "../../src/editions.js";
import { MODULE_CLASSES } from "../boundary/modules.js";
import { REPO, loadSrcTree, resolveIn, scanModule } from "../boundary/scan.js";

/**
 * A9 — the read edition never loads write code. Two proofs:
 *
 *   STATIC   walk every import (value and type, re-exports, literal dynamic
 *            imports) from the binary, src/read/bin.ts, with the boundary
 *            scanner: no write or root module, none of the modules that sign,
 *            connect a wallet, pin or register the write error remedies, and
 *            no package outside the read edition's dependency set.
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

/** Packages the read edition may import — what its own package.json will list. */
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

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const packageOf = (spec: string): string =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;

function staticReach(entry: string): { files: Set<string>; packages: Set<string> } {
  const tree = loadSrcTree();
  const files = new Set<string>([entry]);
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const from = queue.shift()!;
    for (const spec of scanModule(tree.get(from) ?? "").specifiers) {
      if (!spec.startsWith(".")) {
        if (!BUILTINS.has(spec)) packages.add(packageOf(spec));
        continue;
      }
      const to = resolveIn(tree, from, spec);
      if (to && tree.has(to) && !files.has(to)) {
        files.add(to);
        queue.push(to);
      }
    }
  }
  return { files, packages };
}

describe("read edition — static import graph from the binary", () => {
  const { files, packages } = staticReach(ENTRY);

  it("reaches the server, the HTTP entry and the read tools (the walk is not vacuous)", () => {
    for (const f of ["read/server.ts", "http/cli.ts", "http/server.ts", "tools/read.ts", "tools/report.ts", "lib/errors.ts"]) {
      expect(files.has(f), f).toBe(true);
    }
    expect(files.size).toBeGreaterThan(60);
  });

  it("reaches none of the modules that sign, connect a wallet, pin, persist reports or carry write remedies", () => {
    expect(FORBIDDEN.filter((f) => files.has(f))).toEqual([]);
  });

  it("reaches no module classified write or root", () => {
    const bad = [...files].filter((f) => {
      const c = MODULE_CLASSES.get(f);
      return c !== "read" && c !== "mixed";
    });
    expect(bad).toEqual([]);
  });

  it("imports only the read edition's packages", () => {
    expect([...packages].filter((p) => !READ_PACKAGES.has(p)).sort()).toEqual([]);
    for (const p of WRITE_PACKAGES) expect(packages.has(p), p).toBe(false);
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
    const dist = `${resolve(REPO, "dist").replace(/\\/g, "/").toLowerCase()}/`;
    const ours = loaded
      .filter((u) => u.startsWith("file:"))
      .map((u) => fileURLToPath(u).replace(/\\/g, "/"))
      // code only: the governor configs are bundled JSON data
      .filter((p) => p.toLowerCase().startsWith(dist) && p.endsWith(".js"))
      .map((p) => p.slice(dist.length).replace(/\.js$/, ".ts"));
    expect(ours.length, "the hook recorded nothing — is the loader hook working?").toBeGreaterThan(60);
    expect(ours).toContain("read/server.ts");
    expect(FORBIDDEN.filter((f) => ours.includes(f))).toEqual([]);
    const bad = ours.filter((f) => {
      const c = MODULE_CLASSES.get(f);
      return c !== "read" && c !== "mixed";
    });
    expect(bad).toEqual([]);
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
