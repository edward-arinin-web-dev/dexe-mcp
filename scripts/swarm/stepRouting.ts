/**
 * Step routing — who actually signs a swarm step. Pure, side-effect-free.
 *
 * By default the orchestrator spawns the MCP with `DEXE_PRIVATE_KEY: ""` so the
 * composites return TxPayload lists, and signs them itself with a local
 * `ethers.Wallet`. That is why NONE of the 0.30–0.33 signer-side work is
 * exercised by a swarm run: `runBroadcastGuards` (B6/B7/B9/B10/B11/B12), the
 * SignerManager per-(chain,address) nonce queue, the broadcast recorder /
 * agent ledger, and `waitWithTimeout` → `broadcastTimeout` / `timeoutResume`
 * all live on the SERVER's send path and the harness routes around them.
 *
 * `steps[].serverSign: true` opts a single step into the server path: the
 * orchestrator derives the keyring slot from the step's agent wallet env var
 * and passes it as `signerKey`, and then must NOT re-broadcast the result.
 *
 * The slot is DERIVED, never free-form: the orchestrator's per-wallet mutex and
 * its step log key on `AGENT_PK_<n>`, so a hand-written `signerKey` that
 * disagreed with the step's agent would serialize the wrong EOA and mislabel
 * the run report.
 */

/** Tool names the orchestrator answers itself, without touching the MCP. */
export type InlineDispatcherNames = readonly string[];

const AGENT_PK_RE = /^(?:DEXE_)?AGENT_PK_(\d+)$/;
const FUNDER_PK_RE = /^(?:DEXE_)?AGENT_FUNDER_PK$/;

/**
 * Map a swarm wallet env var to the server-side keyring slot that holds the
 * same key. `src/config.ts`'s `parseAgentKeys` accepts `AGENT_PK_<n>` as an
 * alias of `DEXE_AGENT_PK_<n>` and `AGENT_FUNDER_PK` as the `funder` slot, so
 * the two namespaces already line up — this is the name translation.
 */
export function slotForEnvKey(envKey: string): string | null {
  const trimmed = (envKey ?? "").trim();
  const m = AGENT_PK_RE.exec(trimmed);
  if (m) return `agent${Number(m[1])}`;
  if (FUNDER_PK_RE.test(trimmed)) return "funder";
  return null;
}

export interface RoutableStep {
  step?: number;
  tool?: string;
  broadcast?: boolean;
  serverSign?: boolean;
  /** The step's tool arguments; an explicit `signerKey` here wins over the derived slot. */
  args?: Record<string, unknown>;
}

export type StepRoute = { mode: "local" } | { mode: "server"; signerKey: string };

export interface RouteOptions {
  /** Tool names handled by an inline dispatcher — `signerKey` never reaches the
   *  MCP for these, so it would be silently dropped. */
  inlineDispatchers?: InlineDispatcherNames;
  /** Scenario id, for the error text. */
  scenarioId?: string;
}

/**
 * Decide whether a step signs locally (today's behaviour, unchanged) or hands
 * the broadcast to the MCP as a named persona. Throws with the remedy when the
 * scenario asks for something that cannot work.
 */
export function routeStep(
  step: RoutableStep,
  agentEnvKey: string,
  opts: RouteOptions = {},
): StepRoute {
  if (!step?.serverSign) return { mode: "local" };
  const where = `${opts.scenarioId ? `${opts.scenarioId} ` : ""}step ${String(step.step ?? "?")}`;

  if (step.broadcast === true) {
    throw new Error(
      `${where}: serverSign and broadcast cannot both be set — serverSign means the MCP already ` +
        `broadcast the transaction, so a second local send would double-spend the nonce. Drop broadcast.`,
    );
  }
  const inline = opts.inlineDispatchers ?? [];
  if (step.tool && inline.includes(step.tool)) {
    throw new Error(
      `${where}: serverSign is not supported for ${step.tool} — the orchestrator answers it with a local ` +
        `dispatcher, so signerKey would never reach the MCP and would be silently dropped. ` +
        `Use a tool the MCP handles, or remove the inline dispatcher.`,
    );
  }
  // An explicit args.signerKey is the scenario's intent — S67 step 4 names a
  // slot that does not exist to prove the server refuses it — and must reach
  // the MCP as written. The derived slot is the default, not an override.
  const explicit = typeof step.args?.signerKey === "string" && step.args.signerKey ? step.args.signerKey : null;
  const signerKey = explicit ?? slotForEnvKey(agentEnvKey);
  if (!signerKey) {
    throw new Error(
      `${where}: agent wallet ${agentEnvKey} maps to no keyring slot. serverSign needs AGENT_PK_<n> ` +
        `or AGENT_FUNDER_PK (src/config.ts aliases those onto DEXE_AGENT_PK_* / funder).`,
    );
  }
  return { mode: "server", signerKey };
}
