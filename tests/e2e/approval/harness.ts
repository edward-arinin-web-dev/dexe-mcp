/**
 * ── Keystore approval E2E on BSC testnet (chain 97) ────────────────────────
 *
 * Drives the BUILT server (dist/index.js) over stdio in DEXE_SIGNER_MODE=
 * keystore, with a throwaway keystore this harness creates, and plays the
 * human itself: it fetches the approval page, reads the per-approval CSRF
 * token, and POSTs the keystore password with the page's own Origin — exactly
 * what the owner's browser does. DEXE_APPROVAL_OPEN_BROWSER=0, so nothing
 * opens on this machine.
 *
 *   1. dexe_vote_build_erc20_approve → dexe_tx_send: awaiting_approval →
 *      the owner approves → the SAME call re-run broadcasts (re-run path).
 *   2. dexe_proposal_create on the swarm fixture DAO (Kestrel): one approval
 *      for the whole approve → deposit → createProposalAndVote batch, approved
 *      WHILE the call blocks (URL taken from the progress notification).
 *   3. decline: nothing is signed, and the same batch is refused again
 *      without a new page (cooldown).
 *   4. deviation: an approved batch cannot be spent on a tampered one — the
 *      changed call gets its own approval and nothing is signed (nonce flat).
 *   5. global lockout: wrong guesses spread over three fresh approvals lock
 *      password entry everywhere (the right password is then refused), and a
 *      fourth approval is refused outright.
 *   6. what the page says: an approval to a plain wallet and a DeXe protocol
 *      call on a non-DeXe contract both render DANGER (then are declined).
 *
 * Funding: a funded testnet key from the swarm environment (`E2E_FUNDER_PK`,
 * else `AGENT_PK_8`) sends the throwaway a little tBNB and, if it holds the
 * DAO token, a little of it. Keys are read from process.env and never printed.
 *
 * NOT shipped (package.json `files` excludes tests/ and this script's runner;
 * tests/docs/pack-contents.test.ts asserts it). Chain 97 only — the harness
 * refuses any RPC that is not BSC testnet.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Contract, Interface, JsonRpcProvider, Wallet, formatEther, formatUnits, parseEther } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encryptPrivateKey, writeKeystoreFile } from "../../../src/lib/keystore.js";
import { approveAsHuman, declineAsHuman, rawRequest } from "../../helpers/approvalHttp.js";

export interface E2EOptions {
  repoRoot: string;
  govPool: string;
  rpcUrl: string;
  funderKey: string;
  /** Extra keys that may hold the DAO token, tried after the funder (labels only are printed). */
  tokenSources: Array<{ label: string; key: string }>;
  pinataJwt?: string;
  log?: (line: string) => void;
}

export interface E2EResult {
  ok: boolean;
  throwaway: string;
  steps: Array<{ name: string; ok: boolean; note: string; txHashes: string[] }>;
}

const CHAIN = 97;
const GOV_POOL = new Interface([
  "function getHelperContracts() view returns (address settings, address userKeeper, address validators, address poolRegistry, address votePower)",
]);
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

type ToolOut = { isError: boolean; text: string; json: Record<string, unknown> | null; structured?: Record<string, unknown> };

function lastJson(content: Array<{ type: string; text?: string }>): Record<string, unknown> | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const t = content[i];
    if (t?.type !== "text" || !t.text) continue;
    try {
      return JSON.parse(t.text) as Record<string, unknown>;
    } catch {
      /* QR / prose block */
    }
  }
  return null;
}

class Server {
  readonly client = new Client({ name: "e2e-approval", version: "0.0.1" });
  readonly stderrLines: string[] = [];
  private transport: StdioClientTransport;

  constructor(dist: string, env: Record<string, string>, cwd: string) {
    this.transport = new StdioClientTransport({ command: process.execPath, args: [dist], env, cwd, stderr: "pipe" });
  }

  async start(): Promise<void> {
    await this.client.connect(this.transport);
    this.transport.stderr?.on("data", (b: Buffer) => {
      for (const l of b.toString("utf8").split(/\r?\n/)) if (l.trim()) this.stderrLines.push(l);
    });
  }

