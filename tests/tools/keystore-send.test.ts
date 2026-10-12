import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { keccak256, Wallet } from "ethers";
import { sendOrCollect } from "../../src/tools/flow.js";
import { encryptPrivateKey } from "../../src/lib/keystore.js";
import { ApprovalManager } from "../../src/lib/approval/index.js";
import {
  ApprovalHaltError,
  applyApprovalScope,
  approvalHaltResult,
  runInToolScope,
  scopeFromExtra,
} from "../../src/lib/approval/scope.js";
import { KEYSTORE_SAFETY, type SignerManager } from "../../src/lib/signer.js";
import type { TxPayload } from "../../src/lib/calldata.js";
import { approveAsHuman, declineAsHuman } from "../helpers/approvalHttp.js";

/**
 * 2c Phase A — the composite send loop in keystore mode. Every composite
 * (proposal_create, vote_and_execute, dao_create, the OTC flows) inherits this
 * path through sendOrCollect, so it is tested once, here, with the human played
 * over HTTP and the chain replaced by a recording wallet.
 */
vi.mock("../../src/lib/broadcastGuards.js", async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  return { ...mod, runBroadcastGuards: async () => {} };
});
vi.mock("../../src/lib/simulate.js", async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  return { ...mod, simulateCalldata: async () => ({ success: true }) };
});

const KEY = Wallet.createRandom();
const PW = "keystore-send-test-password";
let json: string;
beforeAll(async () => {
  json = await encryptPrivateKey(KEY.privateKey, PW, { N: 2 ** 17, r: 8, p: 1 }); // the minimum keystore mode accepts
});

const GUARD_CFG = {
  signerAllowlist: undefined,
  signerMaxValueWei: undefined,
  signerMaxBroadcastsPerMin: undefined,
  chains: new Map(),
  defaultChainId: 97,
  statePath: "/nonexistent/state.json",
  treasuryGuard: "off",
};

const managers: ApprovalManager[] = [];
afterEach(async () => {
  while (managers.length) await managers.pop()!.close();
});

function keystoreSigner(opts: { failAt?: number } = {}) {
  const sent: Array<{ to: string; data: string }> = [];
  const approvals = new ApprovalManager({
    keystoreFile: "(memory)",
    address: KEY.address,
    waitMs: 0,
    ttlMs: 900_000,
    openBrowser: false,
    readKeystore: () => json,
    connect: () => ({
      address: KEY.address,
      async sendTransaction(tx) {
        if (opts.failAt !== undefined && sent.length === opts.failAt) throw new Error("insufficient funds for gas");
        sent.push({ to: tx.to, data: tx.data });
        const hash = keccak256(tx.data + sent.length.toString(16).padStart(2, "0"));
        return { hash, async wait() { return { status: 1, hash }; } } as never;
      },
    }),
    lock: (_c, task) => task(),
    log: () => undefined,
  });
  managers.push(approvals);
  const signer = {
    mode: "keystore",
    approvals,
    hasSigner: (k?: string) => !k,
    getAddress: () => KEY.address,
    describeSigner: () => ({ signerKey: "keystore", address: KEY.address }),
    getConfig: () => GUARD_CFG,
    withBroadcastLock: (_c: number, task: () => Promise<unknown>) => task(),
  } as unknown as SignerManager;
  return { signer, sent, approvals };
}

const P = (to: string, data: string, description: string): TxPayload => ({ to, data, value: "0", chainId: 97, description });
const BATCH = [
  P("0x1111111111111111111111111111111111111111", "0x095ea7b3" + "00".repeat(64), "ERC20.approve(userKeeper, 5)"),
  P("0x3333333333333333333333333333333333333333", "0xac9650d8" + "00".repeat(64), "GovPool.multicall([deposit, vote])"),
];

async function haltOf(p: Promise<unknown>): Promise<ApprovalHaltError> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApprovalHaltError);
  return e as ApprovalHaltError;
}

