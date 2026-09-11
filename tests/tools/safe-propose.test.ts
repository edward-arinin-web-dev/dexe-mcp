import { AbiCoder, id as keccakId } from "ethers";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DexeConfig } from "../../src/config.js";
import type { ToolContext } from "../../src/tools/context.js";
import { SignerManager } from "../../src/lib/signer.js";
import { registerSafeTools, assertSafeOperationAllowed } from "../../src/tools/safe.js";
import { BroadcastGuardError } from "../../src/lib/broadcastGuards.js";

/**
 * D8-6 — `dexe_safe_propose_tx` signed unconditionally, so the DEFAULT,
 * safest-looking invocation (`dryRun:true`) emitted a queue-ready owner EIP-712
 * signature into the transcript. The POST is unauthenticated plumbing anyone
 * can do; the SIGNATURE is the privileged, irreversible act, and it stays valid
 * until the Safe nonce is consumed.
 *
 * D8-7 — `operation:1` (DELEGATECALL) rode through with no gate at all. It runs
 * the target's code in the SAFE's own storage, where slot 0 is the singleton
 * pointer and the owners list + threshold live; B12's selector scan and B6's
 * destination allowlist are both structurally blind to it.
 *
 * A real McpServer + InMemoryTransport, so the zod defaults (`dryRun:true`,
 * `sign:false`, `allowDelegateCall:false`, `operation:0`) are actually applied —
 * the raw-handler harness used elsewhere bypasses them, and the defaults are
 * exactly what this suite is about.
 */

/** Throwaway key, never funded. Signing here is local EIP-712, never broadcast. */
const PK = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SAFE_ADDR = "0x1111111111111111111111111111111111111111";
const TO_ADDR = "0x2222222222222222222222222222222222222222";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

