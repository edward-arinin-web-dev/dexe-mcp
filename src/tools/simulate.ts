import { z } from "zod";
import { Interface, ZeroAddress, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteToolContext } from "./writeContext.js";
import { SignerManager } from "../lib/signer.js";
import { RpcProvider } from "../rpc.js";
import { chainIdParam, govPoolParam, PROPOSAL_ID_DESC } from "../lib/params.js";
import { safeErrorMessage } from "../lib/redact.js";
import { simulateCalldata, decodeRevert } from "../lib/simulate.js";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ---------- ABI fragments ----------

const GOV_POOL_ABI = new Interface([
  "function getProposalState(uint256 proposalId) view returns (uint8)",
  "function execute(uint256 proposalId)",
]);

const TOKEN_SALE_ABI = new Interface([
  "function buy(uint256 tierId, address tokenToBuyWith, uint256 amount, bytes32[] proof) payable",
]);

const ERC20_ABI = new Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// Source of truth for proposal states; index 4 is SucceededFor (executable).
const PROPOSAL_STATES = [
  "Voting",
  "WaitingForVotingTransfer",
  "ValidatorVoting",
  "Defeated",
  "SucceededFor",
  "SucceededAgainst",
  "Locked",
  "ExecutedFor",
  "ExecutedAgainst",
  "Undefined",
] as const;

// ---------- helpers ----------

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, bigintReplacer, 2) }],
  };
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

// ---------- register ----------

