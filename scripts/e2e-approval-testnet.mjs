#!/usr/bin/env node
/**
 * Keystore-approval E2E on BSC testnet 97 — runner for tests/e2e/approval/harness.ts.
 *
 *   npm run build && node scripts/e2e-approval-testnet.mjs
 *
 * Environment (read here, never printed):
 *   E2E_ENV_FILE        optional .env to load first (e.g. the swarm .env); its values
 *                       never override variables already set
 *   E2E_FUNDER_PK       funded testnet key; default AGENT_PK_8 (the swarm pool)
 *   E2E_GOV_POOL        default: the swarm fixture DAO Kestrel on 97
 *   SWARM_RPC_URL_TESTNET / DEXE_RPC_URL_TESTNET   default: public BSC testnet RPC
 *   DEXE_PINATA_JWT     needed for the proposal_create scenario (metadata pin)
 *
 * Chain 97 only. NOT shipped in the npm package.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.E2E_ENV_FILE && existsSync(process.env.E2E_ENV_FILE)) {
  process.loadEnvFile(process.env.E2E_ENV_FILE);
}
register();
const { runApprovalE2E } = await import("../tests/e2e/approval/harness.ts");

const funderKey = (process.env.E2E_FUNDER_PK ?? process.env.AGENT_PK_8 ?? "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(funderKey)) {
  console.error("Set E2E_FUNDER_PK (or AGENT_PK_8) to a funded BSC-testnet key.");
  process.exit(2);
}
// Fallback gas / DAO-token sources, tried in order after the funder.
const tokenSources = [];
const funderPool = process.env.AGENT_FUNDER_PK?.trim();
if (funderPool && /^0x[0-9a-fA-F]{64}$/.test(funderPool)) tokenSources.push({ label: "AGENT_FUNDER_PK", key: funderPool });
for (let n = 1; n <= 7; n++) {
  const k = process.env[`AGENT_PK_${n}`]?.trim();
  if (k && /^0x[0-9a-fA-F]{64}$/.test(k)) tokenSources.push({ label: `AGENT_PK_${n}`, key: k });
}

const res = await runApprovalE2E({
  repoRoot: root,
  govPool: process.env.E2E_GOV_POOL ?? "0xb0Ca396b0441630A6506a1A2bA14dAbF0BD32145",
  rpcUrl:
    process.env.SWARM_RPC_URL_TESTNET?.trim() ||
    process.env.DEXE_RPC_URL_TESTNET?.trim() ||
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  funderKey,
  tokenSources,
  pinataJwt: process.env.DEXE_PINATA_JWT?.trim() || undefined,
});

console.log("");
console.log(`${res.ok ? "ALL PASS" : "FAILURES"} — ${res.steps.filter((s) => s.ok).length}/${res.steps.length} (throwaway ${res.throwaway})`);
for (const s of res.steps) for (const h of s.txHashes) console.log(`  ${s.name.split(" ")[0]}  https://testnet.bscscan.com/tx/${h}`);
process.exit(res.ok ? 0 : 1);
