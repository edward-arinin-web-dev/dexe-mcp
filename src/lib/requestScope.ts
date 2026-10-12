import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The cancellation signal of the tool call that is running right now.
 *
 * The MCP SDK hands every tool handler `extra.signal`, which aborts when the
 * client cancels the request or the transport closes. Under `serve-http` the
 * transport closes when the per-request timeout fires or the client goes
 * away, so an honoured signal is what stops a slow tool from carrying on
 * fetching for a caller who is no longer there.
 *
 * Threading the signal through every helper signature would touch dozens of
 * call sites. Instead the read-tool guard (src/tools/readGuard.ts) runs each
 * read handler inside `runWithRequestSignal`, and the shared upstream helpers
 * (IPFS fetch, subgraph `gqlRequest`, the backend client, `multicall`) pick
 * the signal up from here. Code that runs outside a guarded read tool sees no
 * signal, so its behaviour is unchanged.
 */
const scope = new AsyncLocalStorage<{ signal?: AbortSignal }>();

/** Run `fn` with `signal` as the ambient request signal. */
export function runWithRequestSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return scope.run({ signal }, fn);
}

/** The ambient request signal, if a guarded tool call is running. */
export function currentRequestSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

/** Thrown when the caller cancelled the request; no further upstream call is made. */
export class RequestCancelledError extends Error {
  constructor(what = "request") {
    super(`The client cancelled this ${what}, so no further upstream calls were made.`);
    this.name = "RequestCancelledError";
  }
}

/** Throw `RequestCancelledError` when `signal` (default: the ambient one) has aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined = currentRequestSignal()): void {
  if (signal?.aborted) throw new RequestCancelledError();
}

export interface DeadlineSignal {
  /** Aborts on the deadline OR when the caller's signal aborts. */
  signal: AbortSignal;
  /** True when the deadline (not the caller) caused the abort. */
  timedOut(): boolean;
  /** True when the caller's signal caused the abort. */
  cancelled(): boolean;
  /** Clear the deadline timer. Always call it, in a `finally`. */
  clear(): void;
}

/**
 * A per-attempt deadline combined with the caller's cancellation (explicit
 * `external`, else the ambient request signal). The two are told apart so an
 * error can say "timed out after N ms" (actionable: retry) or "cancelled"
 * (nothing to do) instead of a bare "This operation was aborted".
 */
export function deadlineSignal(timeoutMs: number, external?: AbortSignal): DeadlineSignal {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const caller = external ?? currentRequestSignal();
  const signal = caller ? AbortSignal.any([deadline.signal, caller]) : deadline.signal;
  return {
    signal,
    timedOut: () => deadline.signal.aborted && !(caller?.aborted ?? false),
    cancelled: () => caller?.aborted ?? false,
    clear: () => clearTimeout(timer),
  };
}
