import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tokenSaleResult } from "@dexe-network/dexe-mcp/core";
import { VESTING_WITHDRAW_ADVISORY } from "../lib/protocolAdvisories.js";

/**
 * F15 on the read-only position view, in the write edition.
 *
 * `dexe_read_token_sale_position` is the read edition's tool. For a tier with
 * a vesting leg it returns a neutral `vestingNote` — the read edition does not
 * describe upstream defects. This server sells and claims through those tiers,
 * so it says what it knows: on current pools `vestingWithdraw` reverts in every
 * call shape and the vested part is stranded (F15, docs/UPSTREAM-ISSUES.md).
 * Each vested tier's `vestingNote` is replaced, in place, by the
 * `vestingWithdrawBlocked` block the tool carried before the read code moved
 * out — same key, same text, same position — next to the `vestingWithdrawable`
 * number it would otherwise contradict. The deprecated alias
 * `dexe_otc_buyer_status` shares the handler, so it carries it too.
 */

export const F15_POSITION_TOOL = "dexe_read_token_sale_position";

type Json = Record<string, unknown>;
type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Json };

/** The F15 block, through the same sanitizing funnel as the rest of the payload. */
const VESTING_WITHDRAW_BLOCKED: Json = (
  tokenSaleResult({
    block: { reason: VESTING_WITHDRAW_ADVISORY.text, upstream: VESTING_WITHDRAW_ADVISORY.upstream },
  }).structuredContent as Json
).block as Json;

function vestingPercentage(tier: Json): bigint {
  const raw = (tier.vestingSettings as Json | undefined)?.vestingPercentage;
  try {
    return typeof raw === "bigint" ? raw : BigInt(String(raw ?? "0"));
  } catch {
    return 0n;
  }
}

/** A vested tier with `vestingNote` swapped for the F15 block in the same position. */
function withBlock(tier: Json): Json {
  if (vestingPercentage(tier) <= 0n) return tier;
  const out: Json = {};
  let placed = false;
  for (const [k, v] of Object.entries(tier)) {
    if (k === "vestingNote") {
      out.vestingWithdrawBlocked = VESTING_WITHDRAW_BLOCKED;
      placed = true;
    } else if (k === "merkle" && !placed) {
      out.vestingWithdrawBlocked = VESTING_WITHDRAW_BLOCKED;
      placed = true;
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  if (!placed) out.vestingWithdrawBlocked = VESTING_WITHDRAW_BLOCKED;
  return out;
}

/**
 * The tool's result with F15 attached to every vested tier. Errors and
 * payloads without tiers pass through untouched; the text block is the same
 * JSON document as the structured payload, as the tool returns it.
 */
export function attachVestingWithdrawAdvisory<R>(result: R): R {
  const r = result as ToolResult;
  const body = r?.structuredContent;
  if (!r || r.isError || !body || !Array.isArray(body.tiers)) return result;
  const next: Json = { ...body, tiers: (body.tiers as Json[]).map((t) => (t && typeof t === "object" ? withBlock(t) : t)) };
  return {
    ...r,
    content: [{ type: "text", text: JSON.stringify(next, null, 2) }],
    structuredContent: next,
  } as R;
}

type AnyFn = (...a: unknown[]) => unknown;

/**
 * `server`, but registering `dexe_read_token_sale_position` wraps its handler
 * with `attachVestingWithdrawAdvisory`. Wraps the call site in registerAll, so
 * the read-result guard, the annotations and the alias layer all see the
 * wrapped handler.
 */
export function withVestingWithdrawAdvisory(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "registerTool" || typeof v !== "function") {
        return typeof v === "function" ? (v as AnyFn).bind(target) : v;
      }
      const original = (v as AnyFn).bind(target);
      return (name: unknown, config: unknown, cb: unknown) => {
        if (name !== F15_POSITION_TOOL || typeof cb !== "function") return original(name, config, cb);
        const wrapped = async (...args: unknown[]) => attachVestingWithdrawAdvisory(await (cb as AnyFn)(...args));
        return original(name, config, wrapped);
      };
    },
  }) as McpServer;
}
