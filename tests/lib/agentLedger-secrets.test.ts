import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { SignerManager } from "../../src/lib/signer.js";
import type { DexeConfig } from "../../src/config.js";
import {
  AgentLedger,
  __resetAgentLedgerCache,
  __resetLedgerSecrets,
  isRegisteredSecret,
  registerLedgerSecrets,
  scrubLedgerText,
} from "../../src/lib/agentLedger.js";

/**
 * The line `tests/tools/agent-keyring.test.ts` holds for `listAgents()` — a key
 * never gets serialized — has to hold for the ledger too, and harder: the ledger
 * writes to a file that outlives the process, that a user will paste into an
 * issue, and that an autonomous fleet appends to unattended.
 *
 * A private key and a tx hash are the SAME SHAPE (32 bytes of hex), so structure
 * alone cannot separate them. Hence the digest registry: `SignerManager`
 * registers a SHA-256 of every configured key (never the key), and the scrubber
 * removes any token that matches — whatever field it arrived in.
 *
 * The core assertion is deliberately blunt: populate the ledger through every
 * writable field, then grep the raw file bytes for every configured key.
 */

const PK_PRIMARY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PK_A1 = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const PK_A2 = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
const ALL_KEYS = [PK_PRIMARY, PK_A1, PK_A2];

const dirs: string[] = [];
function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dexe-ledger-secret-"));
  dirs.push(dir);
  return join(dir, "agent-ledger.json");
}

function cfg(partial: Partial<DexeConfig>): DexeConfig {
  return { agentKeys: {}, chains: new Map(), ...partial } as unknown as DexeConfig;
}

