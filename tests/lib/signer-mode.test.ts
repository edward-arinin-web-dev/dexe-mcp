import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import {
  DEFAULT_UNATTENDED_CHAINS,
  parseUnattendedChains,
  resolveSignerMode,
  signerDispatch,
  unattendedChainFence,
} from "../../src/lib/signerMode.js";
import { SignerManager, SignerModeRefusal, NoSignerKeyError } from "../../src/lib/signer.js";
import { loadConfig, type DexeConfig } from "../../src/config.js";
import { encryptPrivateKey, writeKeystoreFile } from "../../src/lib/keystore.js";
import { signerModeChecks } from "../../src/diag/writeChecks.js";

/**
 * 2c — one signer-mode resolver and the unattended chain fence. Since 1.0.0
 * an unset mode never signs with a hot key (0.37 signed unattended then); only
 * an EXPLICIT unattended mode reads hot keys, fenced to 97 by default.
 */
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDR = new Wallet(PK).address;

describe("resolveSignerMode", () => {
  const cases: Array<[string | undefined, string, string]> = [
    [undefined, "walletconnect", "default"],
    ["", "walletconnect", "default"],
    ["unattended", "unattended", "explicit"],
    ["UNATTENDED", "unattended", "explicit"],
    ["keystore", "keystore", "explicit"],
    ["walletconnect", "walletconnect", "explicit"],
    [" readonly ", "readonly", "explicit"],
  ];
  for (const [requested, mode, source] of cases) {
    it(`${JSON.stringify(requested)} → ${mode} (${source})`, () => {
      expect(resolveSignerMode({ requested, walletConnectConfigured: true })).toEqual({ mode, source });
    });
  }

  it("a typo never widens to unattended", () => {
    const r = resolveSignerMode({ requested: "keysotre", walletConnectConfigured: true });
    expect(r.mode).toBe("walletconnect");
    expect(r.invalid).toBe("keysotre");
  });

  it("no WalletConnect project → readonly default", () => {
    expect(resolveSignerMode({ walletConnectConfigured: false }).mode).toBe("readonly");
  });

  it("dispatch keeps the pre-0.37 labels", () => {
    expect(signerDispatch("unattended", true, undefined)).toBe("eoa");
    expect(signerDispatch("unattended", true, "https://safe")).toBe("safe");
    expect(signerDispatch("keystore", true, undefined)).toBe("keystore");
    expect(signerDispatch("keystore", false, undefined)).toBe("readonly");
    expect(signerDispatch("walletconnect", false, undefined)).toBe("walletconnect");
  });
});

describe("unattended chain fence", () => {
  it("parses DEXE_UNATTENDED_CHAINS", () => {
    expect(parseUnattendedChains(undefined)).toBeNull();
    expect(parseUnattendedChains(" ")).toBeNull();
    expect(parseUnattendedChains("97")).toEqual([97]);
    expect(parseUnattendedChains("97, 56,97")).toEqual([97, 56]);
    expect(parseUnattendedChains("97,abc")).toEqual({ invalid: "abc" });
  });

  it("defaults to testnet only, never to no fence", () => {
    expect(DEFAULT_UNATTENDED_CHAINS).toEqual([97]);
    expect(unattendedChainFence(null)).toEqual([97]);
    expect(unattendedChainFence([97, 56])).toEqual([97, 56]);
  });
});

