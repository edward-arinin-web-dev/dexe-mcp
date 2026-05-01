import { z } from "zod";
import { Interface, ZeroAddress, isAddress, getAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { SignerManager } from "../lib/signer.js";
import { RpcProvider } from "../rpc.js";

// ---------- ABI fragments ----------

const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string)
const PANIC_SELECTOR = "0x4e487b71"; // Panic(uint256)

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

/** Pull the revert reason out of an ethers v6 CallException-shaped error. */
function decodeRevert(error: unknown): {
  revertReason: string;
  returnData?: string;
} {
  const e = error as {
    data?: string;
    info?: { error?: { data?: string } };
    error?: { data?: string };
    shortMessage?: string;
    reason?: string;
    message?: string;
  };
  // Try common shapes for the raw return data.
  const data: string | undefined =
    e?.data ?? e?.info?.error?.data ?? e?.error?.data;

  if (typeof data === "string" && data.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      const decoded = new Interface([
        "function Error(string)",
      ]).decodeFunctionData("Error", data);
      return { revertReason: String(decoded[0]), returnData: data };
    } catch {
      // fall through to message-based decode
    }
  }
  if (typeof data === "string" && data.startsWith(PANIC_SELECTOR)) {
    try {
      const decoded = new Interface([
        "function Panic(uint256)",
      ]).decodeFunctionData("Panic", data);
      return {
        revertReason: `Panic(0x${BigInt(decoded[0]).toString(16)})`,
        returnData: data,
      };
    } catch {
      // fall through
    }
  }

  const msg = e?.shortMessage ?? e?.reason ?? e?.message ?? String(error);
  return { revertReason: msg, ...(data ? { returnData: data } : {}) };
}

// ---------- shared sim core ----------

interface SimCalldataInput {
  to: string;
  data: string;
  value?: string;
  from?: string;
  blockTag?: string | number;
}

interface SimCalldataResult {
  success: boolean;
  revertReason?: string;
  returnData?: string;
  gasEstimate?: string;
}

async function simulateCalldata(
  rpc: RpcProvider,
  input: SimCalldataInput,
): Promise<SimCalldataResult> {
  const provider = rpc.requireProvider();
  const blockTag = input.blockTag ?? "latest";
  const tx = {
    to: input.to,
    data: input.data,
    ...(input.value ? { value: BigInt(input.value) } : {}),
    ...(input.from ? { from: input.from } : {}),
    blockTag,
  };

  const result: SimCalldataResult = { success: false };

  try {
    const returnData = await provider.call(tx);
    result.success = true;
    result.returnData = returnData;
  } catch (e) {
    const decoded = decodeRevert(e);
    result.revertReason = decoded.revertReason;
    if (decoded.returnData) result.returnData = decoded.returnData;
    return result;
  }

  // Only run estimateGas if the call succeeded — otherwise it'd just re-revert.
  try {
    const gas = await provider.estimateGas(tx);
    result.gasEstimate = gas.toString();
  } catch {
    // estimateGas can fail even when call succeeds (e.g. balance issues for
    // value-bearing tx with from=0x0). Leave undefined.
  }

  return result;
}

// ---------- register ----------

export function registerSimulateTools(
  server: McpServer,
  ctx: ToolContext,
  signer: SignerManager,
): void {
  const rpc = new RpcProvider(ctx.config);

  // =============================================
  // dexe_sim_calldata
  // =============================================
  server.tool(
    "dexe_sim_calldata",
    "Preflight any tx via eth_call against live state with optional caller override. " +
      "Returns success/revertReason/gasEstimate without spending gas. Decodes Error(string) " +
      "and Panic(uint256) revert payloads when the node returns them.",
    {
      to: z.string(),
      data: z.string(),
      value: z.string().optional().describe("wei, decimal string"),
      from: z
        .string()
        .optional()
        .describe("Caller address override; defaults to active signer or zero address."),
      blockTag: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Block tag for eth_call (default: 'latest')."),
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
        });
        return ok({ ...result, from: fromResolved });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // =============================================
  // dexe_sim_proposal
  // =============================================
  server.tool(
    "dexe_sim_proposal",
    "Simulate GovPool.execute(proposalId) against live state. Reads the proposal state " +
      "first; refuses to sim unless it is `SucceededFor` (idx 4). Useful before paying gas " +
      "to find out the underlying action would revert.",
    {
      govPool: z.string(),
      proposalId: z.string(),
      from: z.string().optional(),
    },
    async (input) => {
      try {
        if (!isAddress(input.govPool)) return err(`Invalid govPool: ${input.govPool}`);
        const provider = rpc.requireProvider();
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
        });

        return ok({
          ...result,
          proposalState,
          proposalStateIndex: stateIndex,
          from: fromResolved,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // =============================================
  // dexe_sim_buy
  // =============================================
  server.tool(
    "dexe_sim_buy",
    "Simulate TokenSaleProposal.buy(tierId, paymentToken, amount, proof) against live state. " +
      "Native path (paymentToken == 0x0) sets value = amount. ERC20 path also reads the caller's " +
      "current allowance and reports `willNeedApprove: true` when allowance < amount, so callers " +
      "know the broadcast will need an approve prepended.",
    {
      tokenSaleProposal: z.string(),
      tierId: z.string(),
      tokenToBuyWith: z.string().describe("Payment token; 0x0 sentinel for native BNB"),
      amount: z.string().describe("amount in wei"),
      proof: z.array(z.string()).default([]),
      from: z.string().optional(),
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
            const provider = rpc.requireProvider();
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
        });

        return ok({
          ...result,
          native,
          ...(willNeedApprove !== undefined ? { willNeedApprove } : {}),
          from: fromResolved,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

// Export the core for reuse by other tools (e.g. dexe_otc_buyer_buy
// `simulateFirst` flag).
export { simulateCalldata, decodeRevert };
export type { SimCalldataInput, SimCalldataResult };