export function registerSimulateTools(
  server: McpServer,
  ctx: WriteToolContext,
  signer: SignerManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_sim_calldata
  // =============================================
  server.tool(
    "dexe_sim_calldata",
    "Read-only. Preflights any tx via eth_call against live state: success / revertReason / " +
      "gasEstimate, no gas spent. Decodes Error(string) and Panic(uint256) payloads.",
    {
      to: z.string().describe("Destination contract address (TxPayload.to)."),
      data: z.string().describe("ABI-encoded calldata, 0x-prefixed (TxPayload.data)."),
      value: z.string().optional().describe("wei, decimal string"),
      from: z
        .string()
        .optional()
        .describe("Caller address override; defaults to active signer or zero address."),
      blockTag: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Block tag for eth_call (default: 'latest')."),
      chainId: chainIdParam,
    },
    async (input) => {
      try {
        if (!isAddress(input.to)) return err(`Invalid to: ${input.to}`);
        const fromResolved =
          input.from ??
          (signer.hasSigner() ? signer.getAddress() : ZeroAddress);
        const result = await simulateCalldata(rpc, {
          to: getAddress(input.to),
          data: input.data,
          value: input.value,
          from: fromResolved,
          blockTag: input.blockTag,
          chainId: input.chainId,
        });
        return ok({ ...result, from: fromResolved });
      } catch (e) {
        return err(safeErrorMessage(e));
      }
    },
  );

  // =============================================
  // dexe_sim_proposal
  // =============================================
  server.tool(
    "dexe_sim_proposal",
    "Read-only. Simulates GovPool.execute(proposalId) against live state; refuses unless the " +
      "proposal is `SucceededFor` (idx 4). Finds a reverting action before you pay gas.",
    {
      govPool: govPoolParam,
      proposalId: z.string().describe(PROPOSAL_ID_DESC),
      from: z.string().optional().describe("Caller address override; defaults to active signer or zero address."),
      chainId: chainIdParam,
    },
    async (input) => {
      try {
        if (!isAddress(input.govPool)) return err(`Invalid govPool: ${input.govPool}`);
        const pr0 = rpc.tryProvider(input.chainId);
  if ("error" in pr0) return errorResult(`${pr0.error}\n${pr0.remediation}`);
  const provider = pr0.ok;
        const govAddr = getAddress(input.govPool);
        const proposalIdBn = BigInt(input.proposalId);

        // Read current state.
        const stateData = GOV_POOL_ABI.encodeFunctionData("getProposalState", [
          proposalIdBn,
        ]);
        let stateIndex: number;
        try {
          const ret = await provider.call({ to: govAddr, data: stateData });
          stateIndex = Number(
            GOV_POOL_ABI.decodeFunctionResult("getProposalState", ret)[0],
          );
        } catch (e) {
          const decoded = decodeRevert(e);
          return err(
            `getProposalState reverted: ${decoded.revertReason}. Proposal may not exist on this GovPool.`,
          );
        }
        const proposalState = PROPOSAL_STATES[stateIndex] ?? `Unknown(${stateIndex})`;

        if (stateIndex !== 4) {
          return ok({
            success: false,
            revertReason: `Proposal state is '${proposalState}' (idx ${stateIndex}); execute() requires 'SucceededFor' (idx 4).`,
            proposalState,
            proposalStateIndex: stateIndex,
          });
        }

        const fromResolved =
          input.from ??
          (signer.hasSigner() ? signer.getAddress() : ZeroAddress);

        const data = GOV_POOL_ABI.encodeFunctionData("execute", [proposalIdBn]);
        const result = await simulateCalldata(rpc, {
          to: govAddr,
          data,
          from: fromResolved,
          chainId: input.chainId,
        });

        return ok({
          ...result,
          proposalState,
          proposalStateIndex: stateIndex,
          from: fromResolved,
        });
      } catch (e) {
        return err(safeErrorMessage(e));
      }
    },
  );

  // =============================================
  // dexe_sim_buy
  // =============================================
  server.tool(
    "dexe_sim_buy",
    "Read-only. Simulates TokenSaleProposal.buy(tierId, paymentToken, amount, proof). Native path " +
      "(0x0) sets value = amount; ERC20 path reads allowance and flags `willNeedApprove` when it is " +
      "below `amount`.",
    {
      tokenSaleProposal: z.string().describe("TokenSaleProposal helper contract address."),
      tierId: z.string().describe("Tier id on that sale, decimal string."),
      tokenToBuyWith: z.string().describe("Payment token; 0x0 sentinel for native BNB"),
      amount: z.string().describe("amount in wei"),
      proof: z.array(z.string()).default([]).describe("Merkle proof for a merkle-gated tier; [] when not gated."),
      from: z.string().optional().describe("Caller address override; defaults to active signer or zero address."),
      chainId: chainIdParam,
    },
    async (input) => {
      try {
        if (!isAddress(input.tokenSaleProposal))
          return err(`Invalid tokenSaleProposal`);
        if (!isAddress(input.tokenToBuyWith))
          return err(`Invalid tokenToBuyWith`);

        const tspAddr = getAddress(input.tokenSaleProposal);
        const paymentAddr = getAddress(input.tokenToBuyWith);
        const native = paymentAddr.toLowerCase() === ZeroAddress.toLowerCase();
        const tierIdBn = BigInt(input.tierId);
        const amountBn = BigInt(input.amount);
        const fromResolved =
          input.from ??
          (signer.hasSigner() ? signer.getAddress() : ZeroAddress);

        // ERC20 path — read current allowance to flag approve-needed.
        let willNeedApprove: boolean | undefined;
        if (!native) {
          try {
            const pr0 = rpc.tryProvider(input.chainId);
  if ("error" in pr0) return errorResult(`${pr0.error}\n${pr0.remediation}`);
  const provider = pr0.ok;
            const allowanceData = ERC20_ABI.encodeFunctionData("allowance", [
              fromResolved,
              tspAddr,
            ]);
            const ret = await provider.call({
              to: paymentAddr,
              data: allowanceData,
            });
            const allowance = BigInt(
              ERC20_ABI.decodeFunctionResult("allowance", ret)[0],
            );
            willNeedApprove = allowance < amountBn;
          } catch {
            // Non-ERC20 token or RPC blip — leave undefined, don't fail the sim.
          }
        }

        const data = TOKEN_SALE_ABI.encodeFunctionData("buy", [
          tierIdBn,
          paymentAddr,
          amountBn,
          input.proof,
        ]);
        const result = await simulateCalldata(rpc, {
          to: tspAddr,
          data,
          value: native ? amountBn.toString() : undefined,
          from: fromResolved,
          chainId: input.chainId,
        });

        return ok({
          ...result,
          native,
          ...(willNeedApprove !== undefined ? { willNeedApprove } : {}),
          from: fromResolved,
        });
      } catch (e) {
        return err(safeErrorMessage(e));
      }
    },
  );
}

// The simulation core lives in src/lib/simulate.ts; re-exported so existing
// importers keep working.
export { simulateCalldata, decodeRevert } from "../lib/simulate.js";
export type { SimCalldataInput, SimCalldataResult } from "../lib/simulate.js";