function cfg(over: Partial<DexeConfig>): DexeConfig {
  return {
    chains: new Map([
      [97, { chainId: 97, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"] }],
      [56, { chainId: 56, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"] }],
    ]),
    defaultChainId: 97,
    agentKeys: {},
    ...over,
  } as unknown as DexeConfig;
}

describe("SignerManager per mode", () => {
  it("unattended + fence: signs on 97, refuses 56 with a remedy", () => {
    const s = new SignerManager(cfg({ privateKey: PK, signerMode: "unattended", signerModeSource: "explicit", unattendedChains: [97] }));
    expect(s.requireSigner(97).address).toBe(ADDR);
    expect(() => s.requireSigner(56)).toThrow(SignerModeRefusal);
    const t = s.trySigner(56);
    expect("error" in t && t.remediation).toMatch(/DEXE_UNATTENDED_CHAINS=97,56/);
  });

  it("the fence covers message signatures too (backend login is a chain-56 act)", async () => {
    const fenced = new SignerManager(cfg({ privateKey: PK, signerMode: "unattended", signerModeSource: "explicit", unattendedChains: [97] }));
    await expect(fenced.signMessage("login", undefined, 56)).rejects.toThrow(SignerModeRefusal);
    await expect(fenced.signMessage("login")).rejects.toThrow(/unspecified chain/);
    const wide = new SignerManager(cfg({ privateKey: PK, signerMode: "unattended", signerModeSource: "explicit", unattendedChains: [97, 56] }));
    expect(await wide.signMessage("login", undefined, 56)).toMatch(/^0x[0-9a-f]{130}$/);
    const inCode = new SignerManager(cfg({ privateKey: PK }));
    expect(await inCode.signMessage("login", undefined, 56)).toMatch(/^0x/);
  });

  it("a config built in code with a key and no mode: the caller chose unattended, unfenced", () => {
    const s = new SignerManager(cfg({ privateKey: PK }));
    expect(s.mode).toBe("unattended");
    expect(s.modeSource).toBe("explicit");
    expect(s.unattendedChains).toBeNull();
    expect(s.requireSigner(56).address).toBe(ADDR);
    const none = new SignerManager(cfg({}));
    expect(none.mode).toBe("walletconnect");
    expect(none.modeSource).toBe("default");
  });

  it("walletconnect / readonly modes ignore a configured hot key", () => {
    for (const mode of ["walletconnect", "readonly"] as const) {
      const s = new SignerManager(cfg({ privateKey: PK, agentKeys: { agent1: PK }, signerMode: mode }));
      expect(s.hasSigner()).toBe(false);
      expect(s.hasAgents()).toBe(false);
      expect(() => s.requireSigner(97)).toThrow(NoSignerKeyError);
      expect(() => s.requireSigner(97, "agent1")).toThrow(/unattended/);
    }
  });

  it("keystore mode: an address, never a Wallet, no message signing, no keyring", async () => {
    const s = new SignerManager(
      cfg({ signerMode: "keystore", keystore: { file: "/nowhere.json", address: ADDR }, privateKey: PK }),
    );
    expect(s.hasSigner()).toBe(true);
    expect(s.getAddress()).toBe(ADDR);
    expect(s.describeSigner()).toEqual({ signerKey: "keystore", address: ADDR });
    expect(s.hasSigner("agent1")).toBe(false);
    expect(s.hasSigner(ADDR.toLowerCase())).toBe(true);
    expect(() => s.requireSigner(97)).toThrow(SignerModeRefusal);
    await expect(s.signMessage("hello")).rejects.toThrow(/WalletConnect|dexe_wc_connect/);
    expect(s.approvals).toBeDefined();
  });

  it("keystore mode with no keystore says how to create one", () => {
    const s = new SignerManager(cfg({ signerMode: "keystore" }));
    expect(s.hasSigner()).toBe(false);
    expect(s.approvals).toBeUndefined();
    expect(() => s.getAddress()).toThrow(/key create/);
  });
});

// ---------------------------------------------------------------------------
// The config loader: the default with a hot key present, and the explicit modes.
// ---------------------------------------------------------------------------

const TOUCHED = [
  "DEXE_SIGNER_MODE",
  "DEXE_PRIVATE_KEY",
  "DEXE_UNATTENDED_CHAINS",
  "DEXE_KEYSTORE_PATH",
  "DEXE_KEYSTORE_ADDRESS",
  "DEXE_KEYSTORE_PASSWORD_FILE",
  "DEXE_APPROVAL_WAIT_MS",
  "DEXE_APPROVAL_TTL_S",
  "DEXE_APPROVAL_OPEN_BROWSER",
  ...Array.from({ length: 16 }, (_, i) => `DEXE_AGENT_PK_${i + 1}`),
  ...Array.from({ length: 16 }, (_, i) => `AGENT_PK_${i + 1}`),
  "DEXE_AGENT_FUNDER_PK",
  "AGENT_FUNDER_PK",
  "DEXE_SIGNER_ALLOWLIST",
  "DEXE_SIGNER_MAX_VALUE_WEI",
];
const saved = new Map<string, string | undefined>();
let ksDir: string;
beforeAll(async () => {
  ksDir = mkdtempSync(join(tmpdir(), "dexe-mode-"));
  writeKeystoreFile(join(ksDir, "ks"), await encryptPrivateKey(PK, "password123", { N: 2 ** 17, r: 8, p: 1 }));
  // a keystore mode must refuse: scrypt N below 2^17
  writeKeystoreFile(join(ksDir, "weak"), await encryptPrivateKey(PK, "password123", { N: 1024, r: 8, p: 1 }));
  writeFileSync(join(ksDir, "pw.txt"), "password123\n");
});
afterAll(() => rmSync(ksDir, { recursive: true, force: true }));
beforeEach(() => {
  for (const k of TOUCHED) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe("loadConfig — signer modes", () => {
  it("clean env → walletconnect, nothing loaded", async () => {
    const c = await loadConfig();
    expect(c.signerMode).toBe("walletconnect");
    expect(c.signerModeSource).toBe("default");
    expect(c.privateKey).toBeUndefined();
    expect(c.unattendedChains).toBeNull();
  });

  it("unset mode + DEXE_PRIVATE_KEY → walletconnect, key NOT loaded, doctor fails with the three ways out", async () => {
    process.env.DEXE_PRIVATE_KEY = PK;
    const c = await loadConfig();
    expect(c.signerMode).toBe("walletconnect");
    expect(c.signerModeSource).toBe("default");
    expect(c.privateKey).toBeUndefined();
    expect(c.unattendedChains).toBeNull();
    expect(new SignerManager(c).hasSigner()).toBe(false);
    const rows = signerModeChecks(c, process.env);
    expect(rows.find((r) => r.id === "signer.mode")?.status).toBe("pass");
    const ignored = rows.find((r) => r.id === "signer.hotKeyIgnored")!;
    expect(ignored.status).toBe("fail");
    expect(ignored.message).toMatch(/DEXE_PRIVATE_KEY: .*IGNORED.*since dexe-mcp 1\.0\.0/);
    expect(ignored.remediation).toMatch(/DEXE_SIGNER_MODE=unattended/);
    expect(ignored.remediation).toMatch(/key import --from-env/);
    expect(ignored.remediation).toMatch(/dexe_wc_connect/);
  });

  it("unset mode + swarm aliases alone (AGENT_PK_n) → no keyring either", async () => {
    process.env.AGENT_PK_1 = PK;
    const c = await loadConfig();
    expect(c.signerMode).toBe("walletconnect");
    expect(c.agentKeys).toEqual({});
    expect(signerModeChecks(c, process.env).find((r) => r.id === "signer.hotKeyIgnored")?.status).toBe("fail");
  });

  it("explicit unattended → fenced to 97; DEXE_UNATTENDED_CHAINS widens it deliberately", async () => {
    process.env.DEXE_PRIVATE_KEY = PK;
    process.env.DEXE_SIGNER_MODE = "unattended";
    expect((await loadConfig()).unattendedChains).toEqual([97]);
    process.env.DEXE_UNATTENDED_CHAINS = "97,56";
    const c = await loadConfig();
    expect(c.unattendedChains).toEqual([97, 56]);
    expect(signerModeChecks(c, process.env).some((r) => r.id === "signer.unattendedMainnet")).toBe(true);
  });

  it("a malformed DEXE_UNATTENDED_CHAINS fails closed to 97", async () => {
    process.env.DEXE_PRIVATE_KEY = PK;
    process.env.DEXE_SIGNER_MODE = "unattended";
    process.env.DEXE_UNATTENDED_CHAINS = "97;56";
    const c = await loadConfig();
    expect(c.unattendedChains).toEqual([97]);
    expect(c.startupIssues.some((i) => i.key === "DEXE_UNATTENDED_CHAINS")).toBe(true);
  });

  it("explicit walletconnect / keystore / readonly never load a hot key, and doctor says it is ignored", async () => {
    process.env.DEXE_PRIVATE_KEY = PK;
    process.env.AGENT_PK_2 = PK;
    for (const mode of ["walletconnect", "readonly"]) {
      process.env.DEXE_SIGNER_MODE = mode;
      const c = await loadConfig();
      expect(c.signerMode).toBe(mode);
      expect(c.privateKey).toBeUndefined();
      expect(c.agentKeys).toEqual({});
      const ignored = signerModeChecks(c, process.env).find((r) => r.id === "signer.hotKeyIgnored");
      expect(ignored?.status).toBe("warn");
      expect(ignored?.remediation).toMatch(/key import --from-env/);
    }
  });

  it("a typo'd mode with a hot key present resolves to walletconnect, not unattended", async () => {
    process.env.DEXE_PRIVATE_KEY = PK;
    process.env.DEXE_SIGNER_MODE = "keysotre";
    const c = await loadConfig();
    expect(c.signerMode).toBe("walletconnect");
    expect(c.privateKey).toBeUndefined();
    expect(c.startupIssues.some((i) => i.key === "DEXE_SIGNER_MODE")).toBe(true);
  });

  it("keystore mode selects the keystore and the approval settings", async () => {
    process.env.DEXE_SIGNER_MODE = "keystore";
    process.env.DEXE_KEYSTORE_PATH = join(ksDir, "ks");
    process.env.DEXE_APPROVAL_WAIT_MS = "0";
    process.env.DEXE_APPROVAL_TTL_S = "5"; // clamped up to 60
    process.env.DEXE_APPROVAL_OPEN_BROWSER = "0";
    const c = await loadConfig();
    expect(c.signerMode).toBe("keystore");
    expect(c.keystore?.address).toBe(ADDR);
    expect(c.approvalWaitMs).toBe(0);
    expect(c.approvalTtlS).toBe(60);
    expect(c.approvalOpenBrowser).toBe(false);
    expect(signerModeChecks(c, process.env).find((r) => r.id === "signer.mode")?.status).toBe("pass");
  });

  it("keystore mode never reads DEXE_KEYSTORE_PASSWORD_FILE; unattended mode may", async () => {
    process.env.DEXE_KEYSTORE_PATH = join(ksDir, "ks");
    process.env.DEXE_KEYSTORE_PASSWORD_FILE = join(ksDir, "pw.txt");
    process.env.DEXE_SIGNER_MODE = "keystore";
    const k = await loadConfig();
    expect(k.privateKey).toBeUndefined();
    expect(signerModeChecks(k, process.env).some((r) => r.id === "signer.passwordFile")).toBe(true);
    process.env.DEXE_SIGNER_MODE = "unattended";
    const u = await loadConfig();
    expect(u.privateKey?.toLowerCase()).toBe(PK.toLowerCase());
    expect(u.unattendedChains).toEqual([97]);
  }, 30_000);

  it("keystore mode refuses a keystore whose KDF is too cheap (N < 2^17) and says how to re-encrypt", async () => {
    process.env.DEXE_SIGNER_MODE = "keystore";
    process.env.DEXE_KEYSTORE_PATH = join(ksDir, "weak");
    const c = await loadConfig();
    expect(c.keystore).toBeUndefined();
    expect(c.startupIssues.find((i) => i.key === "DEXE_KEYSTORE_PATH")?.message).toMatch(/change-password/);
    expect(signerModeChecks(c, process.env).find((r) => r.id === "signer.mode")?.status).toBe("fail");
  });

  it("keystore mode with no keystore degrades with the create hint", async () => {
    process.env.DEXE_SIGNER_MODE = "keystore";
    process.env.DEXE_KEYSTORE_PATH = join(ksDir, "empty");
    const c = await loadConfig();
    expect(c.keystore).toBeUndefined();
    expect(c.startupIssues.find((i) => i.key === "DEXE_KEYSTORE_PATH")?.message).toMatch(/key create/);
    expect(signerModeChecks(c, process.env).find((r) => r.id === "signer.mode")?.status).toBe("fail");
  });
});