describe("sendOrCollect in keystore mode", () => {
  it("asks once for the whole ordered batch, then signs exactly it on the re-run", async () => {
    const { signer, sent } = keystoreSigner();
    const halt = await haltOf(sendOrCollect(signer, BATCH, { chainId: 97, tool: "dexe_proposal_create" }));
    expect(halt.halt.status).toBe("pending");
    expect(halt.halt.steps).toHaveLength(2);
    expect(sent).toHaveLength(0);

    expect((await approveAsHuman(halt.halt.url!, PW)).status).toBe(200);
    const res = await sendOrCollect(signer, BATCH, { chainId: 97, tool: "dexe_proposal_create" });
    expect(res.mode).toBe("executed");
    expect(res.steps.map((s) => s.label)).toEqual(BATCH.map((b) => b.description));
    expect(res.signer).toEqual({ signerKey: "keystore", address: KEY.address, safety: KEYSTORE_SAFETY });
    expect(sent.map((s) => s.data)).toEqual(BATCH.map((b) => b.data));
  });

  it("dryRun never asks and names the keystore as the payer", async () => {
    const { signer, approvals } = keystoreSigner();
    const res = await sendOrCollect(signer, BATCH, { chainId: 97, dryRun: true });
    expect(res.mode).toBe("dryRun");
    expect(res.signer).toEqual({ signerKey: "keystore", address: KEY.address });
    expect(approvals.openApprovals()).toEqual([]);
  });

  it("signerKey is refused — keystore mode has one key", async () => {
    const { signer } = keystoreSigner();
    await expect(sendOrCollect(signer, BATCH, { chainId: 97, signerKey: "agent1" })).rejects.toThrow(/signerKey/);
  });

  it("a declined batch halts as declined", async () => {
    const { signer } = keystoreSigner();
    const first = await haltOf(sendOrCollect(signer, BATCH, { chainId: 97, tool: "dexe_proposal_create" }));
    await declineAsHuman(first.halt.url!);
    const again = await haltOf(sendOrCollect(signer, BATCH, { chainId: 97, tool: "dexe_proposal_create" }));
    expect(again.halt.status).toBe("declined");
  });

  it("a failing step revokes the approval; the re-run asks again for what is left, listing what landed", async () => {
    const { signer, sent, approvals } = keystoreSigner({ failAt: 1 });
    const halt = await haltOf(sendOrCollect(signer, BATCH, { chainId: 97, tool: "dexe_proposal_create" }));
    await approveAsHuman(halt.halt.url!, PW);
    const res = await sendOrCollect(signer, BATCH, { chainId: 97, tool: "dexe_proposal_create" });
    expect(res.mode).toBe("failed");
    expect(res.failure?.landedSteps).toHaveLength(1);
    expect(res.failure?.resume).toMatch(/approve only what is left/);
    expect(approvals.view(halt.halt.approvalId)!.status).toBe("revoked");
    expect(sent).toHaveLength(1);

    // The composite would re-derive state and send only the remainder.
    const rest = await haltOf(sendOrCollect(signer, [BATCH[1]!], { chainId: 97, tool: "dexe_proposal_create" }));
    const rec = approvals.store.get(rest.halt.approvalId)!;
    expect(rec.resumeNote?.[0]?.label).toBe(BATCH[0]!.description);
  });
});

describe("the approval scope", () => {
  it("renders a halt anywhere inside a tool as awaiting_approval (not an error) or declined (error)", async () => {
    let handler: ((...a: unknown[]) => unknown) | undefined;
    const fake = {
      tool: (_n: string, ...rest: unknown[]) => {
        handler = rest[rest.length - 1] as typeof handler;
      },
    };
    const server = applyApprovalScope(fake as never, new Set(["dexe_proposal_create"]));
    const halt = {
      status: "pending" as const,
      approvalId: "apr_test",
      url: "http://127.0.0.1:1/a/x",
      fingerprint: "ABC-DEF",
      chainId: 97,
      from: KEY.address,
      steps: ["1. x"],
      message: "waiting",
    };
    (server as unknown as typeof fake).tool("dexe_proposal_create", "d", {}, async () => {
      throw new ApprovalHaltError(halt);
    });
    const out = (await handler!({}, {})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
    expect(body.mode).toBe("awaiting_approval");
    expect(String(body.next)).toMatch(/never ask for the password/);
    expect(String(body.next)).toContain("apr_test");

    const declined = approvalHaltResult({ ...halt, status: "declined" });
    expect(declined.isError).toBe(true);
    expect(JSON.parse(declined.content[0]!.text).message).toMatch(/Do not retry unless the user asks/);
  });

  it("forwards progress only when the client asked for it", async () => {
    const sendNotification = vi.fn(async () => {});
    const withToken = scopeFromExtra("t", { _meta: { progressToken: 7 }, sendNotification });
    await withToken.progress("hello");
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: 7, progress: 1, message: "hello" },
    });
    const without = scopeFromExtra("t", { sendNotification });
    await without.progress("hello");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(runInToolScope(withToken, () => 42)).toBe(42);
  });
});
