import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteConfig } from "../config.js";
import { WRITE_DEFAULTS } from "../config.js";
import type { SignerManager } from "../lib/signer.js";
import type { StateStore } from "../lib/stateStore.js";
import { RpcProvider } from "../rpc.js";
import { maskUrl } from "../lib/redact.js";
import { getAgentLedger, DAY_MS, type SpendRow } from "../lib/agentLedger.js";
import { depositedPowerFor } from "./operationalContext.js";

/**
 * `dexe_write_context` (0.36.0) — the write edition's half of session
 * orientation: who signs, how, with which personas, and what a write needs that
 * is not configured yet. Everything here used to ride on `dexe_context` (signer,
 * keyring, Pinata/WalletConnect readiness, the interrupted flow) and
 * `dexe_get_config` (signer mode, Safe, WalletConnect, Pinata); those two are
 * read-edition tools now (./operationalContext.ts, ./getConfig.ts).
 */

type SignerMode = "readonly" | "eoa" | "safe" | "walletconnect";

/**
 * How writes are dispatched:
 *   - "readonly": no key, no WalletConnect project → tools return unsigned TxPayloads only
 *   - "safe":     key + DEXE_SAFE_TX_SERVICE_URL → dexe_safe_* can queue txs
 *                 to the Safe multisig instead of broadcasting
 *   - "eoa":      key set, no Safe service → dexe_tx_send broadcasts directly
 *   - "walletconnect": no key, but a WalletConnect project id (the shared
 *                 default counts) → txs go to the operator's phone for
 *                 approval. WC wins only when no hot key is present.
 */
function signerMode(config: WriteConfig, signer: SignerManager, safeServiceUrl: string | undefined): SignerMode {
  return signer.hasSigner()
    ? safeServiceUrl
      ? "safe"
      : "eoa"
    : config.walletConnectProjectId
      ? "walletconnect"
      : "readonly";
}

/**
 * One persona an orchestrator can act as. Labels and addresses only — key
 * material never appears here, and `SignerManager` is the only object that
 * holds it.
 */
interface KeyringSigner {
  /** Value to pass as `signerKey` ("primary" means: omit the field). */
  signerKey: string;
  address: string;
  role: "primary" | "keyring";
  /** Native balance on `balanceChainId`; null when the probe was skipped or failed. */
  balanceWei: string | null;
  /** balanceWei > 0 — "can this persona pay for its own gas". */
  funded: boolean | null;
  /** Broadcasts attributed to this persona in the last 24h (agent ledger). */
  actions24h: number;
  /** Native value + gas charged to this persona in the last 24h, wei. */
  spentWei24h: string;
}

/**
 * The fleet an orchestrating agent can command: every configured persona, its
 * address, whether it can pay for gas, and what it has already done today.
 *
 * Before 0.32.0 orientation reported one signer address and nothing else, so
 * an agent asked to "run five personas" had no way to discover that four of them
 * existed — the keyring was configured in `.env`, resolvable by
 * `SignerManager`, threaded through every composite, and invisible. A fleet
 * cannot be planned from a surface that does not admit it exists.
 *
 * Balances are ONE `eth_getBalance` per persona on the default chain, issued in
 * parallel and individually best-effort; `includeAgentBalances: false` skips
 * them entirely. The 24h activity comes from the local agent ledger — a file
 * read, no RPC.
 */
export async function keyringReport(
  config: Pick<WriteConfig, "defaultChainId">,
  signer: SignerManager,
  rpc: RpcProvider,
  includeBalances: boolean,
): Promise<{
  configured: number;
  balanceChainId: number | null;
  fundedCount: number | null;
  signers: KeyringSigner[];
  spend24h: { actions: number; totalWei: string };
  hint: string;
}> {
  const rows: Array<{ signerKey: string; address: string; role: "primary" | "keyring" }> = [];
  if (signer.hasSigner()) {
    rows.push({ ...signer.describeSigner(), role: "primary" });
  }
  for (const a of signer.listAgents()) {
    // A slot whose key IS the primary key would otherwise be listed twice under
    // two labels; keep both labels only when the addresses differ.
    if (rows.some((r) => r.address.toLowerCase() === a.address.toLowerCase())) continue;
    rows.push({ ...a, role: "keyring" });
  }

  // Per-persona 24h spend — the same ledger a budget guard reads, so the plan
  // and the enforcement agree on the numbers.
  const spend = getAgentLedger().spendSince({ windowMs: DAY_MS });
  const byAgent = new Map<string, SpendRow>(spend.byAgent.map((r) => [r.signerKey, r]));

  const wantBalances = includeBalances && rows.length > 0;
  const pr = wantBalances ? rpc.tryProvider(config.defaultChainId) : null;
  const provider = pr && !("error" in pr) ? pr.ok : null;

  const balances = await Promise.all(
    rows.map(async (r) => {
      if (!provider) return null;
      try {
        return (await provider.getBalance(r.address)).toString();
      } catch {
        // A rate-limited public endpoint must not fail the orientation call.
        return null;
      }
    }),
  );

  const signers: KeyringSigner[] = rows.map((r, i) => {
    const row = byAgent.get(r.signerKey);
    const balanceWei = balances[i] ?? null;
    return {
      signerKey: r.signerKey,
      address: r.address,
      role: r.role,
      balanceWei,
      funded: balanceWei === null ? null : BigInt(balanceWei) > 0n,
      actions24h: row?.actions ?? 0,
      spentWei24h: row?.totalWei ?? "0",
    };
  });

  // null = "not known", never an optimistic 0/allFunded: an orchestrator that
  // reads a skipped probe as "0 funded" would fund a fleet that is already funded.
  const fundedCount =
    signers.length === 0 || signers.some((s) => s.funded === null)
      ? null
      : signers.filter((s) => s.funded).length;
  const agents = signers.filter((s) => s.role === "keyring").length;

  const hint =
    agents === 0
      ? "No agent keyring configured — every write signs with the primary key. Set DEXE_AGENT_PK_1..16 " +
        "(and DEXE_AGENT_FUNDER_PK for a gas funder) to run multiple personas, then pass signerKey on " +
        "dexe_dao_create / dexe_proposal_create / dexe_proposal_vote_and_execute / dexe_tx_send."
      : `${agents} agent persona(s) available. Pass signerKey:'<slot>' on any write tool to act as one; ` +
        "omitting signerKey always signs with the primary key — a persona is never chosen implicitly. " +
        (fundedCount === 0
          ? "NONE of them holds native gas yet: fund them before they can broadcast."
          : "Unfunded personas can build calldata but cannot broadcast.");

  return {
    configured: signers.length,
    balanceChainId: provider ? config.defaultChainId : null,
    fundedCount,
    signers,
    spend24h: { actions: spend.total.actions, totalWei: spend.total.totalWei },
    hint,
  };
}

