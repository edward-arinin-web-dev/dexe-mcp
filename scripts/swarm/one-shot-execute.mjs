#!/usr/bin/env node
// One-shot: execute proposal on a Gov pool using AGENT_PK_1.
// Usage: node scripts/swarm/one-shot-execute.mjs <govPool> <proposalId>
import { JsonRpcProvider, Contract, Wallet, Interface } from "ethers";
process.loadEnvFile?.();

const [, , gov, pidStr] = process.argv;
if (!gov || !pidStr) {
  console.error("usage: one-shot-execute.mjs <govPool> <proposalId>");
  process.exit(1);
}
const RPC = (process.env.SWARM_RPC_URL_TESTNET ?? process.env.DEXE_RPC_URL ?? "").trim();
const PK = (process.env.AGENT_PK_1 ?? "").trim();
if (!RPC || !PK) {
  console.error("missing SWARM_RPC_URL_TESTNET or AGENT_PK_1");
  process.exit(2);
}
const NAMES = ["Voting","WaitingForVotingTransfer","ValidatorVoting","Defeated","SucceededFor","SucceededAgainst","Locked","ExecutedFor","ExecutedAgainst","Undefined"];
const ABI = ["function getProposalState(uint256) view returns (uint8)", "function execute(uint256)"];

const p = new JsonRpcProvider(RPC);
const w = new Wallet(PK, p);
const c = new Contract(gov, ABI, w);
const before = Number(await c.getProposalState(BigInt(pidStr)));
console.log(`state before: ${NAMES[before]} (${before})`);
process.stdout.write("");
if (![4, 5, 6].includes(before)) {
  console.log("not executable; exiting.");
  process.exit(0);
}
const iface = new Interface(["function execute(uint256)"]);
const data = iface.encodeFunctionData("execute", [BigInt(pidStr)]);
const nonce = await p.getTransactionCount(w.address, "pending");
const fee = await p.getFeeData();
console.log(`nonce=${nonce} gasPrice=${fee.gasPrice}`);
process.stdout.write("");
const tx = await w.sendTransaction({ to: gov, data, gasLimit: 1_500_000n, nonce, gasPrice: fee.gasPrice });
console.log(`HASH: ${tx.hash}`);
process.stdout.write("");
const r = await Promise.race([
  tx.wait(),
  new Promise((_, rj) => setTimeout(() => rj(new Error("wait timeout 90s")), 90_000)),
]);
console.log(`status=${r.status} block=${r.blockNumber}`);
const after = Number(await c.getProposalState(BigInt(pidStr)));
console.log(`state after: ${NAMES[after]} (${after})`);