let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.DEXE_AGENT_LEDGER_PATH;
  delete process.env.DEXE_AGENT_LEDGER_PATH;
  __resetAgentLedgerCache();
  __resetLedgerSecrets();
});
afterEach(() => {
  if (savedPath === undefined) delete process.env.DEXE_AGENT_LEDGER_PATH;
  else process.env.DEXE_AGENT_LEDGER_PATH = savedPath;
  __resetLedgerSecrets();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Every spelling of a key that could end up in a file: 0x, bare, upper, lower. */
function spellings(pk: string): string[] {
  const bare = pk.slice(2);
  return [pk, pk.toUpperCase().replace("0X", "0x"), bare, bare.toUpperCase()];
}

describe("the ledger file never contains key material", () => {
  it("greps a populated ledger for every configured private key (all spellings)", () => {
    // Prod wiring: constructing the SignerManager is what registers the digests.
    new SignerManager(cfg({ privateKey: PK_PRIMARY, agentKeys: { agent1: PK_A1, agent2: PK_A2 } }));

    const p = tmpLedgerPath();
    const l = new AgentLedger(p);
    const realHash = `0x${"ab".repeat(32)}`;

    // Honest traffic…
    l.record({
      signerKey: "agent1",
      address: new Wallet(PK_A1).address,
      chainId: 97,
      tool: "dexe_proposal_create",
      action: "create proposal #7",
      txHash: realHash,
      valueWei: 0n,
      gasWei: 21_000n,
    });

    // …and every adversarial way a key could be pushed into the file.
    l.record({
      signerKey: PK_A1, // key as the slot label
      address: PK_PRIMARY, // key where an address belongs
      chainId: 56,
      tool: PK_A2, // key as the tool name
      action: `funding with key ${PK_PRIMARY}`, // key inside free text
      txHash: PK_A1, // key in the hash slot (identical shape)
      note: `rpc https://node.example/${PK_A2} rejected key ${PK_A2.slice(2)}`,
      valueWei: 1n,
    });
    l.settle(realHash, { outcome: "confirmed", note: `receipt for ${PK_PRIMARY}` });

    const raw = readFileSync(p, "utf8");
    expect(raw.length).toBeGreaterThan(100); // the file really is populated
    for (const pk of ALL_KEYS) {
      for (const form of spellings(pk)) {
        expect(raw).not.toContain(form);
      }
    }
    // Nor does the parsed view leak one through some field we forgot to grep.
    const serialized = JSON.stringify(l.all());
    for (const pk of ALL_KEYS) expect(serialized).not.toContain(pk.slice(2, 34));

    // …while the legitimate tx hash is preserved (the scrubber is not a blanket).
    expect(raw).toContain(realHash);
    expect(l.all().some((e) => e.txHash === realHash)).toBe(true);
  });

  it("drops a key in the txHash slot rather than storing it as a hash", () => {
    registerLedgerSecrets([PK_A1]);
    const l = new AgentLedger(tmpLedgerPath());
    l.record({ signerKey: "agent1", address: new Wallet(PK_A1).address, chainId: 97, txHash: PK_A1 });
    expect(l.all()[0]!.txHash).toBeUndefined();
  });

  it("a key as the signerKey label degrades to 'unknown'", () => {
    registerLedgerSecrets([PK_A1]);
    const l = new AgentLedger(tmpLedgerPath());
    l.record({ signerKey: PK_A1, address: new Wallet(PK_A1).address, chainId: 97 });
    expect(l.all()[0]!.signerKey).toBe("unknown");
  });

  it("addresses are kept — attribution needs them, and 20 bytes is not a key", () => {
    const addr = new Wallet(PK_A1).address;
    const l = new AgentLedger(tmpLedgerPath());
    l.record({ signerKey: "agent1", address: addr, chainId: 97, action: `top up ${addr}` });
    const stored = l.all()[0]!;
    expect(stored.address).toBe(addr);
    expect(stored.action).toContain(addr);
  });
});

describe("scrubLedgerText", () => {
  it("masks any 32-byte hex token, keeping only the entry's own tx hash", () => {
    const other = `0x${"cd".repeat(32)}`;
    const own = `0x${"ef".repeat(32)}`;
    const out = scrubLedgerText(`saw ${own} and ${other}`, own);
    expect(out).toContain(own);
    expect(out).not.toContain(other);
    expect(out).toContain("0x<redacted-32-bytes>");
  });

  it("removes a registered secret even when it is the declared keepHash", () => {
    registerLedgerSecrets([PK_A1]);
    expect(scrubLedgerText(`key ${PK_A1}`, PK_A1)).not.toContain(PK_A1.slice(2, 20));
  });

  it("redacts credentialed RPC URLs (W36) alongside hex secrets", () => {
    const out = scrubLedgerText("failed via https://user:pass@rpc.example.com/v2/SECRETKEY");
    expect(out).not.toContain("SECRETKEY");
    expect(out).not.toContain("pass@");
  });

  it("isRegisteredSecret matches across 0x-prefix and case, and never matches a hash", () => {
    registerLedgerSecrets([PK_A1]);
    expect(isRegisteredSecret(PK_A1)).toBe(true);
    expect(isRegisteredSecret(PK_A1.slice(2).toUpperCase())).toBe(true);
    expect(isRegisteredSecret(`0x${"ab".repeat(32)}`)).toBe(false);
    expect(isRegisteredSecret("")).toBe(false);
  });

  it("with no secrets registered it still masks by shape (fail-safe default)", () => {
    expect(scrubLedgerText(`raw ${PK_A1}`)).not.toContain(PK_A1.slice(2, 20));
  });
});

describe("SignerManager still never serializes a key (0.28.0 line held)", () => {
  it("listAgents / describeSigner expose labels and addresses only", () => {
    const sm = new SignerManager(cfg({ privateKey: PK_PRIMARY, agentKeys: { agent1: PK_A1, funder: PK_A2 } }));
    const dump = JSON.stringify({ agents: sm.listAgents(), described: sm.describeSigner("agent1") });
    for (const pk of ALL_KEYS) expect(dump).not.toContain(pk.slice(2, 34));
    expect(dump).toContain(new Wallet(PK_A1).address);
  });
});
