import { Interface } from "ethers";
import type { RpcProvider } from "@dexe-network/dexe-mcp/core";

/**
 * The eth_call simulation core behind dexe_sim_* (src/tools/simulate.ts), the
 * B9 broadcast guard (./broadcastGuards.ts), the pre-sign deploy simulation
 * (./deploySim.ts) and dexe_otc_buyer_buy's simulate step. A lib module so
 * those lib callers no longer import a tools file.
 */

const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string)
const PANIC_SELECTOR = "0x4e487b71"; // Panic(uint256)

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
  /** Chain to simulate against; defaults to the configured default chain. */
  chainId?: number;
}

interface SimCalldataResult {
  success: boolean;
  revertReason?: string;
  returnData?: string;
  gasEstimate?: string;
  /**
   * True when the eth_call failed for a transport/RPC reason (timeout, 429,
   * node hiccup) rather than a genuine contract revert. Callers that gate on
   * `!success` (e.g. the B9 broadcast guard) must NOT treat a network error as
   * a revert — the contract was never evaluated.
   */
  networkError?: boolean;
}

async function simulateCalldata(
  rpc: RpcProvider,
  input: SimCalldataInput,
): Promise<SimCalldataResult> {
  const pr0 = rpc.tryProvider(input.chainId);
  if ("error" in pr0) {
    return { success: false, revertReason: `${pr0.error}\n${pr0.remediation}` };
  }
  const provider = pr0.ok;
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
    // A genuine contract revert surfaces as ethers `CALL_EXCEPTION` or carries
    // decodable return data. Anything else (TIMEOUT / NETWORK_ERROR / SERVER_ERROR
    // 429/5xx / connection reset) is a transport failure — the call never ran, so
    // it must not be reported to callers as a revert.
    const code = (e as { code?: string })?.code;
    const isRevert = code === "CALL_EXCEPTION" || decoded.returnData !== undefined;
    if (!isRevert) result.networkError = true;
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

export { simulateCalldata, decodeRevert };
export type { SimCalldataInput, SimCalldataResult };