  async call(name: string, args: Record<string, unknown>, onProgress?: (msg: string) => void): Promise<ToolOut> {
    const r = (await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
      resetTimeoutOnProgress: true,
      ...(onProgress ? { onprogress: (p: { message?: string }) => p.message && onProgress(p.message) } : {}),
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };
    const content = r.content ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { isError: !!r.isError, text, json: lastJson(content), ...(r.structuredContent ? { structured: r.structuredContent } : {}) };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

export async function runApprovalE2E(o: E2EOptions): Promise<E2EResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const steps: E2EResult["steps"] = [];
  const record = (name: string, ok: boolean, note: string, txHashes: string[] = []) => {
    steps.push({ name, ok, note, txHashes });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}${txHashes.length ? `\n      tx: ${txHashes.join(", ")}` : ""}`);
  };

  const provider = new JsonRpcProvider(o.rpcUrl, CHAIN, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN) throw new Error(`RPC is chain ${net.chainId}, not BSC testnet 97 — refusing.`);

  // ---- throwaway keystore -------------------------------------------------
  const work = mkdtempSync(join(tmpdir(), "dexe-e2e-approval-"));
  const ksDir = join(work, "keystore");
  const throwaway = Wallet.createRandom();
  const password = randomBytes(18).toString("base64url");
  writeKeystoreFile(ksDir, await encryptPrivateKey(throwaway.privateKey, password));
  log(`throwaway keystore: ${throwaway.address} (production scrypt params, password generated in memory)`);

  // ---- fund it --------------------------------------------------------------
  const funder = new Wallet(o.funderKey, provider);
  const [settings, userKeeper] = GOV_POOL.decodeFunctionResult(
    "getHelperContracts",
    await provider.call({ to: o.govPool, data: GOV_POOL.encodeFunctionData("getHelperContracts") }),
  ) as unknown as [string, string];
  void settings;
  const keeper = new Contract(userKeeper, ["function tokenAddress() view returns (address)"], provider);
  const tokenAddr = (await keeper.getFunction("tokenAddress").staticCall()) as string;
  const token = new Contract(tokenAddr, ERC20, provider);
  const decimals = Number(await token.getFunction("decimals").staticCall());
  const symbol = String(await token.getFunction("symbol").staticCall());
  log(`DAO ${o.govPool}: userKeeper ${userKeeper}, token ${symbol} ${tokenAddr}`);
  log(`funder ${funder.address}: ${formatEther(await provider.getBalance(funder.address))} tBNB`);

  // ~2.5M gas covers the five broadcasts below with room to spare.
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 1_000_000_000n;
  const gas = (() => {
    const need = gasPrice * 2_500_000n;
    return need < parseEther("0.0015") ? parseEther("0.0015") : need;
  })();
  let fundTxHash: string | undefined;
  for (const src of [{ label: "funder", key: o.funderKey }, ...o.tokenSources]) {
    const w = new Wallet(src.key, provider);
    const bal = await provider.getBalance(w.address);
    if (bal < gas + parseEther("0.0005")) {
      log(`  gas source ${src.label} ${w.address}: ${formatEther(bal)} tBNB — not enough`);
      continue;
    }
    const t = await w.sendTransaction({ to: throwaway.address, value: gas });
    await t.wait();
    fundTxHash = t.hash;
    log(`funded throwaway with ${formatEther(gas)} tBNB (gas price ${formatUnits(gasPrice, 9)} gwei) from ${src.label}: ${t.hash}`);
    break;
  }
  if (!fundTxHash) throw new Error("no configured testnet key can fund the throwaway with gas");

  const tokenNeed = 2n * 10n ** BigInt(decimals); // 1.0 vote (= minVotesForCreating on Kestrel) + headroom
  let tokenFundHash: string | undefined;
  for (const src of [{ label: "funder", key: o.funderKey }, ...o.tokenSources]) {
    const w = new Wallet(src.key, provider);
    const bal = (await token.getFunction("balanceOf").staticCall(w.address)) as bigint;
    if (bal < tokenNeed) {
      log(`  ${src.label} ${w.address} holds ${formatUnits(bal, decimals)} ${symbol} — not enough`);
      continue;
    }
    const nativeBal = await provider.getBalance(w.address);
    if (nativeBal < parseEther("0.0005")) {
      log(`  ${src.label} holds ${symbol} but no gas`);
      continue;
    }
    const t = (await (token.connect(w) as Contract).getFunction("transfer")(throwaway.address, tokenNeed)) as {
      hash: string;
      wait(): Promise<unknown>;
    };
    await t.wait();
    tokenFundHash = t.hash;
    log(`sent ${formatUnits(tokenNeed, decimals)} ${symbol} from ${src.label} (${w.address}): ${t.hash}`);
    break;
  }

  // ---- the server under test ----------------------------------------------
  const dist = resolve(o.repoRoot, "dist", "index.js");
  const emptyEnv = join(work, "empty.env");
  writeFileSync(emptyEnv, "\n");
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Nothing secret or DEXE-shaped from the caller's shell reaches the child.
    if (/^(DEXE_|AGENT_|SWARM_|E2E_)/.test(k) || /PRIVATE|_PK\b|_PK_|PASSWORD|JWT|SECRET/i.test(k)) continue;
    baseEnv[k] = v;
  }
  const childEnv = (waitMs: number): Record<string, string> => ({
    ...baseEnv,
    HOME: work,
    USERPROFILE: work,
    DEXE_ENV_FILE: emptyEnv,
    DEXE_SIGNER_MODE: "keystore",
    DEXE_KEYSTORE_PATH: ksDir,
    DEXE_APPROVAL_OPEN_BROWSER: "0",
    DEXE_APPROVAL_WAIT_MS: String(waitMs),
    DEXE_RPC_URL_TESTNET: o.rpcUrl,
    DEXE_DEFAULT_CHAIN_ID: "97",
    DEXE_STATE_PATH: join(work, "state.json"),
    ...(o.pinataJwt ? { DEXE_PINATA_JWT: o.pinataJwt } : {}),
    // IPFS read gateways: the composite merges the DAO's current profile, and
    // the shared public gateways rate-limit (HTTP 429).
    ...Object.fromEntries(
      ["DEXE_IPFS_GATEWAY", "DEXE_IPFS_GATEWAYS_FALLBACK", "DEXE_PINATA_GATEWAY_TOKEN"]
        .filter((k) => process.env[k]?.trim())
        .map((k) => [k, process.env[k]!.trim()]),
    ),
  });

  const amount = (human: string) => (BigInt(Math.round(Number(human) * 1e6)) * 10n ** BigInt(decimals)) / 1_000_000n;
  const buildApprove = async (srv: Server, human: string) => {
    const b = await srv.call("dexe_vote_build_erc20_approve", {
      token: tokenAddr,
      spender: userKeeper,
      amount: amount(human).toString(),
      govPool: o.govPool,
      chainId: CHAIN,
    });
    const payload = (b.structured?.payload ?? (b.json?.payload as Record<string, unknown> | undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!payload) throw new Error(`erc20_approve build failed: ${b.text.slice(0, 300)}`);
    return payload;
  };

  let ok = true;
  // ===== server A: DEXE_APPROVAL_WAIT_MS=0 — every call returns at once =====
  const a = new Server(dist, childEnv(0), work);
  await a.start();
  try {
    const ctx = await a.call("dexe_write_context", { includeAgentBalances: false, includeDepositedPower: false });
    const signer = (ctx.json?.signer ?? {}) as Record<string, unknown>;
    record(
      "write_context reports keystore mode",
      signer.mode === "keystore" && signer.humanConfirmation === true && signer.address === throwaway.address,
      `mode=${String(signer.mode)} address=${String(signer.address)}`,
    );

    // ---- 1. single tx, re-run path ---------------------------------------
    const p1 = await buildApprove(a, "0.5");
    const first = await a.call("dexe_tx_send", { payload: p1, chainId: CHAIN });
    const appr = (first.json?.approval ?? {}) as Record<string, string>;
    const pending1 = first.json?.mode === "awaiting_approval" && !!appr.url;
    record("1a tx_send → awaiting_approval (nothing signed)", pending1 && !first.isError, `fingerprint ${appr.fingerprint}`);
    const page = await rawRequest(appr.url!);
    record("1b page shows the same fingerprint", page.body.includes(appr.fingerprint!), "");
    const human = await approveAsHuman(appr.url!, password);
    record("1c owner approves with the password", human.status === 200, String(human.json().status));
    const st = await a.call("dexe_tx_approval_status", { approvalId: appr.approvalId });
    record("1d dexe_tx_approval_status = approved", st.json?.status === "approved", "");
    const rerun = await a.call("dexe_tx_send", { payload: p1, chainId: CHAIN });
    const h1 = String(rerun.json?.txHash ?? "");
    record(
      "1e re-run broadcasts with the keystore",
      !rerun.isError && rerun.json?.signer === "keystore" && rerun.json?.status === 1 && /^0x[0-9a-f]{64}$/i.test(h1),
      `status=${String(rerun.json?.status)}`,
      h1 ? [h1] : [],
    );
    const st2 = await a.call("dexe_tx_approval_status", { approvalId: appr.approvalId });
    record("1f approval consumed (single use)", st2.json?.status === "consumed", "");

    // ---- 3. decline ---------------------------------------------------------
    const nonceBefore3 = await provider.getTransactionCount(throwaway.address);
    const p3 = await buildApprove(a, "0.25");
    const d1 = await a.call("dexe_tx_send", { payload: p3, chainId: CHAIN });
    const dAppr = (d1.json?.approval ?? {}) as Record<string, string>;
    const dec = await declineAsHuman(dAppr.url!);
    const d2 = await a.call("dexe_tx_send", { payload: p3, chainId: CHAIN });
    const nonceAfter3 = await provider.getTransactionCount(throwaway.address);
    record(
      "3  decline → declined result, same batch refused without a new page, nothing signed",
      dec.json().status === "declined" &&
        d2.isError &&
        d2.json?.mode === "declined" &&
        d2.json?.approvalId === dAppr.approvalId &&
        nonceAfter3 === nonceBefore3,
      `message="${String(d2.json?.message)}" nonce ${nonceBefore3}→${nonceAfter3}`,
    );

    // ---- 4. deviation -----------------------------------------------------
    const nonceBefore4 = await provider.getTransactionCount(throwaway.address);
    const p4 = await buildApprove(a, "0.3");
    const e1 = await a.call("dexe_tx_send", { payload: p4, chainId: CHAIN });
    const eAppr = (e1.json?.approval ?? {}) as Record<string, string>;
    await approveAsHuman(eAppr.url!, password);
    const tampered = await buildApprove(a, "0.31");
    const e2 = await a.call("dexe_tx_send", { payload: tampered, chainId: CHAIN });
    const e2Appr = (e2.json?.approval ?? {}) as Record<string, string>;
    const stillApproved = await a.call("dexe_tx_approval_status", { approvalId: eAppr.approvalId });
    const nonceAfter4 = await provider.getTransactionCount(throwaway.address);
    record(
      "4  tampered call is not covered by the approval: new approval asked, nothing signed",
      e2.json?.mode === "awaiting_approval" &&
        e2Appr.approvalId !== eAppr.approvalId &&
        e2Appr.fingerprint !== eAppr.fingerprint &&
        stillApproved.json?.status === "approved" &&
        nonceAfter4 === nonceBefore4,
      `approved ${eAppr.fingerprint} vs tampered ${e2Appr.fingerprint}; nonce ${nonceBefore4}→${nonceAfter4}`,
    );

    // ---- 5. global lockout + approval caps (security review fix 1) --------
    // Wrong guesses spread over several fresh approvals add up to ONE lockout,
    // after which even the right password is refused; a further approval is
    // refused outright (≤ 3 waiting, ≤ 6 created per minute).
    const nonceBefore5 = await provider.getTransactionCount(throwaway.address);
    const l1 = await a.call("dexe_tx_send", { payload: await buildApprove(a, "0.41"), chainId: CHAIN });
    const l2 = await a.call("dexe_tx_send", { payload: await buildApprove(a, "0.42"), chainId: CHAIN });
    const u1 = String((l1.json?.approval as Record<string, string> | undefined)?.url ?? "");
    const u2 = String((l2.json?.approval as Record<string, string> | undefined)?.url ?? "");
    const guesses = [e2Appr.url!, e2Appr.url!, u1, u1, u2];
    const codes: number[] = [];
    for (const u of guesses) codes.push((await approveAsHuman(u, "not-the-password")).status);
    const right = await approveAsHuman(u2, password);
    const extra = await a.call("dexe_tx_send", { payload: await buildApprove(a, "0.43"), chainId: CHAIN });
    const nonceAfter5 = await provider.getTransactionCount(throwaway.address);
    record(
      "5  global lockout across approvals: 5 guesses on 3 pages → right password refused (429); 4th approval refused",
      codes.every((c) => c === 401) &&
        right.status === 429 &&
        extra.isError &&
        extra.json?.mode === "approval_refused" &&
        nonceAfter5 === nonceBefore5,
      `guesses ${codes.join(",")} → right password ${right.status}; extra call mode=${String(extra.json?.mode)}; nonce ${nonceBefore5}→${nonceAfter5}`,
    );
  } finally {
    await a.close();
  }

  // ===== server C: what the page SAYS about dangerous batches (nothing is signed) =====
  // 6a. approve(KRT → a plain wallet): the spender check must render DANGER.
  // 6b. GovPool.deposit calldata sent to WBNB (has code, accepts any calldata
  //     via its fallback, is no DeXe contract): DANGER "NOT a registered DeXe
  //     contract", and the call is shown WITHOUT the "GovPool." prefix.
  const c = new Server(dist, childEnv(0), work);
  await c.start();
  try {
    const eoa = Wallet.createRandom().address;
    const approveEoa = new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [eoa, 1n]);
    const r6a = await c.call("dexe_tx_send", { to: tokenAddr, data: approveEoa, chainId: CHAIN });
    const u6a = String((r6a.json?.approval as Record<string, string> | undefined)?.url ?? "");
    const page6a = u6a ? (await rawRequest(u6a)).body : "";
    record(
      "6a page renders DANGER for an approval to a plain wallet",
      /risk r-danger[^<]*NO contract code/.test(page6a),
      u6a ? "danger row present" : `no page: ${r6a.text.slice(0, 160)}`,
    );
    if (u6a) await declineAsHuman(u6a);

    const WBNB_97 = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
    const wbnbCode = await provider.getCode(WBNB_97);
    if (/^0x0*$/i.test(wbnbCode)) {
      record("6b page renders DANGER for a DeXe call on a non-DeXe contract", false, "WBNB has no code on 97 — skipped");
    } else {
      const deposit = new Interface(["function deposit(uint256 amount, uint256[] nftIds)"]).encodeFunctionData("deposit", [1n, []]);
      const r6b = await c.call("dexe_tx_send", { to: WBNB_97, data: deposit, chainId: CHAIN });
      const u6b = String((r6b.json?.approval as Record<string, string> | undefined)?.url ?? "");
      const page6b = u6b ? (await rawRequest(u6b)).body : "";
      record(
        "6b page renders DANGER for a DeXe call on a non-DeXe contract, without the GovPool. prefix",
        /risk r-danger[^<]*NOT a registered DeXe contract/.test(page6b) && !/GovPool\.deposit/.test(page6b) && /<code>deposit\(/.test(page6b),
        u6b ? "danger row present; call shown as deposit(…)" : `no page: ${r6b.text.slice(0, 160)}`,
      );
      if (u6b) await declineAsHuman(u6b);
    }
  } finally {
    await c.close();
  }

  // ===== server B: blocking — the call waits while the owner approves =====
  const b = new Server(dist, childEnv(240_000), work);
  await b.start();
  try {
    if (!tokenFundHash) {
      record("2  proposal_create on Kestrel", false, `no source held 2 ${symbol} — skipped (fund the throwaway with the DAO token)`);
    } else if (!o.pinataJwt) {
      record("2  proposal_create on Kestrel", false, "DEXE_PINATA_JWT not in the environment — metadata cannot be pinned");
    } else {
      let approvedFromProgress = false;
      const progressUrls: string[] = [];
      const call = b.call(
        "dexe_proposal_create",
        {
          govPool: o.govPool,
          chainId: CHAIN,
          proposalType: "modify_dao_profile",
          title: `Keystore approval check ${new Date().toISOString().slice(0, 16)}`,
          description: "Approval-page regression: one owner approval for the approve, deposit and create batch.",
          newDaoDescription: "Keystore approval regression marker.",
          voteAmount: "1.0",
        },
        (msg) => {
          const m = /(http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]+)/.exec(msg);
          if (m && !progressUrls.includes(m[1]!)) {
            progressUrls.push(m[1]!);
            void approveAsHuman(m[1]!, password).then((r) => {
              approvedFromProgress = approvedFromProgress || r.status === 200;
            });
          }
        },
      );
      const res = await call;
      const stepsOut = ((res.json?.steps ?? []) as Array<{ label: string; txHash?: string }>).filter((s) => s.txHash);
      const hashes = stepsOut.map((s) => s.txHash!);
      const sig = (res.json?.signer ?? {}) as Record<string, unknown>;
      record(
        "2  proposal_create: one approval (from the progress notification) for the whole batch",
        !res.isError && res.json?.mode === "executed" && approvedFromProgress && progressUrls.length === 1 && sig.signerKey === "keystore",
        `proposalId=${String(res.json?.proposalId)} txs=${hashes.length} (${stepsOut.map((s) => s.label.split("(")[0]).join(" → ")})`,
        hashes,
      );
      if (res.isError || res.json?.mode !== "executed") log(res.text.slice(0, 1500));
    }
  } finally {
    await b.close();
  }

  ok = steps.every((s) => s.ok);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows may hold the dir briefly */
  }
  return { ok, throwaway: throwaway.address, steps };
}
