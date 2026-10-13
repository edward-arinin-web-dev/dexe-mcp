import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { READ_SERVER_NPX } from "../readPackage.js";
import type { WriteConfig } from "../config.js";
import { DEFAULTS, hotKeyEnvNames } from "../config.js";
import { ignoredHotKeySentence } from "../lib/signerMode.js";
import { keystorePermissionIssues, parseKeystoreMeta, weakKdfReason } from "../lib/keystore.js";
import {
  fetchJsonWithTimeout,
  safeErrorMessage,
  type CheckResult,
  type DoctorText,
  type EnvFileWording,
  type ExtraChecks,
} from "@dexe-network/dexe-mcp/core";
import { FULL_ENV_SURFACE } from "../env/schema.js";
import { READ_TOOLS, WRITE_TOOLS } from "../editions.js";

/**
 * The doctor's wording on a server that runs these checks: Pinata among the
 * probes, and the opt-in pin probe as an input.
 */
export const WRITE_DOCTOR_TEXT: DoctorText = {
  description:
    "Read-only. Diagnoses env setup — the cause and the fix of an env-related failure: presence + reachability checks (RPC, Pinata, IPFS gateway DNS, subgraph, backend) as pass/warn/fail with remediation hints. " +
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
    config: (config) => [
      ...surfaceModeCheck(config),
      ...signerModeChecks(config),
      ...signerGuardConfigCheck(config),
      ...signerNeedsRpcCheck(config),
    ],
    sharedDefaults: {
      inUse: (config) =>
        config.walletConnectProjectId === DEFAULTS.walletConnectProjectId ? ["WalletConnect project id"] : [],
      fix: "DEXE_WALLETCONNECT_PROJECT_ID",
    },
    envFileWording: WRITE_ENV_FILE_WORDING,
    setupGuide: "Run /dexe-setup for a guided walkthrough.",
    // state.json: the DAOs and proposals the write flows record.
    statePath: true,
  };
}

/** The `env.file` rows as the single server words them: its setup wizard, its signing keys. */
export const WRITE_ENV_FILE_WORDING: EnvFileWording = {
  zeroConfig: "Reads still work zero-config; signing and IPFS uploads do not.",
  createOne:
    "Create one with `npx dexe-mcp init` (writes ~/.dexe-mcp/.env), or set DEXE_ENV_FILE to an absolute path, then restart Claude Code. Editing a .env at any other location — including a repo checkout the server is not launched from — has no effect.",
  notRecorded:
    "Run `npx dexe-mcp doctor`, or call dexe_write_doctor inside Claude Code, to see what the server itself loaded.",
};

// ─── pinata jwt ──────────────────────────────────────────────────────────