function cfg(partial: Partial<DexeConfig>): DexeConfig {
  return {
    agentKeys: {},
    chains: new Map([[97, { chainId: 97, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"] }]]),
    defaultChainId: 97,
    ...partial,
  } as unknown as DexeConfig;
}

async function connect(config: DexeConfig, signer?: SignerManager): Promise<Client> {
  const server = new McpServer({ name: "safe-test", version: "0.0.0" });
  registerSafeTools(server, { config } as unknown as ToolContext, signer ?? new SignerManager(config));
  const client = new Client({ name: "c", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

/** `nonce` is always explicit so nothing ever touches an RPC. */
const args = (over: Record<string, unknown> = {}) => ({
  safe: SAFE_ADDR,
  to: TO_ADDR,
  chainId: 97,
  nonce: "0",
  ...over,
});

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

async function propose(client: Client, over: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name: "dexe_safe_propose_tx", arguments: args(over) })) as ToolResult;
}

describe("dexe_safe_propose_tx — a dry run does not sign", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect(cfg({ privateKey: PK }));
  });
  afterEach(async () => {
    await client.close();
  });

  /** THE regression test: the default invocation must produce no signature. */
  it("the default (dryRun) returns an UNSIGNED payload with a real safeTxHash", async () => {
    const res = await propose(client);
    expect(res.isError).toBeFalsy();
    const p = JSON.parse(textOf(res)) as {
      safeTxHash: string;
      signaturePresent: boolean;
      signedBy: string | null;
      note: string;
      body: { signature: string | null; sender: string | null };
    };

    expect(p.signaturePresent).toBe(false);
    expect(p.body.signature).toBeNull();
    expect(p.signedBy).toBeNull();
    expect(p.note).toMatch(/UNSIGNED/);
    expect(p.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The preview still names the proposer — useful without being privileged.
    expect(p.body.sender).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // No 65-byte signature anywhere in what the model sees.
    expect(textOf(res)).not.toMatch(/0x[0-9a-f]{130}/);
  });

  it("sign:true is the explicit opt-in and produces a real owner signature", async () => {
    const res = await propose(client, { sign: true });
    const p = JSON.parse(textOf(res)) as {
      signaturePresent: boolean;
      note: string;
      body: { signature: string };
    };
    expect(p.signaturePresent).toBe(true);
    expect(p.body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(p.note).toMatch(/queue-ready/);
  });

  it("safeTxHash is byte-identical signed vs unsigned — the preview stays authoritative", async () => {
    const unsigned = JSON.parse(textOf(await propose(client))) as { safeTxHash: string };
    const signed = JSON.parse(textOf(await propose(client, { sign: true }))) as { safeTxHash: string };
    expect(signed.safeTxHash).toBe(unsigned.safeTxHash);
  });

  it("an unsigned preview never resolves an RPC-bound signer", async () => {
    // `trySigner` → `requireSigner` builds a chain provider and returns
    // {error, remediation} when it cannot — so an unsigned preview that goes
    // through it fails on any chain without usable RPC config, even though a
    // preview needs nothing but an address. This asserts it is not called at
    // all, which is the only way to keep "never blocks on missing RPC" true.
    const config = cfg({ privateKey: PK });
    const strict = new SignerManager(config);
    let trySignerCalls = 0;
    strict.trySigner = ((...a: Parameters<SignerManager["trySigner"]>) => {
      trySignerCalls += 1;
      return { error: "RPC unavailable", remediation: "set DEXE_RPC_URL_*" } as ReturnType<
        SignerManager["trySigner"]
      >;
      void a;
    }) as SignerManager["trySigner"];

    const c = await connect(config, strict);
    try {
      const res = await propose(c);
      expect(res.isError).toBeFalsy();
      expect(trySignerCalls).toBe(0);
      const p = JSON.parse(textOf(res)) as { safeTxHash: string; body: { sender: string } };
      expect(p.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(p.body.sender).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // ...and the signing path, which genuinely needs it, still uses it.
      const signed = await propose(c, { sign: true });
      expect(trySignerCalls).toBe(1);
      expect(signed.isError).toBe(true);
      expect(textOf(signed)).toContain("RPC unavailable");
    } finally {
      await c.close();
    }
  });

  it("B12 still refuses denylisted calldata on the unsigned path", async () => {
    const selector = keccakId("withdrawTokens(address,address,uint256)").slice(0, 10);
    const data =
      selector +
      AbiCoder.defaultAbiCoder()
        .encode(["address", "address", "uint256"], [TO_ADDR, TO_ADDR, 1n])
        .slice(2);
    const res = await propose(client, { data });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("[B12]");
    expect(textOf(res)).not.toMatch(/safeTxHash/);
  });
});

describe("dexe_safe_propose_tx — no signer configured", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect(cfg({}));
  });
  afterEach(async () => {
    await client.close();
  });

  it("still previews, read-only", async () => {
    const res = await propose(client);
    expect(res.isError).toBeFalsy();
    const p = JSON.parse(textOf(res)) as { safeTxHash: string; signaturePresent: boolean };
    expect(p.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(p.signaturePresent).toBe(false);
  });

  it("explains why sign:true did nothing instead of silently ignoring it", async () => {
    const res = await propose(client, { sign: true });
    expect(res.isError).toBeFalsy();
    const p = JSON.parse(textOf(res)) as { note: string; signaturePresent: boolean };
    expect(p.signaturePresent).toBe(false);
    expect(p.note).toMatch(/DEXE_PRIVATE_KEY/);
  });
});

describe("dexe_safe_propose_tx — DELEGATECALL (B13)", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect(cfg({ privateKey: PK }));
  });
  afterEach(async () => {
    await client.close();
  });

  it("operation:1 without allowDelegateCall is refused before anything is built", async () => {
    const res = await propose(client, { operation: 1 });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("[B13]");
    expect(text).toContain("DELEGATECALL");
    expect(text).toContain("allowDelegateCall");
    // Nothing was produced before the refusal.
    expect(text).not.toMatch(/safeTxHash/);
    expect(text).not.toMatch(/0x[0-9a-f]{130}/);
  });

  it("allowDelegateCall:false explicitly is the same refusal (not a truthiness accident)", async () => {
    const res = await propose(client, { operation: 1, allowDelegateCall: false });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("[B13]");
  });

  it("the escape hatch works and the calldata is unchanged", async () => {
    const res = await propose(client, { operation: 1, allowDelegateCall: true });
    expect(res.isError).toBeFalsy();
    const p = JSON.parse(textOf(res)) as { body: { operation: number }; safeTxHash: string };
    expect(p.body.operation).toBe(1);
    expect(p.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the operation default survives: omitting it means a plain CALL", async () => {
    const res = await propose(client);
    const p = JSON.parse(textOf(res)) as { body: { operation: number } };
    expect(p.body.operation).toBe(0);
  });

  it("a gas refund in an ERC-20 is surfaced as a warning (B7 cannot see it)", async () => {
    const res = await propose(client, {
      gasPrice: "1",
      gasToken: TO_ADDR,
      refundReceiver: TO_ADDR,
    });
    const p = JSON.parse(textOf(res)) as { warnings?: string[] };
    expect(p.warnings?.join(" ")).toMatch(/gas refund/);
    expect(p.warnings?.join(" ")).toMatch(/DEXE_SIGNER_MAX_VALUE_WEI/);
  });

  it("no gas-refund warning on an ordinary payload", async () => {
    const p = JSON.parse(textOf(await propose(client))) as { warnings?: string[] };
    expect(p.warnings).toBeUndefined();
  });
});

describe("assertSafeOperationAllowed (B13, unit)", () => {
  const original = process.env.DEXE_SAFE_DELEGATECALL;
  beforeEach(() => delete process.env.DEXE_SAFE_DELEGATECALL);
  afterEach(() => {
    if (original === undefined) delete process.env.DEXE_SAFE_DELEGATECALL;
    else process.env.DEXE_SAFE_DELEGATECALL = original;
  });

  it("a plain CALL is never touched", () => {
    expect(() => assertSafeOperationAllowed(0, TO_ADDR, false)).not.toThrow();
    expect(() => assertSafeOperationAllowed(0, TO_ADDR, undefined)).not.toThrow();
  });

  it("operation 1 without the flag throws a B13 guard error", () => {
    try {
      assertSafeOperationAllowed(1, TO_ADDR, false);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastGuardError);
      expect((e as BroadcastGuardError).guard).toBe("B13");
      expect((e as Error).message).toContain(TO_ADDR);
    }
  });

  it("operation 1 with the flag is allowed", () => {
    expect(() => assertSafeOperationAllowed(1, TO_ADDR, true)).not.toThrow();
  });

  it("the operator env wins over the model-set flag", () => {
    process.env.DEXE_SAFE_DELEGATECALL = "block";
    expect(() => assertSafeOperationAllowed(1, TO_ADDR, true)).toThrow(/DEXE_SAFE_DELEGATECALL/);
  });

  it("the operator env never touches plain CALLs", () => {
    process.env.DEXE_SAFE_DELEGATECALL = "block";
    expect(() => assertSafeOperationAllowed(0, TO_ADDR, false)).not.toThrow();
  });
});
