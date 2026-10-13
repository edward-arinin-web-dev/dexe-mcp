import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ── Per-tool-call context for approvals ───────────────────────────────────
 *
 * The keystore branch of `sendOrCollect` sits several calls below the tool
 * handler, and it needs three things the handler has: the tool's name (shown
 * on the page and binding the resume ledger), the request's `extra` (progress
 * notifications while it waits for the human, the cancellation signal), and a
 * place to remember what already landed in THIS call (so an approval that is
 * still pending after an earlier batch landed reports both).
 *
 * `applyApprovalScope` wraps the write tools' handlers once at registration
 * (like the read guard does), so no composite has to thread anything through.
 * It also converts an {@link ApprovalHaltError} — thrown when the human has not
 * approved yet, or declined — into the tool's `awaiting_approval` / `declined`
 * result, however deep in a composite it was raised.
 */

export interface ToolScope {
  tool: string;
  signal?: AbortSignal;
  /** Send `notifications/progress` when the client asked for progress; otherwise a no-op. */
  progress(message: string): Promise<void>;
  /** Steps that landed earlier in this call (any batch). */
  landed: Array<{ label: string; txHash: string }>;
}

const store = new AsyncLocalStorage<ToolScope>();

export function currentToolScope(): ToolScope | undefined {
  return store.getStore();
}

type Extra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
};

export function scopeFromExtra(tool: string, extra: unknown): ToolScope {
  const e = (extra && typeof extra === "object" ? extra : {}) as Extra;
  const token = e._meta?.progressToken;
  let n = 0;
  return {
    tool,
    ...(e.signal instanceof AbortSignal ? { signal: e.signal } : {}),
    landed: [],
    async progress(message: string) {
      if (token === undefined || typeof e.sendNotification !== "function") return;
      n += 1;
      try {
        await e.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message } });
      } catch {
        /* a client that cannot take progress must not fail the call */
      }
    },
  };
}

export function runInToolScope<T>(scope: ToolScope, fn: () => T): T {
  return store.run(scope, fn);
}

/** What the human has (not) done, as the tool reports it. */
export interface ApprovalHalt {
  status: "pending" | "declined" | "executing" | "expired" | "throttled";
  approvalId: string;
  url?: string;
  fingerprint: string;
  expiresAt?: string;
  chainId: number;
  from: string;
  /** Short human labels of the batch steps. */
  steps: string[];
  message: string;
  /** Decline cooldown end (declined), or when a new approval may be requested (throttled). */
  retryAfter?: string;
  /** throttled: the approvals already waiting for the owner. */
  open?: Array<{ approvalId: string; fingerprint: string; url?: string }>;
}

/** Thrown by the keystore branch when signing must wait for (or was refused by) the owner. */
export class ApprovalHaltError extends Error {
  constructor(readonly halt: ApprovalHalt) {
    super(halt.message);
    this.name = "ApprovalHaltError";
  }
}

export const AWAITING_APPROVAL_NEXT =
  "Nothing was signed yet. Tell the user to open the approval page (url) in their own browser — or run " +
  "`npx dexe-mcp approve` in their own terminal — check the fingerprint matches, and approve with their keystore " +
  "password there; never ask for the password in chat. " +
  "Then re-run this same call promptly — an approval is held only ~2 minutes (DEXE_APPROVAL_USE_S) and is " +
  "used without asking again — or wait with " +
  "dexe_tx_approval_status {\"approvalId\":\"<approvalId>\",\"waitMs\":60000} first.";

export const DECLINED_MESSAGE = "Owner declined; nothing signed. Do not retry unless the user asks.";

/** The tool result for a halted approval. `awaiting_approval` is not an error; `declined` is. */
export function approvalHaltResult(halt: ApprovalHalt, landedThisCall: Array<{ label: string; txHash: string }> = []) {
  if (halt.status === "throttled") {
    const body = {
      mode: "approval_refused",
      status: "throttled",
      guard: "approval-rate",
      message: halt.message,
      fingerprint: halt.fingerprint,
      chainId: halt.chainId,
      from: halt.from,
      steps: halt.steps,
      ...(halt.retryAfter ? { retryAfter: halt.retryAfter } : {}),
      ...(halt.open?.length ? { waitingApprovals: halt.open } : {}),
      ...(landedThisCall.length ? { landedThisCall } : {}),
      next:
        "Nothing was signed and no new page was opened. Ask the user to approve or decline the approvals already " +
        "waiting (dexe_tx_approval_status shows them), then re-run this call — do not retry in a loop.",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: true };
  }
  const body =
    halt.status === "declined"
      ? {
          mode: "declined",
          status: "declined",
          guard: "human",
          message: DECLINED_MESSAGE,
          approvalId: halt.approvalId,
          fingerprint: halt.fingerprint,
          chainId: halt.chainId,
          from: halt.from,
          steps: halt.steps,
          ...(halt.retryAfter ? { cooldownUntil: halt.retryAfter } : {}),
          ...(landedThisCall.length ? { landedThisCall } : {}),
        }
      : {
          mode: "awaiting_approval",
          status: halt.status,
          approval: {
            approvalId: halt.approvalId,
            ...(halt.url ? { url: halt.url } : {}),
            fingerprint: halt.fingerprint,
            ...(halt.expiresAt ? { expiresAt: halt.expiresAt } : {}),
            chainId: halt.chainId,
            from: halt.from,
            steps: halt.steps,
          },
          message: halt.message,
          ...(landedThisCall.length
            ? {
                landedThisCall,
                landedNote:
                  "These transactions from earlier in this call already landed; only the batch above is waiting. " +
                  "Re-running the same call skips what already happened on-chain.",
              }
            : {}),
          next: AWAITING_APPROVAL_NEXT.replace("<approvalId>", halt.approvalId),
        };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(halt.status === "declined" ? { isError: true } : {}),
  };
}

type AnyFn = (...a: unknown[]) => unknown;

function wrapHandler(tool: string, cb: AnyFn): AnyFn {
  return async (...args: unknown[]) => {
    const scope = scopeFromExtra(tool, args[args.length - 1]);
    try {
      return await runInToolScope(scope, () => cb(...args));
    } catch (e) {
      if (e instanceof ApprovalHaltError) return approvalHaltResult(e.halt, scope.landed);
      throw e;
    }
  };
}

/** Wrap every registration of a tool in `tools` with the approval scope. */
export function applyApprovalScope(server: McpServer, tools: ReadonlySet<string>): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "registerTool" && prop !== "tool") {
        return typeof v === "function" ? (v as AnyFn).bind(target) : v;
      }
      if (typeof v !== "function") return v;
      const original = (v as AnyFn).bind(target);
      return (name: unknown, ...rest: unknown[]) => {
        if (typeof name !== "string" || !tools.has(name)) return original(name, ...rest);
        if (prop === "registerTool") {
          if (typeof rest[1] === "function") rest[1] = wrapHandler(name, rest[1] as AnyFn);
          return original(name, ...rest);
        }
        const last = rest.length - 1;
        if (last >= 0 && typeof rest[last] === "function") rest[last] = wrapHandler(name, rest[last] as AnyFn);
        return original(name, ...rest);
      };
    },
  }) as McpServer;
}
