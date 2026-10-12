import type { WriteConfig } from "../config.js";
import { DEFAULTS } from "../config.js";
import { FULL_ENV_SURFACE } from "../env/schema.js";
import { fetchJsonWithTimeout, type CheckResult, type ExtraChecks } from "./checks.js";
import type { DoctorText } from "../tools/doctor.js";

/**
 * The doctor's wording on a server that runs these checks: Pinata among the
 * probes, and the opt-in pin probe as an input.
 */
export const WRITE_DOCTOR_TEXT: DoctorText = {
  description:
    "Read-only. Diagnoses env setup: presence + reachability checks (RPC, Pinata, IPFS gateway DNS, subgraph, backend) as pass/warn/fail with remediation hints. " +
    "Call FIRST on an env-related failure. " +
    "Warnings are advisories — a healthy zero-config install always has some. " +
    "`probePin` is the one write: one tiny IPFS pin.",
  probePin: "Probe pin to Pinata (added, then removed) — use when an IPFS upload fails with HTTP 403.",
};

/**
 * The doctor checks only a server that signs, broadcasts or pins needs: the
 * Pinata JWT and (opt-in) pin probe, the signer / keyring / broadcast-guard
 * rows, "a hot key with no RPC", and the WalletConnect project id among the
 * shared public defaults. The read checks are in ./checks.ts; this file hands
 * them over as `ExtraChecks`, which `runAllChecks` slots in where the single
 * server has always listed them.
 */
export interface WriteDoctorOptions {
  /**
   * Run the Pinata pin-capability probe. It WRITES one tiny pin to the user's
   * Pinata account (and tries to remove it again). Off by default — `dexe_doctor`
   * promises it performs no writes, and that promise has to be true.
   */
  probePin?: boolean;
}

export function writeDoctorChecks(opts: WriteDoctorOptions = {}): ExtraChecks<WriteConfig> {
  return {
    // Presence rows and startup-issue categories over every var the server
    // reads (read + write + dev), in the order they have always been listed.
    env: FULL_ENV_SURFACE,
    network: (timeoutMs) => [pinataJwtCheck(timeoutMs), pinataPinQuotaCheck(timeoutMs, opts.probePin === true)],
    config: (config) => [...signerGuardConfigCheck(config), ...signerNeedsRpcCheck(config)],
    sharedDefaults: {
      inUse: (config) =>
        config.walletConnectProjectId === DEFAULTS.walletConnectProjectId ? ["WalletConnect project id"] : [],
      fix: "DEXE_WALLETCONNECT_PROJECT_ID",
    },
  };
}

// ─── pinata jwt ──────────────────────────────────────────────────────────

async function pinataJwtCheck(timeoutMs: number): Promise<CheckResult | null> {
  const jwt = process.env.DEXE_PINATA_JWT?.trim();
  if (!jwt) return null;
  const res = await fetchJsonWithTimeout(
    "https://api.pinata.cloud/data/testAuthentication",
    { method: "GET", headers: { Authorization: `Bearer ${jwt}` } },
    timeoutMs,
  );
  if (res.kind === "timeout") {
    return {
      id: "pinata.jwt",
      category: "ipfs",
      status: "warn",
      message: `Pinata auth check timed out (${timeoutMs}ms)`,
    };
  }
  if (res.kind === "error") {
    return {
      id: "pinata.jwt",
      category: "ipfs",
      status: "fail",
      message: `Pinata reachability: ${res.error}`,
    };
  }
  if (res.status >= 400) {
    return {
      id: "pinata.jwt",
      category: "ipfs",
      status: "fail",
      message: `Pinata testAuthentication returned HTTP ${res.status}`,
      remediation:
        "Regenerate the JWT at https://app.pinata.cloud/developers/api-keys with `pinning` scope and update DEXE_PINATA_JWT.",
    };
  }
  return {
    id: "pinata.jwt",
    category: "ipfs",
    status: "pass",
    message: "authenticated (pin capability not exercised — probing it writes a pin to your account)",
    // A `remediation` on a PASS row is printed by both renderers but is kept out
    // of `remediationSummary`, so it informs without flagging anything broken.
    // It carries the F3 pointer that the (now opt-in) pin probe used to carry.
    remediation:
      "If an IPFS upload later fails with HTTP 403 while this row is green, the account is pin-blocked (usually the free-plan usage limit). " +
      "Confirm with `npx dexe-mcp doctor --probe-pin` (or dexe_doctor {probePin:true}), then free up pins / upgrade at app.pinata.cloud, or rotate DEXE_PINATA_JWT.",
  };
}

