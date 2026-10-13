import { describe, it, expect } from "vitest";
import { mcpChildEnv, swarmChainId } from "../../scripts/swarm/mcpEnv.js";
import { resolveSignerMode, unattendedChainFence } from "../../src/lib/signerMode.js";

/**
 * 0.37.0 — the swarm fleet signs with hot keys, so its MCP child must say
 * `DEXE_SIGNER_MODE=unattended` explicitly (since 1.0.0 a hot key with no mode
 * signs nothing) and fence itself to the run's chain.
 */
describe("swarm MCP child env", () => {
  it("is explicit unattended, fenced to the run's chain, full toolset", () => {
    const env = mcpChildEnv({ SWARM_CHAIN_ID: "97", AGENT_PK_1: "0xabc", UNSET: undefined }, { primary: "", chainId: 97 });
    expect(env.DEXE_SIGNER_MODE).toBe("unattended");
    expect(env.DEXE_UNATTENDED_CHAINS).toBe("97");
    expect(env.DEXE_TOOLSETS).toBe("full");
    expect(env.DEXE_PRIVATE_KEY).toBe("");
    expect(env.AGENT_PK_1).toBe("0xabc");
    expect("UNSET" in env).toBe(false);
  });

  it("a mainnet stage fences to 56 only, overriding whatever the shell had", () => {
    const env = mcpChildEnv({ DEXE_UNATTENDED_CHAINS: "97,56,1", DEXE_SIGNER_MODE: "keystore" }, { primary: "0x1", chainId: 56 });
    expect(env.DEXE_UNATTENDED_CHAINS).toBe("56");
    expect(env.DEXE_SIGNER_MODE).toBe("unattended");
  });

  it("resolves the same chain main() does", () => {
    expect(swarmChainId({ SWARM_CHAIN_ID: " 97 " })).toBe(97);
    expect(swarmChainId({ DEXE_CHAIN_ID: "56" })).toBe(56);
    expect(swarmChainId({})).toBe(56);
  });

  it("the server reads that env as explicit, fenced unattended", () => {
    const env = mcpChildEnv({}, { primary: "0x1", chainId: 97 });
    const r = resolveSignerMode({ requested: env.DEXE_SIGNER_MODE, walletConnectConfigured: true });
    expect(r).toEqual({ mode: "unattended", source: "explicit" });
    expect(unattendedChainFence([Number(env.DEXE_UNATTENDED_CHAINS)])).toEqual([97]);
  });
});
