import { describe, it, expect, afterAll } from "vitest";
import { AbiCoder, id } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "../../src/tools/index.js";
import { loadConfig } from "../../src/config.js";
import { scanForbiddenCalldata, forbiddenBroadcastError } from "../../src/tools/txSend.js";
import { forbiddenSelectors } from "../../src/lib/dangerousSelectors.js";

/**
 * ── The GovUserKeeper denylist is enforced at the wire, not only at build ───
 *
 * `src/lib/dangerousSelectors.ts` has always ended its refusal with "Hard
 * block, no override" — and until 0.32.0 the only callers were the proposal
 * BUILDERS. Anyone holding the raw hex could hand the identical bytes to
 * `dexe_tx_send` and the block was a comment: these functions take a
 * `payer`/`delegator` argument decoupled from the funds' owner, so the whole
 * point of the denylist is that the bytes must never reach a node.
 *
 * A build-time-only guard is exactly the kind of gap that stops being
 * theoretical once agents hold their own keys and assemble their own calldata.
 */

const WITHDRAW_TOKENS = "0x5e35359e"; // withdrawTokens(address,address,uint256)
const DELEGATE_TOKENS = "0x9161babb"; // delegateTokens(address,address,uint256)
const VICTIM = "0x00000000000000000000000000000000000000aa";
const THIEF = "0x00000000000000000000000000000000000000bb";
const KEEPER = "0x0000000000000000000000000000000000000cc0";

const coder = AbiCoder.defaultAbiCoder();

/** The drain, as an EOA would send it: keeper.withdrawTokens(victim, thief, all). */
const drainCalldata =
  WITHDRAW_TOKENS + coder.encode(["address", "address", "uint256"], [VICTIM, THIEF, 10n ** 24n]).slice(2);

describe("selector scan", () => {
  it("catches the leading selector for every denylisted function", () => {
    const all = forbiddenSelectors();
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const f of all) {
      const hit = scanForbiddenCalldata(`${f.selector}${"00".repeat(96)}`);
      expect(hit, f.signature).not.toBeNull();
      expect(hit!.match.signature).toBe(f.signature);
      expect(hit!.atByte).toBe(0);
    }
  });

  it("derives the same selectors the denylist publishes (drift guard)", () => {
    expect(id("withdrawTokens(address,address,uint256)").slice(0, 10)).toBe(WITHDRAW_TOKENS);
    expect(scanForbiddenCalldata(drainCalldata)!.match.signature).toBe("withdrawTokens(address,address,uint256)");
  });

  it("catches a selector EMBEDDED in an argument — how a proposal action carries it", () => {
    // GovPool.createProposal(descriptionURL, actionsOnFor[{executor,value,data}], [])
    const outer =
      id("createProposal(string,(address,uint256,bytes)[],(address,uint256,bytes)[])").slice(0, 10) +
      coder
        .encode(
          ["string", "tuple(address,uint256,bytes)[]", "tuple(address,uint256,bytes)[]"],
          ["ipfs://drain", [[KEEPER, 0n, drainCalldata]], []],
        )
        .slice(2);

    const hit = scanForbiddenCalldata(outer);
    expect(hit).not.toBeNull();
    expect(hit!.match.selector).toBe(WITHDRAW_TOKENS);
    expect(hit!.atByte).toBeGreaterThan(0);
    // 4-byte aligned, which is where an embedded selector can actually start.
    expect(hit!.atByte % 4).toBe(0);
  });

  it("catches a nested delegateTokens inside a multicall bundle", () => {
    const inner = DELEGATE_TOKENS + coder.encode(["address", "address", "uint256"], [VICTIM, THIEF, 1n]).slice(2);
    const bundle = id("multicall(bytes[])").slice(0, 10) + coder.encode(["bytes[]"], [[inner]]).slice(2);
    expect(scanForbiddenCalldata(bundle)!.match.signature).toBe("delegateTokens(address,address,uint256)");
  });

  it("passes ordinary calldata through untouched", () => {
    const transfer =
      id("transfer(address,uint256)").slice(0, 10) + coder.encode(["address", "uint256"], [THIEF, 5n]).slice(2);
    const deposit = id("deposit(uint256,uint256[])").slice(0, 10) + coder.encode(["uint256", "uint256[]"], [1n, [2n]]).slice(2);
    const vote =
      id("vote(uint256,bool,uint256,uint256[])").slice(0, 10) +
      coder.encode(["uint256", "bool", "uint256", "uint256[]"], [1n, true, 10n ** 18n, []]).slice(2);

    for (const d of [transfer, deposit, vote, "0x", "0xdeadbeef", "not-hex", ""]) {
      expect(scanForbiddenCalldata(d), d.slice(0, 12)).toBeNull();
    }
  });

  it("explains the refusal in terms of the harm, and says it cannot be overridden", () => {
    const msg = forbiddenBroadcastError(scanForbiddenCalldata(drainCalldata)!, KEEPER);
    expect(msg).toContain(WITHDRAW_TOKENS);
    expect(msg).toContain("withdrawTokens(address,address,uint256)");
    expect(msg).toContain(KEEPER);
    expect(msg).toMatch(/Hard block, no override/);
  });
});