/** What to do next given the signer mode — one sentence, the mode's first move. */
const SIGNER_NEXT: Record<SignerMode, string> = {
  walletconnect:
    "Writes sign on a phone over WalletConnect: dexe_wc_status says whether a wallet is paired, dexe_wc_connect " +
    "shows the pairing QR.",
  eoa: "The hot key signs and broadcasts directly.",
  safe:
    "A Safe Transaction Service is configured: dexe_safe_propose_tx queues a transaction for the Safe owners " +
    "instead of broadcasting it.",
  readonly: "No signer: write tools return unsigned payloads for an external wallet to sign.",
};

/** Flag a hot key as unsafe and steer toward WalletConnect (the phone signs, so the key never touches disk). */
const HOT_KEY_WARNING =
  "⚠️ NOT SAFE — hot key (DEXE_PRIVATE_KEY) in plaintext on disk. Recommended: unset it and run dexe_wc_connect so the phone signs.";

export function registerWriteContextTool(
  server: McpServer,
  config: WriteConfig,
  signer: SignerManager,
  state: StateStore,
): void {
  const rpc = new RpcProvider(config);

  server.tool(
    "dexe_write_context",
    "Read-only. Write posture for this session — the signer mode + address (hot key, Safe, WalletConnect or none), " +
      "the agent KEYRING (signerKey, address, gas, 24h broadcasts per persona), Pinata / WalletConnect / Safe " +
      "readiness, the signer's deposited power in the newest recorded DAO, and a write journey a prior session " +
      "left unfinished. Chains, env readiness and recorded DAOs are dexe_context.",
    {
      includeDepositedPower: z
        .boolean()
        .default(true)
        .describe("Read the signer's deposited power in the newest recorded DAO (one extra RPC call)."),
      includeAgentBalances: z
        .boolean()
        .default(true)
        .describe("Probe each persona's native balance (one eth_getBalance per signer, default chain)."),
    },
    async ({ includeDepositedPower = true, includeAgentBalances = true }) => {
      const st = state.getState();
      const safeServiceUrl = process.env.DEXE_SAFE_TX_SERVICE_URL?.trim() || undefined;
      const mode = signerMode(config, signer, safeServiceUrl);
      const address = signer.hasSigner() ? signer.getAddress() : null;

      let lastDaoPower: { govPool: string; chainId: number; depositedPower: string | null } | null = null;
      const last = st.knownDaos[0];
      if (includeDepositedPower && last && address) {
        lastDaoPower = {
          govPool: last.govPool,
          chainId: last.chainId,
          depositedPower: await depositedPowerFor(rpc, last, address),
        };
      }

      // The fleet. Never key material — labels, addresses, balances, counts.
      const keyring = await keyringReport(config, signer, rpc, includeAgentBalances);

      const pinataConfigured = !!config.pinataJwt;
      const hint =
        (st.activeFlow
          ? `Mid-journey: flow '${st.activeFlow.flow}' last completed step '${st.activeFlow.step}' on chain ` +
            `${st.activeFlow.chainId} — call dexe_guide {flow:"${st.activeFlow.flow}"} to resume. `
          : "") +
        SIGNER_NEXT[mode] +
        (pinataConfigured
          ? ""
          : " DEXE_PINATA_JWT is unset: DAO and proposal creation can preview (dryRun) but cannot broadcast, " +
            "because broadcasting pins the metadata to IPFS.") +
        (st.knownDaos.length === 0
          ? " No DAOs recorded yet — deploy one with dexe_dao_create (rehearse on testnet chain 97)."
          : "");

      const result = {
        signer: {
          mode,
          address,
          recommended: "walletconnect",
          ...(mode === "eoa" || mode === "safe" ? { safety: HOT_KEY_WARNING } : {}),
        },
        keyring,
        walletConnect: {
          available: !!config.walletConnectProjectId,
          /** True while the project id is the shared default shipped with the package. */
          sharedDefaultProjectId: config.walletConnectProjectId === WRITE_DEFAULTS.walletConnectProjectId,
          relayUrl: config.walletConnectRelayUrl ?? null,
          approvalTimeoutMs: config.walletConnectApprovalTimeoutMs ?? null,
        },
        safe: {
          txServiceConfigured: !!safeServiceUrl,
          txServiceUrl: safeServiceUrl ? maskUrl(safeServiceUrl) : null,
          apiKeyConfigured: !!process.env.DEXE_SAFE_API_KEY?.trim(),
        },
        ipfsUploads: { pinataConfigured },
        lastDaoPower,
        ...(st.activeFlow ? { activeFlow: st.activeFlow } : {}),
        hint,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