// ─── pinata pin quota ─────────────────────────────────────────────────────
//
// F3: testAuthentication stays green while the account is blocked for plan
// usage ("Account blocked due to plan usage limit" → HTTP 403 on every pin).
// Probe the ACTUAL pin capability with a tiny deterministic JSON pin — the
// same content re-pins to the same CID, so repeated doctors add no clutter.
//
// OPT-IN since 0.34.0. This is the only check in the suite that WRITES, and
// `dexe_doctor` tells the calling model it never writes. When it is off the
// check emits NO row at all — a synthetic "not probed" pass would inflate
// `summary.passed` with a verification that never happened (the exact F3
// failure pattern), a `warn` would exit 1 for every configured user, and a new
// status value is counted as a failure by both tallies. The F3 pointer lives on
// the `pinata.jwt` row instead.
async function pinataPinQuotaCheck(timeoutMs: number, enabled: boolean): Promise<CheckResult | null> {
  const jwt = process.env.DEXE_PINATA_JWT?.trim();
  if (!jwt) return null;
  if (!enabled) return null;
  const res = await fetchJsonWithTimeout(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pinataContent: { probe: "dexe-mcp-doctor-pin-quota" },
        pinataMetadata: { name: "dexe-mcp-doctor-probe" },
      }),
    },
    timeoutMs,
  );
  if (res.kind === "timeout") {
    return { id: "pinata.pinQuota", category: "ipfs", status: "warn", message: `Pin-quota probe timed out (${timeoutMs}ms)` };
  }
  if (res.kind === "error") {
    return { id: "pinata.pinQuota", category: "ipfs", status: "warn", message: `Pin-quota probe unreachable: ${res.error}` };
  }
  if (res.status >= 400) {
    const body = typeof res.body === "string" ? res.body.slice(0, 200) : JSON.stringify(res.body ?? "").slice(0, 200);
    return {
      id: "pinata.pinQuota",
      category: "ipfs",
      status: "fail",
      message: `Pinata pin probe returned HTTP ${res.status}: ${body}`,
      remediation:
        "The JWT authenticates but pinning is blocked (typically the free-plan usage limit). " +
        "Free up pins / upgrade the plan at app.pinata.cloud, or rotate to a different account's JWT. " +
        "Every IPFS-write flow (proposal creation, DAO deploy metadata, uploads) is down until this passes.",
    };
  }
  // Clean up after ourselves. Bounded separately and shorter than the probe so
  // the pair still fits the network budget; a cleanup failure NEVER turns into
  // a check failure, and `DELETE /pinning/unpin` answers plain text `OK`, so an
  // undefined JSON body is success.
  const cid = (res.body as { IpfsHash?: string } | undefined)?.IpfsHash;
  let unpinned = false;
  if (cid) {
    const del = await fetchJsonWithTimeout(
      `https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${jwt}` } },
      Math.min(timeoutMs, 1500),
    );
    unpinned = del.kind === "ok" && del.status < 400;
  }
  return {
    id: "pinata.pinQuota",
    category: "ipfs",
    status: "pass",
    message:
      "pin capability verified — this wrote one tiny pin (dexe-mcp-doctor-probe) to your Pinata account" +
      (unpinned
        ? " and removed it again."
        : "; removing it failed (a pinning-only JWT cannot unpin) — delete it at app.pinata.cloud if you care."),
  };
}

// ─── signer broadcast guards ─────────────────────────────────────────────

