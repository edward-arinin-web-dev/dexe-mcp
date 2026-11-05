import { z } from "zod";
import { Contract, formatUnits, getAddress, isAddress } from "ethers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { RpcProvider } from "../rpc.js";
import { chainIdParam } from "../lib/params.js";
import { parseAmount } from "../lib/units.js";
import { safeErrorMessage } from "../lib/redact.js";
import {
  encodePayAction,
  FAST_LANE_ABI,
  FAST_LANE_MAX_ACTIONS,
  FAST_LANE_WINDOW_DAYS,
  fastLaneChainRefusal,
  laneIface,
  payProposalRecipe,
} from "../lib/agentFastLane.js";

const TOOL = "dexe_agent_fast_lane_build_pay";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * dexe_agent_fast_lane_build_pay — read-only. Checks one payment against a
 * deployed AgentFastLane exactly the way the GovPool will (eth_call
 * `validate([pay])`), explains any refusal from the lane's own state, and
 * returns the `dexe_proposal_create` call (custom_abi) that creates the
 * fast-lane proposal. Broadcasts nothing.
 */
export function registerAgentFastLanePayTool(server: McpServer, ctx: ToolContext, rpc: RpcProvider): void {
  server.tool(
    TOOL,
    "Read-only. TESTNET ONLY (chain 97). Checks a payment through an agent treasury's AgentFastLane — recipient " +
      "allowlisted, amount within the per-payment cap and the rolling " +
      `${FAST_LANE_WINDOW_DAYS}-day cap, float sufficient — by calling the lane's validate() exactly as the GovPool ` +
      "does at proposal creation, and returns the dexe_proposal_create call (proposalType custom_abi, lane.pay) " +
      "that needs only the agents' k-of-n vote, no validator round. Broadcasts nothing.",
    {
      lane: z.string().describe("The AgentFastLane address (deploy result `fastLane.address`)."),
      to: z.string().describe("Recipient; must be on the lane's allowlist."),
      amount: z
        .string()
        .describe("Amount of the lane's token: raw wei (digits only) or human units with a decimal point ('12.5')."),
      chainId: chainIdParam,
      title: z.string().max(200).optional().describe("Proposal title. Default: 'Fast lane: pay …'."),
    },
    async ({ lane, to, amount, chainId, title }) => {
      const cid = rpc.resolveChainId(chainId);
      const refusal = fastLaneChainRefusal(cid);
      if (refusal) return err(refusal);
      if (!isAddress(lane)) return err(`Invalid lane address: ${lane}`);
      if (!isAddress(to)) return err(`Invalid recipient address: ${to}`);
      const laneAddr = getAddress(lane);
      const toAddr = getAddress(to);

      const pr = rpc.tryProvider(cid);
      if ("error" in pr) return err(`${pr.error}\n${pr.remediation}`);
      const provider = pr.ok;

      const code = await provider.getCode(laneAddr).catch(() => "0x");
      if (code === "0x") return err(`No contract at ${laneAddr} on chain ${cid}.`);

      const c = new Contract(laneAddr, FAST_LANE_ABI as unknown as string[], provider);
      let state: {
        govPool: string;
        token: string;
        perPaymentCap: bigint;
        windowCap: bigint;
        allowed: boolean;
        spent: bigint;
        windowRemaining: bigint;
        floatBalance: bigint;
      };
      try {
        const [govPool, token, perPaymentCap, windowCap, allowed, spent, avail] = (await Promise.all([
          c.getFunction("govPool").staticCall(),
          c.getFunction("token").staticCall(),
          c.getFunction("perPaymentCap").staticCall(),
          c.getFunction("windowCap").staticCall(),
          c.getFunction("allowed").staticCall(toAddr),
          c.getFunction("spentInWindow").staticCall(),
          c.getFunction("available").staticCall(),
        ])) as [string, string, bigint, bigint, boolean, bigint, [bigint, bigint]];
        state = {
          govPool: getAddress(govPool),
          token: getAddress(token),
          perPaymentCap,
          windowCap,
          allowed,
          spent,
          windowRemaining: avail[0],
          floatBalance: avail[1],
        };
      } catch (e) {
        return err(`${laneAddr} does not answer as an AgentFastLane: ${safeErrorMessage(e)}`);
      }

      let decimals = 18;
      try {
        decimals = Number(
          await new Contract(state.token, ["function decimals() view returns (uint8)"], provider)
            .getFunction("decimals")
            .staticCall(),
        );
      } catch {
        /* a token without decimals(): assume 18 */
      }
      let amountWei: bigint;
      try {
        amountWei = parseAmount(amount, decimals);
      } catch (e) {
        return err(`amount: ${safeErrorMessage(e)}`);
      }
      const human = (wei: bigint) => formatUnits(wei, decimals);

      // The protocol's own verdict: validate([pay]) as a staticcall.
      const action = encodePayAction(laneAddr, toAddr, amountWei);
      let valid: boolean;
      try {
        const data = laneIface.encodeFunctionData("validate", [[[action.executor, 0n, action.data]]]);
        const ret = await provider.call({ to: laneAddr, data });
        valid = laneIface.decodeFunctionResult("validate", ret)[0] as boolean;
      } catch (e) {
        return err(`validate() call failed: ${safeErrorMessage(e)}`);
      }

      // Why, in the lane's own terms (the contract only says false).
      const reasons: string[] = [];
      if (!state.allowed) reasons.push(`${toAddr} is not on the lane's allowlist (a validator-round proposal to the lane's admin adds it).`);
      if (amountWei === 0n) reasons.push("amount is zero.");
      if (amountWei > state.perPaymentCap) reasons.push(`amount ${human(amountWei)} exceeds the per-payment cap ${human(state.perPaymentCap)}.`);
      if (amountWei > state.windowRemaining) {
        reasons.push(
          `amount ${human(amountWei)} exceeds what the rolling ${FAST_LANE_WINDOW_DAYS}-day cap still allows ` +
            `(${human(state.windowRemaining)} of ${human(state.windowCap)}; ${human(state.spent)} spent in the window).`,
        );
      }
      const floatShort = amountWei > state.floatBalance;
      if (floatShort) {
        reasons.push(
          `the lane holds only ${human(state.floatBalance)}: validate() does not check the float, but pay() ` +
            `would revert at execution ("FastLane: transfer failed"). Top the lane up with a treasury proposal first.`,
        );
      }
      if (!valid && reasons.filter((r) => !r.startsWith("the lane holds")).length === 0) {
        reasons.push(
          "validate() returned false while every readable limit passes — the lane's conservative settle " +
            `(it reads at most a few expired day-buckets at creation) may be over-counting; retry with a smaller ` +
            "amount, or make any fast-lane payment first (pay() settles the window exactly).",
        );
      }

      const recipe = payProposalRecipe({
        govPool: state.govPool,
        chainId: cid,
        lane: laneAddr,
        to: toAddr,
        amountWei,
        amountHuman: human(amountWei),
        ...(title ? { title } : {}),
      });
      const verdict = valid && !floatShort ? "ok" : valid ? "creatable-but-unexecutable" : "refused";
      const body = {
        tool: TOOL,
        chainId: cid,
        verdict,
        lane: {
          address: laneAddr,
          govPool: state.govPool,
          token: state.token,
          perPaymentCap: human(state.perPaymentCap),
          windowCap: human(state.windowCap),
          windowDays: FAST_LANE_WINDOW_DAYS,
          spentInWindow: human(state.spent),
          windowRemaining: human(state.windowRemaining),
          floatBalance: human(state.floatBalance),
          recipientAllowed: state.allowed,
          maxActionsPerProposal: FAST_LANE_MAX_ACTIONS,
        },
        payment: { to: toAddr, amount: human(amountWei), amountWei: amountWei.toString() },
        validateReturned: valid,
        ...(reasons.length ? { reasons } : {}),
        action,
        ...(verdict === "ok"
          ? {
              proposal: recipe,
              next:
                `Create it: dexe_proposal_create ${JSON.stringify(recipe.args)} — the lane is the only executor, so ` +
                `the proposal runs under the fast slot (agents' vote, early completion, no validator round). Then ` +
                `the other agents vote with dexe_proposal_vote_and_execute.`,
            }
          : {
              next:
                verdict === "refused"
                  ? "NOT creatable: GovPool.createProposal would revert 'Gov: validation failed'. Fix the reasons above."
                  : "Creatable, but execution would revert until the lane holds enough float.",
            }),
        testnetOnly: "AgentFastLane.sol is unaudited and ships for BSC testnet (97) only.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );
}
