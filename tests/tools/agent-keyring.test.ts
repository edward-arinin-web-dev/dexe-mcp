import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { SignerManager } from "../../src/lib/signer.js";
import { fundCapWei, deriveKeyringAddresses } from "../../src/tools/agents.js";
import type { DexeConfig } from "../../src/config.js";

// Throwaway well-known test keys (hardhat mnemonics-style, never funded).
const PK_PRIMARY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const PK_A1 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const PK_A2 = "0x0000000000000000000000000000000000000000000000000000000000000003";

const ADDR = (pk: string) => new Wallet(pk).address;

function cfg(partial: Partial<DexeConfig>): DexeConfig {
  return { agentKeys: {}, chains: new Map(), ...partial } as unknown as DexeConfig;
}

describe("SignerManager agent keyring", () => {
  const sm = new SignerManager(cfg({ privateKey: PK_PRIMARY, agentKeys: { agent1: PK_A1, agent2: PK_A2 } }));

  it("primary stays the default signer", () => {
    expect(sm.getAddress()).toBe(ADDR(PK_PRIMARY));
    expect(sm.hasSigner()).toBe(true);
  });

  it("selects keyring entries by signerKey (case-insensitive)", () => {
    expect(sm.getAddress("agent1")).toBe(ADDR(PK_A1));
    expect(sm.getAddress("AGENT2")).toBe(ADDR(PK_A2));
    expect(sm.hasSigner("agent2")).toBe(true);
  });

  it("selects by address across primary + keyring", () => {
    expect(sm.getAddress(ADDR(PK_A2).toLowerCase())).toBe(ADDR(PK_A2));
    expect(sm.getAddress(ADDR(PK_PRIMARY))).toBe(ADDR(PK_PRIMARY));
  });

  it("rejects unknown signerKeys with the configured list", () => {
    expect(() => sm.getAddress("agent9")).toThrow(/agent1, agent2/);
    expect(sm.hasSigner("agent9")).toBe(false);
    expect(() => sm.getAddress(ADDR("0x0000000000000000000000000000000000000000000000000000000000000009"))).toThrow(
      /Unknown signerKey/,
    );
  });

  it("lists agents without exposing keys", () => {
    const list = sm.listAgents();
    expect(list).toEqual([
      { signerKey: "agent1", address: ADDR(PK_A1) },
      { signerKey: "agent2", address: ADDR(PK_A2) },
    ]);
    expect(JSON.stringify(list)).not.toContain(PK_A1.slice(4));
    expect(sm.hasAgents()).toBe(true);
  });

  it("empty keyring: agent selection fails, primary unaffected", () => {
    const bare = new SignerManager(cfg({ privateKey: PK_PRIMARY }));
    expect(bare.hasAgents()).toBe(false);
    expect(bare.hasSigner()).toBe(true);
    expect(() => bare.getAddress("agent1")).toThrow(/empty — set DEXE_AGENT_PK_1..16/);
  });
});

describe("agents_fund cap", () => {
  it("defaults to 0.1 native and honors DEXE_AGENT_FUND_MAX_WEI", () => {
    const prev = process.env.DEXE_AGENT_FUND_MAX_WEI;
    delete process.env.DEXE_AGENT_FUND_MAX_WEI;
    expect(fundCapWei()).toBe(100_000_000_000_000_000n);
    process.env.DEXE_AGENT_FUND_MAX_WEI = "250000000000000000";
    expect(fundCapWei()).toBe(250_000_000_000_000_000n);
    process.env.DEXE_AGENT_FUND_MAX_WEI = "garbage";
    expect(fundCapWei()).toBe(100_000_000_000_000_000n);
    if (prev === undefined) delete process.env.DEXE_AGENT_FUND_MAX_WEI;
    else process.env.DEXE_AGENT_FUND_MAX_WEI = prev;
  });
});

describe("deriveKeyringAddresses", () => {
  it("derives signerKey→address pairs", () => {
    expect(deriveKeyringAddresses({ agent1: PK_A1 })).toEqual([{ signerKey: "agent1", address: ADDR(PK_A1) }]);
  });
});