function signerGuardConfigCheck(config?: WriteConfig): CheckResult[] {
  const out: CheckResult[] = [];

  // Report the RESOLVED signer, not the raw env. Since 0.30.1 a malformed
  // broadcast-guard var fails closed (signing off) while the env var it was
  // set from is still present — reading process.env here would tell the user
  // their hot key is "the active signer" while every broadcast is refused.
  const hotKeySet = process.env.DEXE_PRIVATE_KEY?.trim();
  const hotKeyActive = config ? config.privateKey !== undefined : Boolean(hotKeySet);
  if (hotKeySet && hotKeyActive) {
    out.push({
      id: "signer.hotKey",
      category: "signer",
      status: "warn",
      message:
        "⚠️ NOT SAFE — DEXE_PRIVATE_KEY is the active signer: a hot key in plaintext on disk.",
      remediation:
        "Prefer WalletConnect: unset DEXE_PRIVATE_KEY and run dexe_wc_connect (the phone signs, key never on disk). If you must keep a hot key, use only a throwaway/test wallet.",
    });
  } else if (hotKeySet && !hotKeyActive) {
    out.push({
      id: "signer.hotKey",
      category: "signer",
      status: "fail",
      message:
        "DEXE_PRIVATE_KEY is set but signing is DISABLED — the key was rejected, or a broadcast-guard variable is malformed and the server failed closed rather than broadcasting unguarded.",
      remediation:
        "See the startup.* rows above for the offending variable, fix it in .env, then restart Claude Code. Until then every write tool refuses to broadcast.",
    });
  }

  const allow = process.env.DEXE_SIGNER_ALLOWLIST?.trim();
  if (allow) {
    const entries = allow.split(",").map(s => s.trim()).filter(Boolean);
    const bad = entries.filter(e => !/^0x[0-9a-fA-F]{40}$/.test(e));
    if (bad.length) {
      out.push({
        id: "signer.allowlist",
        category: "signer",
        status: "fail",
        message: `invalid address(es): ${bad.join(", ")}`,
      });
    } else {
      out.push({
        id: "signer.allowlist",
        category: "signer",
        status: "pass",
        message: `${entries.length} addr(s) allowed`,
      });
    }
  }

  const maxV = process.env.DEXE_SIGNER_MAX_VALUE_WEI?.trim();
  if (maxV) {
    try {
      BigInt(maxV);
      out.push({
        id: "signer.maxValue",
        category: "signer",
        status: "pass",
        message: `cap=${maxV} wei`,
      });
    } catch {
      out.push({
        id: "signer.maxValue",
        category: "signer",
        status: "fail",
        message: `not a wei integer: ${maxV}`,
      });
    }
  }

  const rate = process.env.DEXE_SIGNER_MAX_BROADCASTS_PER_MIN?.trim();
  if (rate) {
    const n = Number(rate);
    if (Number.isInteger(n) && n > 0) {
      out.push({
        id: "signer.rate",
        category: "signer",
        status: "pass",
        message: `${n}/min`,
      });
    } else {
      out.push({
        id: "signer.rate",
        category: "signer",
        status: "fail",
        message: `not a positive int: ${rate}`,
      });
    }
  }

  // Agent keyring visibility: count configured slots + which naming supplied
  // them (DEXE_AGENT_PK_* vs the AGENT_PK_*/AGENT_FUNDER_PK swarm aliases).
  const slots: string[] = [];
  for (let n = 1; n <= 16; n++) {
    if (process.env[`DEXE_AGENT_PK_${n}`]?.trim()) slots.push(`agent${n}`);
    else if (process.env[`AGENT_PK_${n}`]?.trim()) slots.push(`agent${n}(alias)`);
  }
  if (process.env.DEXE_AGENT_FUNDER_PK?.trim()) slots.push("funder");
  else if (process.env.AGENT_FUNDER_PK?.trim()) slots.push("funder(alias)");
  if (slots.length > 0) {
    // Same resolved-vs-raw distinction as signer.hotKey above: the env vars can
    // be present while the keyring was dropped (no RPC, or a failed-closed guard).
    const loaded = config ? Object.keys(config.agentKeys).length : slots.length;
    out.push(
      loaded > 0
        ? {
            id: "signer.agentKeyring",
            category: "signer",
            status: "pass",
            message: `${loaded} keyring slot(s): ${slots.join(", ")} — select per call via signerKey`,
          }
        : {
            id: "signer.agentKeyring",
            category: "signer",
            status: "fail",
            message: `${slots.length} keyring slot(s) configured (${slots.join(", ")}) but NONE are loaded — signing is disabled.`,
            remediation:
              "See the startup.* rows above: either no RPC is configured, or a broadcast-guard variable is malformed. Fix it in .env and restart Claude Code.",
          },
    );
  }

  return out;
}

// ─── a signer with no RPC ────────────────────────────────────────────────

/** Listed first among the chain rows: a hot key the server cannot broadcast with. */
function signerNeedsRpcCheck(config: WriteConfig | undefined): CheckResult[] {
  if (!config) return [];
  if (process.env.DEXE_PRIVATE_KEY?.trim() && config.chains.size === 0) {
    return [
      {
        id: "chain.signerNeedsRpc",
        category: "signer",
        status: "fail",
        message: "DEXE_PRIVATE_KEY is set but no RPC is configured — broadcasts will fail.",
        remediation: "Set DEXE_RPC_URL_TESTNET or DEXE_RPC_URL_MAINNET in .env.",
      },
    ];
  }
  return [];
}