describe("dexe_tx_send refuses denylisted calldata", () => {
  let client: Client;
  let server: McpServer;

  const send = async (args: Record<string, unknown>) => {
    if (!client) {
      const config = await loadConfig();
      server = new McpServer({ name: "denylist-test", version: "0.0.0" }, {});
      registerAll(server, config);
      client = new Client({ name: "c", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
    }
    const res = (await client.callTool({ name: "dexe_tx_send", arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    return res;
  };

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it("refuses a raw GovUserKeeper.withdrawTokens broadcast", async () => {
    const res = await send({ to: KEEPER, data: drainCalldata, chainId: 97, waitConfirmations: 0 });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe("rejected");
    expect(body.guard).toBe("denylist");
    expect(body.selector).toBe(WITHDRAW_TOKENS);
    expect(body.signature).toBe("withdrawTokens(address,address,uint256)");
    expect(body.reason).toMatch(/Hard block, no override/);
  });

  it("refuses it under a named agent persona too — a keyring is not an escape hatch", async () => {
    const res = await send({
      to: KEEPER,
      data: drainCalldata,
      chainId: 97,
      signerKey: "agent1",
      waitConfirmations: 0,
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).guard).toBe("denylist");
  });

  it("refuses a proposal-shaped payload that hides the selector in an action", async () => {
    const outer =
      id("createProposal(string,(address,uint256,bytes)[],(address,uint256,bytes)[])").slice(0, 10) +
      coder
        .encode(
          ["string", "tuple(address,uint256,bytes)[]", "tuple(address,uint256,bytes)[]"],
          ["ipfs://drain", [[KEEPER, 0n, drainCalldata]], []],
        )
        .slice(2);

    const res = await send({ to: THIEF, data: outer, chainId: 97, waitConfirmations: 0 });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.guard).toBe("denylist");
    expect(body.reason).toMatch(/embedded at byte offset \d+/);
  });

  it("refuses before touching the network — no signer, no RPC, no WalletConnect pairing", async () => {
    // The whole point: this is the last gate before the wire, and it closes
    // first. A tool that pairs a wallet or resolves a signer before refusing
    // would leak the attempt (and hang a readonly session on a QR prompt).
    const started = Date.now();
    const res = await send({ to: KEEPER, data: drainCalldata, chainId: 999_999, waitConfirmations: 0 });
    expect(res.isError).toBe(true);
    // chainId 999999 has no RPC configured — a guard that ran after chain
    // resolution would fail with THAT error instead of the denylist.
    expect(JSON.parse(res.content[0]!.text).guard).toBe("denylist");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
