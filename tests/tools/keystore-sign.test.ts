import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from "vitest";
import { getAddress, keccak256, verifyMessage, verifyTypedData, Wallet } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encryptPrivateKey } from "../../src/lib/keystore.js";
import { ApprovalManager } from "../../src/lib/approval/index.js";
import { applyApprovalScope } from "../../src/lib/approval/scope.js";
import type { SignerManager } from "../../src/lib/signer.js";
import type { WalletConnectManager } from "../../src/lib/walletconnect.js";
import type { DexeConfig } from "../../src/config.js";
import type { ToolContext } from "@dexe-network/dexe-mcp/core";
import { registerSafeTools } from "../../src/tools/safe.js";
import { registerProposalBuildOffchainTools } from "../../src/tools/proposalBuildOffchain.js";
import { buildSafeTx, computeSafeTxHash, safeTxDomain, SAFE_TX_TYPES, type SafeTx } from "../../src/lib/ethersProvider.js";
import { approveAsHuman, declineAsHuman } from "../helpers/approvalHttp.js";

/**
 * 2c Phase B — the two signing tools in keystore mode, through the real MCP
 * handlers and the approval scope: `dexe_safe_propose_tx` (sign:true /
 * dryRun:false) and `dexe_auth_login` now return `awaiting_approval`, the
 * owner approves the exact SafeTx / nonce message, and re-running the SAME
 * call signs it. The on-chain Safe check is replaced by a fixed review here
 * (tests/lib/approval-safe-review.test.ts covers it).
 */
const reviewMock = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("../../src/lib/approval/safeReview.js", async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  return { ...mod, buildSafeTxReview: async () => reviewMock.result };
});

const FAST = { N: 2 ** 17, r: 8, p: 1 };
const KEY = Wallet.createRandom();
const PW = "keystore sign tool password";
let json: string;
beforeAll(async () => {
  json = await encryptPrivateKey(KEY.privateKey, PW, FAST);
});