export async function pinataJwtCheck(timeoutMs: number): Promise<CheckResult | null> {
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
      "Confirm with `npx dexe-mcp doctor --probe-pin` (or dexe_write_doctor {probePin:true}), then free up pins / upgrade at app.pinata.cloud, or rotate DEXE_PINATA_JWT.",
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
export async function pinataPinQuotaCheck(timeoutMs: number, enabled: boolean): Promise<CheckResult | null> {
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

// ─── which tools this server registers (1.0.0) ─────────────────────────────

/**
 * `DEXE_WRITE_STANDALONE`: write tools only (the default — the DeXe read server
 * beside this one serves the reads), or the read tools too. Always a pass: both
 * are valid setups; the row says which one this process is, so a "tool not
 * found" for a read tool has its explanation in the report.
 */
export function surfaceModeCheck(config: WriteConfig | undefined, env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  if (!config) return [];
  return [
    config.writeStandalone
      ? {
          id: "surface.mode",
          category: "core",
          status: "pass",
          message:
            `standalone (DEXE_WRITE_STANDALONE=1) — this server registers the ${READ_TOOLS.length} read tools next to ` +
            `the ${WRITE_TOOLS.length} write tools; no read server is needed beside it`,
        }
      : {
          id: "surface.mode",
          category: "core",
          status: "pass",
          message:
            `write-only — the ${WRITE_TOOLS.length} write tools; the ${READ_TOOLS.length} read tools come from the DeXe ` +
            "read server (dexe-mcp-read): dexe_context, dexe_guide, dexe_doctor, dexe_dao_info, dexe_read_* (read server)",
          remediation: runningAsPlugin(env)
            ? "The Claude Code plugin starts the read server as `dexe-read` next to this one. If its tools are " +
              "missing, check that server in /mcp and restart Claude Code. (DEXE_WRITE_STANDALONE=1 here would " +
              "duplicate the 54 read tools.)"
            : `If the read tools are missing, add the read server to the MCP host config next to this one — ` +
              `\`${READ_SERVER_NPX}\` (or the \`dexe-read\` entry \`npx dexe-mcp init\` prints) — or set ` +
              "DEXE_WRITE_STANDALONE=1 to register them here too. Restart the MCP host after either.",
        },
  ];
}

/**
 * Is this the Claude Code plugin's bundle? The plugin starts both servers, so
 * "install the read server" is the wrong advice there. Claude Code passes
 * CLAUDE_PLUGIN_ROOT to a plugin's processes; the bundled read server next to
 * this file (dexe-plugin/server/read/bin.mjs) says the same without it.
 */
export function runningAsPlugin(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDE_PLUGIN_ROOT?.trim()) return true;
  try {
    return existsSync(resolve(dirname(fileURLToPath(import.meta.url)), "read", "bin.mjs"));
  } catch {
    return false;
  }
}

// ─── signer mode, keystore, approval page (0.37.0) ─────────────────────────

/**
 * What signs, and whether a human confirms it. One row always (`signer.mode`),
 * plus the rows that only make sense for the resolved mode.
 */
export function signerModeChecks(config: WriteConfig | undefined, env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  if (!config?.signerMode) return [];
  const out: CheckResult[] = [];
  const mode = config.signerMode;
  const hot = hotKeyEnvNames(env);
  const hasHotKeyLoaded = !!config.privateKey || Object.keys(config.agentKeys ?? {}).length > 0;

  if (mode === "unattended") {
    const fence = config.unattendedChains ?? null;
    out.push({
      id: "signer.mode",
      category: "signer",
      status: hasHotKeyLoaded ? "warn" : "fail",
      message: hasHotKeyLoaded
        ? `unattended — hot keys sign with NO human confirmation, on chain(s) ${fence?.join(", ") ?? "any"} only`
        : "DEXE_SIGNER_MODE=unattended but no hot key is loaded — nothing can sign",
      ...(hasHotKeyLoaded ? {} : { remediation: "Set DEXE_PRIVATE_KEY (or the keyring), or pick another DEXE_SIGNER_MODE." }),
    });
    const mainnet = fence === null || fence.includes(56) || fence.includes(1);
    if (hasHotKeyLoaded && mainnet && !(config.signerAllowlist?.length && config.signerMaxValueWei !== undefined)) {
      out.push({
        id: "signer.unattendedMainnet",
        category: "signer",
        status: "warn",
        message:
          (fence === null ? "unattended signing is not fenced to testnet" : "unattended signing includes a mainnet") +
          " and the B6/B7 caps (DEXE_SIGNER_ALLOWLIST + DEXE_SIGNER_MAX_VALUE_WEI) are not both set — an AI with a hot key can move real funds anywhere.",
        remediation:
          "Set DEXE_SIGNER_ALLOWLIST and DEXE_SIGNER_MAX_VALUE_WEI, or keep DEXE_UNATTENDED_CHAINS=97, or use keystore / walletconnect mode for mainnet.",
      });
    }
  } else {
    out.push({
      id: "signer.mode",
      category: "signer",
      status: mode === "keystore" && !config.keystore ? "fail" : "pass",
      message:
        mode === "walletconnect"
          ? "walletconnect — your phone wallet signs every transaction (recommended)"
          : mode === "readonly"
            ? "readonly — this server never signs; write tools return unsigned payloads"
            : config.keystore
              ? `keystore — ${config.keystore.address} signs after the owner approves each batch with its password on a local page`
              : "keystore — but no usable keystore was found, so nothing can sign",
      ...(mode === "keystore" && !config.keystore
        ? { remediation: "In a terminal: `npx dexe-mcp key create` (or `key import`), then restart. See the startup row for the path." }
        : {}),
    });
    if (config.hotKeysIgnored) {
      // The setup that signed unattended before 1.0.0. It now signs nothing
      // with the key, so the owner has to choose — a fail, not a warn. Safest
      // way out first; unattended only with the owner's go-ahead.
      out.push({
        id: "signer.hotKeyIgnored",
        category: "signer",
        status: "fail",
        message: ignoredHotKeySentence(config.hotKeysIgnored),
        remediation:
          "Ask the owner which: (1) delete the key lines and use dexe_wc_connect (recommended); (2) `npx dexe-mcp key " +
          "import --from-env` in a terminal → keystore, the owner approves each batch; (3) bots/CI only: " +
          "DEXE_SIGNER_MODE=unattended (no confirmation; DEXE_UNATTENDED_CHAINS, default 97). Then restart.",
      });
    } else if (hot.length > 0) {
      out.push({
        id: "signer.hotKeyIgnored",
        category: "signer",
        status: "warn",
        message: `${hot.join(", ")} ${hot.length === 1 ? "is" : "are"} set but IGNORED in ${mode} mode — and still sit in plaintext on disk.`,
        remediation:
          "Move the primary key into the encrypted keystore with `npx dexe-mcp key import --from-env` (it removes the plaintext line), " +
          "or delete the lines. Keyring slots are for DEXE_SIGNER_MODE=unattended only.",
      });
    }
  }

  if (mode === "keystore" && config.keystore) {
    const issues: string[] = [];
    let status: CheckResult["status"] = "pass";
    try {
      const meta = parseKeystoreMeta(readFileSync(config.keystore.file, "utf8"));
      const weak = weakKdfReason(meta);
      if (weak) {
        // Keystore mode refuses to sign with it (src/config.ts, approval/index.ts).
        issues.push(weak);
        status = "fail";
      }
      for (const p of keystorePermissionIssues(config.keystore.file)) {
        issues.push(p);
        if (status !== "fail") status = "warn";
      }
    } catch (e) {
      issues.push(`unreadable: ${safeErrorMessage(e)}`);
      status = "fail";
    }
    out.push({
      id: "signer.keystore",
      category: "signer",
      status,
      message: issues.length ? `${config.keystore.file}: ${issues.join("; ")}` : `${config.keystore.file} (scrypt, permissions ok)`,
      ...(process.platform === "win32" && status === "pass"
        ? { remediation: "On Windows the file is protected by your profile folder's ACL (you and administrators)." }
        : {}),
    });
    const ssh = !!(env.SSH_CONNECTION || env.SSH_TTY);
    const noDisplay = process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
    if (ssh || noDisplay) {
      out.push({
        id: "approval.browser",
        category: "signer",
        status: "warn",
        message:
          "the approval page is served on 127.0.0.1 of THIS machine and there is no local desktop browser here" +
          (ssh ? " (SSH session)" : " (no DISPLAY)") +
          " — approvals will wait until someone opens the link on this machine.",
        remediation:
          "Forward the port (ssh -L) and open the printed link locally, or use DEXE_SIGNER_MODE=walletconnect on headless hosts.",
      });
    } else if (config.approvalOpenBrowser === false) {
      out.push({
        id: "approval.browser",
        category: "signer",
        status: "pass",
        message: "DEXE_APPROVAL_OPEN_BROWSER=0 — the approval link is printed, not opened",
      });
    }
    if (env.DEXE_KEYSTORE_PASSWORD_FILE?.trim()) {
      out.push({
        id: "signer.passwordFile",
        category: "signer",
        status: "warn",
        message: "DEXE_KEYSTORE_PASSWORD_FILE is ignored in keystore mode — the owner types the password on the approval page.",
        remediation: "Remove it (it is for DEXE_SIGNER_MODE=unattended / CI only), and delete the password file.",
      });
    }
  }
  return out;
}

// ─── signer broadcast guards ─────────────────────────────────────────────

export function signerGuardConfigCheck(config?: WriteConfig): CheckResult[] {
  const out: CheckResult[] = [];

  // Report the RESOLVED signer, not the raw env. Since 0.30.1 a malformed
  // broadcast-guard var fails closed (signing off) while the env var it was
  // set from is still present — reading process.env here would tell the user
  // their hot key is "the active signer" while every broadcast is refused.
  // Outside unattended mode a present hot key is IGNORED by design, not
  // "disabled by a fault" — signer.hotKeyIgnored above says so.
  const unattended = !config?.signerMode || config.signerMode === "unattended";
  const hotKeySet = unattended ? process.env.DEXE_PRIVATE_KEY?.trim() : undefined;
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
  for (let n = 1; n <= 16 && unattended; n++) {
    if (process.env[`DEXE_AGENT_PK_${n}`]?.trim()) slots.push(`agent${n}`);
    else if (process.env[`AGENT_PK_${n}`]?.trim()) slots.push(`agent${n}(alias)`);
  }
  if (unattended && process.env.DEXE_AGENT_FUNDER_PK?.trim()) slots.push("funder");
  else if (unattended && process.env.AGENT_FUNDER_PK?.trim()) slots.push("funder(alias)");
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
export function signerNeedsRpcCheck(config: WriteConfig | undefined): CheckResult[] {
  if (!config) return [];
  if (config.signerMode && config.signerMode !== "unattended") return [];
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
