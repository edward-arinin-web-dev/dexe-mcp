#!/usr/bin/env node
/**
 * v0.22.0 testnet E2E — drives the BUILT server (dist/index.js) over stdio as
 * a real MCP client, exactly like Claude Code would. Chain 97 only.
 *
 * Golden path: dao_create preview → confirm (broadcast) → token_transfer
 * proposal (human units, auto-vote) → vote_and_execute (auto path) → forced
 * revert (transfer > treasury) must surface as failure → OTC open_sale on the
 * fresh DAO (proves executor auto-wiring) → vote_and_execute → buyer_buy
 * (native) → buyer_status. Plus: enum rejection, chainId reads, context
 * toolset report.
 *
 * Run: node scripts/e2e-testnet.mjs   (needs .env with testnet RPC + key + Pinata)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import process from "node:process";

const CHAIN = 97;
const CALL_TIMEOUT = { timeout: 420_000 };
const results = [];
let failures = 0;

function record(step, ok, note = "") {
  results.push({ step, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${step}${note ? ` — ${note}` : ""}`);
  if (!ok) failures++;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "e2e-testnet", version: "0.0.1" });
await client.connect(transport);

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, CALL_TIMEOUT);
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { isError: !!r.isError, text, json: parseJson(text) };
  } catch (e) {
    return { isError: true, text: String(e?.message ?? e), json: null, threw: true };
  }
}

// ---------- 1. surface sanity ----------
const tools = await client.listTools();
record("tools/list", tools.tools.length === 72, `${tools.tools.length} tools (expected 72 default)`);

const sv = client.getServerVersion?.();
record("handshake version is real package version", sv?.version === "0.22.0", `got ${sv?.version}`);

const ctx = await call("dexe_context", { includeDepositedPower: false });
const toolsets = ctx.json?.env?.toolsets;
record(
  "dexe_context reports hidden toolsets + unlocks",
  !ctx.isError && Array.isArray(toolsets?.hidden) && toolsets.hidden.length >= 3 && !!toolsets.enableHint,
  `hidden: ${toolsets?.hidden?.map((h) => h.set).join(",")}`,
);

// ---------- 2. enum rejection ----------
const badType = await call("dexe_proposal_create", {
  govPool: "0x081f4b5C88325fBdA757F31b86a15cD3a7DEaEFe",
  title: "x",
  proposalType: "definitely_not_a_type",
  chainId: CHAIN,
});
record(
  "unknown proposalType rejected at validation",
  badType.isError && /invalid|enum|expected one of|Invalid enum/i.test(badType.text),
  badType.text.slice(0, 100).replace(/\n/g, " "),
);

// ---------- 3. chainId reads ----------
const polaris = "0x081f4b5C88325fBdA757F31b86a15cD3a7DEaEFe";
const info97 = await call("dexe_dao_info", { govPool: polaris, chainId: CHAIN });
record("dexe_dao_info honors chainId:97", !info97.isError, info97.isError ? info97.text.slice(0, 120) : "ok");
const st97 = await call("dexe_proposal_state", { govPool: polaris, proposalId: 1, chainId: CHAIN });
record("dexe_proposal_state honors chainId:97", !st97.isError, st97.isError ? st97.text.slice(0, 120) : "ok");

// ---------- 4. dao_create preview → confirm ----------
const daoName = `Aurora Ridge Collective ${Date.now() % 100000}`;
const simpleArgs = {
  daoName,
  symbol: "ARC",
  totalSupply: "1000000",
  chainId: CHAIN,
  daoDescription: "Community treasury collective for the Aurora Ridge initiative.",
};
const preview = await call("dexe_dao_create", simpleArgs);
record(
  "dao_create SIMPLE returns preview with safety proof",
  !preview.isError && preview.json?.mode === "preview" && preview.json?.safetyProof?.quorumReachable === true,
  `mode=${preview.json?.mode}`,
);

const deploy = await call("dexe_dao_create", { ...simpleArgs, confirm: true });
const govPool = deploy.json?.predictedGovPool;
const govToken = deploy.json?.predicted?.govToken;
const tokenSale = deploy.json?.predicted?.govTokenSale;
record(
  "dao_create confirm broadcasts + mines",
  !deploy.isError && deploy.json?.mode === "executed" && !!govPool,
  `govPool=${govPool} txs=${deploy.json?.steps?.filter((s) => s.txHash).length}`,
);
if (!govPool) {
  console.log(deploy.text.slice(0, 800));
  process.exit(finish());
}

// ---------- 5. token_transfer proposal (human units) ----------
// Signer address comes from the server's own context — the parent process
// never loads .env (only the spawned server does).
const signerAddr = ctx.json?.signer?.address;
const p1 = await call("dexe_proposal_create", {
  govPool,
  chainId: CHAIN,
  title: "Grant 10.5 ARC to operations",
  description: "Operational grant from treasury.",
  proposalType: "token_transfer",
  params: { token: govToken, recipient: signerAddr, amount: "10.5" },
});
record(
  "proposal_create token_transfer (human units '10.5') broadcasts",
  !p1.isError && p1.json?.mode === "executed",
  p1.isError ? p1.text.slice(0, 300).replace(/\n/g, " ") : `steps=${p1.json?.steps?.length}`,
);

// ---------- 6. vote_and_execute proposal 1 (auto path) ----------
const ve1 = await call("dexe_proposal_vote_and_execute", { govPool, chainId: CHAIN, proposalId: 1 });
record(
  "vote_and_execute #1 (auto-deposit/auto-execute path)",
  !ve1.isError && (ve1.json?.executed === true || ve1.json?.mode === "executed"),
  ve1.isError ? ve1.text.slice(0, 300).replace(/\n/g, " ") : `stateBefore=${ve1.json?.proposalStateBefore}`,
);

// ---------- 7. forced revert must read as FAILURE ----------
const p2 = await call("dexe_proposal_create", {
  govPool,
  chainId: CHAIN,
  title: "Overdraw treasury (must revert at execute)",
  proposalType: "token_transfer",
  params: { token: govToken, recipient: signerAddr, amount: "900000000.0" },
});
let revertChecked = false;
if (!p2.isError && p2.json?.mode === "executed") {
  const ve2 = await call("dexe_proposal_vote_and_execute", { govPool, chainId: CHAIN, proposalId: 2 });
  const failedProperly =
    (ve2.isError || ve2.json?.mode === "failed") && /REVERT|failed/i.test(ve2.text);
  record("overdraw execute surfaces as failure (R3) with ledger", failedProperly, ve2.text.slice(0, 200).replace(/\n/g, " "));
  revertChecked = true;
}
if (!revertChecked) {
  record(
    "overdraw proposal creation (pre-step)",
    !p2.isError,
    p2.text.slice(0, 200).replace(/\n/g, " "),
  );
}

// ---------- 8. OTC on the FRESH DAO (proves executor auto-wiring) ----------
const now = Math.floor(Date.now() / 1000);
const sale = await call("dexe_otc_dao_open_sale", {
  govPool,
  chainId: CHAIN,
  tokenSaleProposal: tokenSale,
  proposalName: "ARC community round",
  tiers: [
    {
      name: "Community tier",
      description: "Open tier, native BNB",
      totalTokenProvided: "1000000000000000000000",
      saleStartTime: String(now + 60),
      saleEndTime: String(now + 86400),
      saleTokenAddress: govToken,
      purchaseTokenAddresses: ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"],
      purchaseRatios: ["0.0001"],
      minAllocationPerUser: "0",
      maxAllocationPerUser: "500000000000000000000",
      vestingSettings: { vestingPercentage: "0", vestingDuration: "0", cliffPeriod: "0", unlockStep: "0" },
      participation: [],
    },
  ],
});
record(
  "otc_dao_open_sale on fresh dao_create DAO (executor wiring)",
  !sale.isError && sale.json?.mode === "executed",
  sale.isError ? sale.text.slice(0, 300).replace(/\n/g, " ") : "sale proposal broadcast",
);

if (!sale.isError && sale.json?.mode === "executed") {
  // sale proposal id: 2 if overdraw creation failed, else 3
  const saleId = revertChecked ? 3 : 2;
  const ve3 = await call("dexe_proposal_vote_and_execute", { govPool, chainId: CHAIN, proposalId: saleId });
  record(
    `vote_and_execute sale proposal #${saleId}`,
    !ve3.isError && (ve3.json?.executed === true || ve3.json?.mode === "executed"),
    ve3.isError ? ve3.text.slice(0, 300).replace(/\n/g, " ") : `stateBefore=${ve3.json?.proposalStateBefore}`,
  );

  if (!ve3.isError) {
    // wait for saleStartTime (+60s buffer set above)
    const waitMs = (now + 65) * 1000 - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const buy = await call("dexe_otc_buyer_buy", {
      tokenSaleProposal: tokenSale,
      chainId: CHAIN,
      tierId: "1",
      tokenToBuyWith: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      amount: "0.001",
    });
    record(
      "otc_buyer_buy native 0.001 (human units)",
      !buy.isError && buy.json?.mode === "executed",
      buy.isError ? buy.text.slice(0, 300).replace(/\n/g, " ") : "bought",
    );

    const status = await call("dexe_otc_buyer_status", {
      tokenSaleProposal: tokenSale,
      chainId: CHAIN,
      tierIds: ["1"],
      user: signerAddr,
    });
    record("otc_buyer_status (chainId param)", !status.isError, status.isError ? status.text.slice(0, 160) : "ok");
  }
}

function finish() {
  console.log("\n================ E2E SUMMARY ================");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}${r.note ? ` — ${r.note}` : ""}`);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  return failures === 0 ? 0 : 1;
}

const code = finish();
await client.close();
process.exit(code);