const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const TO = getAddress("0x2222222222222222222222222222222222222222");
const config = {
  agentKeys: {},
  chains: new Map([[97, { chainId: 97, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"] }]]),
  defaultChainId: 97,
} as unknown as DexeConfig;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllGlobals();
});

function keystoreSigner() {
  const approvals = new ApprovalManager({
    keystoreFile: "(memory)",
    address: KEY.address,
    waitMs: 0,
    ttlMs: 900_000,
    openBrowser: false,
    readKeystore: () => json,
    connect: () => {
      throw new Error("no transactions here");
    },
    lock: (_c, task) => task(),
    log: () => undefined,
  });
  cleanups.push(() => approvals.close());
  const signer = {
    mode: "keystore",
    approvals,
    hasSigner: (k?: string) => !k,
    getAddress: () => KEY.address,
    getConfig: () => config,
  } as unknown as SignerManager;
  return { signer, approvals };
}

async function connect(register: (s: McpServer) => void, tools: string[]): Promise<Client> {
  const server = new McpServer({ name: "ks-sign", version: "0.0.0" });
  register(applyApprovalScope(server, new Set(tools)));
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanups.push(() => client.close());
  return client;
}

type Res = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
const body = (r: Res) => JSON.parse(r.content[r.content.length - 1]!.text) as Record<string, unknown>;

// ---------------------------------------------------------------------------

describe("dexe_safe_propose_tx — keystore mode signs only an owner-approved SafeTx", () => {
  const okReview = () => ({
    ok: true,
    safe: {
      safe: SAFE,
      version: "1.4.1",
      singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
      singletonLabel: "Safe 1.4.1 L2 (canonical)",
      threshold: "1",
      ownerCount: 1,
      nonce: "3",
      currentNonce: "3",
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      // what the real Safe's getTransactionHash returns for the call below
      onChainSafeTxHash: computeSafeTxHash(97, SAFE, buildSafeTx({ to: TO, value: "0", data: "0x", nonce: "3" })),
      risks: [],
    },
    steps: [
      {
        index: 0,
        to: TO,
        toLabel: "unlabelled contract",
        value: "0",
        valueHuman: "0.0 tBNB",
        selector: null,
        dataBytes: 0,
        dataHash: keccak256("0x"),
        dataPreview: "0x",
        decoded: null,
        risks: [],
      },
    ],
    prechecks: { guards: "pass", simulation: "skipped" },
  });
  beforeEach(() => {
    reviewMock.result = okReview();
  });

  async function setup() {
    const { signer, approvals } = keystoreSigner();
    const client = await connect((s) => registerSafeTools(s, { config } as unknown as ToolContext, signer), ["dexe_safe_propose_tx"]);
    const propose = async (over: Record<string, unknown> = {}) =>
      (await client.callTool({
        name: "dexe_safe_propose_tx",
        arguments: { safe: SAFE, to: TO, chainId: 97, nonce: "3", sign: true, ...over },
      })) as Res;
    return { propose, approvals };
  }

  it("awaiting_approval → owner approves → the same call returns a signature by the keystore over exactly that SafeTx", async () => {
    const { propose, approvals } = await setup();
    const first = body(await propose());
    expect(first.mode).toBe("awaiting_approval");
    const appr = first.approval as Record<string, string>;
    expect(String(appr.steps)).toMatch(/sign Safe transaction nonce 3/);
    expect((await approveAsHuman(appr.url!, PW)).status).toBe(200);

    const signed = body(await propose());
    expect(signed.mode).toBe("dryRun");
    expect(signed.signer).toBe("keystore");
    expect(String(signed.safety)).toMatch(/owner approved this exact SafeTx/);
    const b = signed.body as Record<string, unknown>;
    const tx = {
      to: b.to,
      value: b.value,
      data: b.data,
      operation: b.operation,
      safeTxGas: b.safeTxGas,
      baseGas: b.baseGas,
      gasPrice: b.gasPrice,
      gasToken: b.gasToken,
      refundReceiver: b.refundReceiver,
      nonce: b.nonce,
    } as unknown as SafeTx;
    expect(verifyTypedData(safeTxDomain(97, SAFE), SAFE_TX_TYPES, tx, String(b.signature))).toBe(KEY.address);
    expect(b.sender).toBe(KEY.address);
    expect(approvals.view(appr.approvalId!)!.status).toBe("consumed");
    // single use: the same call asks again
    expect(body(await propose()).mode).toBe("awaiting_approval");
  });

  it("an unsigned preview (dryRun, sign:false) never asks for approval", async () => {
    const { propose, approvals } = await setup();
    const r = body(await propose({ sign: false }));
    expect(r.mode).toBe("dryRun");
    expect(r.signaturePresent).toBe(false);
    expect(approvals.store.open()).toEqual([]);
  });

  it("refuses before any page when the Safe check fails, or the sender is not the keystore", async () => {
    const { propose, approvals } = await setup();
    reviewMock.result = { ok: false, reason: "The keystore address 0x… is not an owner of the Safe" };
    const notOwner = await propose();
    expect(notOwner.isError).toBe(true);
    expect(notOwner.content[0]!.text).toMatch(/not an owner/);
    reviewMock.result = okReview();
    const sender = await propose({ sender: Wallet.createRandom().address });
    expect(sender.isError).toBe(true);
    expect(sender.content[0]!.text).toMatch(/is not the keystore address/);
    expect(approvals.store.open()).toEqual([]);
  });

  it("review probe: any gas refund field is refused in keystore mode before any page (no opt-in)", async () => {
    const { propose, approvals } = await setup();
    // gasPrice 1 gwei + baseGas 1e12, token/receiver zero → ≥ 1000 native coin to the executor.
    const probe = await propose({ gasPrice: "1000000000", baseGas: "1000000000000" });
    expect(probe.isError).toBe(true);
    expect(probe.content[0]!.text).toMatch(/gasPrice 1000000000, baseGas 1000000000000.*Nothing was put up for approval/s);
    for (const over of [{ gasPrice: "1" }, { baseGas: "1" }, { gasToken: TO }, { refundReceiver: TO }]) {
      const r = await propose(over);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Refused: in keystore mode/);
    }
    expect(approvals.store.open()).toEqual([]);
  });

  it("dryRun:false on a chain with no Safe service fails before the owner is asked", async () => {
    const { propose, approvals } = await setup();
    const r = await propose({ dryRun: false, sign: false });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Nothing was put up for approval/);
    expect(approvals.store.open()).toEqual([]);
  });

  it("a decline is reported as declined (nothing signed)", async () => {
    const { propose } = await setup();
    const first = body(await propose());
    await declineAsHuman((first.approval as Record<string, string>).url!);
    const r = await propose();
    expect(r.isError).toBe(true);
    expect(body(r).mode).toBe("declined");
  });
});

// ---------------------------------------------------------------------------

describe("dexe_auth_login — keystore mode signs only the owner-approved nonce message", () => {
  const BASE = "https://backend.example";
  let nonceCalls = 0;
  let loginBody: { data: { attributes: { auth_pair: { address: string; signed_message: string } } } } | undefined;
  const MESSAGE = "Sign this message to log in to DeXe.\nNonce: 91f0c2aa";

  beforeEach(() => {
    nonceCalls = 0;
    loginBody = undefined;
    process.env.DEXE_BACKEND_API_URL = BASE;
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      if (url.endsWith("/nonce")) {
        nonceCalls += 1;
        return new Response(JSON.stringify({ data: { attributes: { message: MESSAGE } } }), { status: 200 });
      }
      loginBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          data: { relationships: { access_token: { data: { id: "ACCESS" } }, refresh_token: { data: { id: "REFRESH" } } } },
        }),
        { status: 200 },
      );
    });
  });
  afterEach(() => {
    delete process.env.DEXE_BACKEND_API_URL;
  });

  async function setup() {
    const { signer, approvals } = keystoreSigner();
    const wc = { isConnected: () => false, account: () => undefined } as unknown as WalletConnectManager;
    const client = await connect(
      (s) => registerProposalBuildOffchainTools(s, { config } as unknown as ToolContext, signer, wc),
      ["dexe_auth_login"],
    );
    const login = async (args: Record<string, unknown> = {}) => (await client.callTool({ name: "dexe_auth_login", arguments: args })) as Res;
    return { login, approvals };
  }

  it("awaiting_approval (with structured content) → approve → re-run reuses the SAME nonce and logs in", async () => {
    const { login, approvals } = await setup();
    const first = await login();
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent?.mode).toBe("awaiting_approval");
    const appr = body(first).approval as Record<string, string>;
    expect(String(appr.steps)).toMatch(/sign a message .* Log in to the DeXe backend at https:\/\/backend\.example/);
    expect((await approveAsHuman(appr.url!, PW)).status).toBe(200);

    const done = await login();
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ accessToken: "ACCESS", signerMode: "keystore", address: KEY.address });
    expect(nonceCalls).toBe(1); // the re-run did not fetch a new nonce
    const pair = loginBody!.data.attributes.auth_pair;
    expect(pair.address).toBe(KEY.address);
    expect(verifyMessage(MESSAGE, pair.signed_message)).toBe(KEY.address);
    expect(approvals.view(appr.approvalId!)!.status).toBe("consumed");
  });

  it("logs in only as the keystore address", async () => {
    const { login } = await setup();
    const r = await login({ address: Wallet.createRandom().address });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/keystore address .* only/);
    expect(nonceCalls).toBe(0);
  });

  it("a decline is an error result; re-runs are refused WITHOUT a new nonce or page for the cooldown", async () => {
    const { login, approvals } = await setup();
    const first = body(await login());
    await declineAsHuman((first.approval as Record<string, string>).url!);
    expect(nonceCalls).toBe(1);
    for (let i = 0; i < 3; i++) {
      const r = await login();
      expect(r.isError).toBe(true);
      expect(body(r).mode).toBe("declined");
    }
    expect(nonceCalls).toBe(1); // the backend was not asked again → no new message, no new page
    expect(approvals.store.open()).toEqual([]);
    expect(loginBody).toBeUndefined();
  });

  it("a login to a non-default backend is DANGER on the page", async () => {
    const { login } = await setup();
    const first = body(await login());
    const page = await (await import("../helpers/approvalHttp.js")).rawRequest((first.approval as Record<string, string>).url!);
    expect(page.body).toMatch(/risk r-danger[^<]*This login goes to https:\/\/backend\.example, NOT the DeXe backend https:\/\/api\.dexe\.io/);
  });
});
