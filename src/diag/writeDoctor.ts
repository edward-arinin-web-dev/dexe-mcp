import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveToolsetsIn,
  type CheckResult,
  type EnvEntry,
  type EnvLoadReport,
  type ToolsetTable,
} from "@dexe-network/dexe-mcp/core";
import type { WriteConfig } from "../config.js";
import { DEFAULTS } from "../config.js";
import { ENV_SPEC, ENV_SPEC_DEV, ENV_SPEC_WRITE } from "../env/schema.js";
import { envLoadRecord, type EnvLoadRecord } from "../env/loadRecord.js";
import {
  pinataJwtCheck,
  pinataPinQuotaCheck,
  signerGuardConfigCheck,
  signerModeChecks,
  signerNeedsRpcCheck,
  surfaceModeCheck,
  WRITE_ENV_FILE_WORDING,
} from "./writeChecks.js";

/**
 * ── `dexe_write_doctor` — the write server's own checks (1.0.0) ────────────
 *
 * `dexe_doctor` is the read server's (D1): RPC, IPFS gateway, subgraph and
 * backend reachability, read env vars. This tool reports what only the server
 * that signs, broadcasts and pins can know:
 *
 *   - which tools it registers (`surface.mode`, DEXE_WRITE_STANDALONE);
 *   - the env values IT rejected at startup, the `.env` file IT loaded (and what
 *     shadows it), and the write/dev vars it reads;
 *   - the signer: mode, keystore file + KDF + permissions, the approval page's
 *     reachability, hot keys ignored or loaded, broadcast guards, keyring;
 *   - Pinata: the JWT (and, opt-in, one tiny pin); the WalletConnect project id;
 *   - the state file its write flows record DAOs and proposals in.
 *
 * No RPC / subgraph / backend / gateway probes: those are the read server's
 * `dexe_doctor`, and `npx dexe-mcp doctor` (the CLI) still runs every check of
 * both editions in one report. The row builders are the CLI's own
 * (./writeChecks.ts); the env-file rows mirror the read edition's wording over
 * this process's own startup record (src/env/loadRecord.ts).
 */
export const WRITE_DOCTOR_TOOL = "dexe_write_doctor";

export const WRITE_DOCTOR_DESCRIPTION =
  "Read-only. Diagnoses the write setup — the cause and the fix of a signing, upload or env failure: signer mode, " +
  "keystore and approval page, hot keys, broadcast guards, keyring, Pinata JWT, WalletConnect project id, the .env " +
  "file this server loaded and the values it rejected, and whether it registers the read tools " +
  "(DEXE_WRITE_STANDALONE) — pass/warn/fail rows with remediation. RPC, subgraph, backend and IPFS gateway " +
  "reachability is the read server's doctor. `probePin` is the one write: one tiny IPFS pin.";

const PROBE_PIN_DESCRIPTION = "Probe pin to Pinata (added, then removed) — use when an IPFS upload fails with HTTP 403.";

export interface WriteDoctorRunOptions {
  /** Run the Pinata pin probe (WRITES one tiny pin). Default false. */
  probePin?: boolean;
  /** Per-probe timeout. Default 3000 ms; the network phase is capped at 4×. */
  timeoutMs?: number;
  /** The startup `.env` record. Default: what src/index.ts recorded (null outside the server). */
  envRecord?: EnvLoadRecord | null;
}

/** Every row `dexe_write_doctor` reports, loudest first. */
export async function writeDoctorRows(config: WriteConfig, opts: WriteDoctorRunOptions = {}): Promise<CheckResult[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const record = opts.envRecord === undefined ? envLoadRecord() : opts.envRecord;
  const rows: CheckResult[] = [];
  rows.push(...surfaceModeCheck(config));
  rows.push(...startupRows(config, record));
  rows.push(...envFileRows(record));
  rows.push(...presenceRows());
  rows.push(...(await pinataRows(timeoutMs, opts.probePin === true)));
  rows.push(...signerModeChecks(config));
  rows.push(...signerGuardConfigCheck(config));
  rows.push(...signerNeedsRpcCheck(config));
  rows.push(...walletConnectRows(config));
  rows.push(...stateRows(config));
  return rows;
}

// ─── startup: values this process rejected ─────────────────────────────────

function startupRows(config: WriteConfig, record: EnvLoadRecord | null): CheckResult[] {
  if (config.startupIssues.length === 0) {
    return [
      { id: "startup.config", category: "process", status: "pass", message: "every env value parsed — nothing was rejected at startup" },
    ];
  }
  const where = winningReport(record)?.envFilePath ?? "your .env";
  return config.startupIssues.map((issue) => ({
    id: `startup.${issue.key}`,
    category: specEntry(issue.key)?.category ?? "process",
    status: "fail" as const,
    message: `${issue.message} The server did NOT exit: ${issue.fallback}.`,
    remediation: `Correct ${issue.key} in ${where}, then restart the MCP host — env is read once, at startup.`,
  }));
}

function specEntry(key: string): EnvEntry | undefined {
  return Object.prototype.hasOwnProperty.call(ENV_SPEC, key) ? (ENV_SPEC as Record<string, EnvEntry>)[key] : undefined;
}

// ─── which .env was loaded, and what shadows it ────────────────────────────

function winningReport(record: EnvLoadRecord | null): EnvLoadReport | undefined {
  const existing = record?.reports.filter((r) => r.envFileExists) ?? [];
  return existing.find((r) => r.envFileLoaded) ?? existing[0];
}

function summarizeKeys(keys: readonly string[], max = 12): string {
  return keys.length <= max ? keys.join(", ") : `${keys.slice(0, max).join(", ")} +${keys.length - max} more`;
}

/**
 * The `env.*` rows of the read edition's doctor, over this process's record and
 * in the write wording (`npx dexe-mcp init`, the signing keys). Same ids, so a
 * skill that branches on `env.file` / `env.shadowedKeys` reads both doctors alike.
 */
export function envFileRows(record: EnvLoadRecord | null): CheckResult[] {
  const wording = WRITE_ENV_FILE_WORDING;
  if (!record || (record.candidates.length === 0 && record.reports.length === 0)) {
    return [
      {
        id: "env.file",
        category: "process",
        status: "warn",
        message: ".env resolution was not recorded — this server did not start through its own entry point.",
        remediation: wording.notRecorded,
      },
    ];
  }
  const out: CheckResult[] = [];
  const winner = winningReport(record);
  const last = record.reports[record.reports.length - 1];
  if (!winner) {
    const hostKeys = last?.preExistingVars ?? [];
    out.push({
      id: "env.file",
      category: "process",
      status: "warn",
      message:
        `no .env file exists — tried, in order: ${record.candidates.join(" → ")}. ` +
        (hostKeys.length
          ? `Every DEXE_* value comes from the MCP host env block instead (${summarizeKeys(hostKeys)}).`
          : wording.zeroConfig),
      remediation: wording.createOne,
    });
  } else {
    out.push({
      id: "env.file",
      category: "process",
      status: "pass",
      message:
        `loaded ${winner.envFilePath} — ${winner.keysApplied.length} key(s) applied` +
        (winner.keysApplied.length ? `: ${summarizeKeys(winner.keysApplied)}` : "") +
        ` (Node ${winner.loadedNodeVersion})`,
      remediation: `Edit THIS file for env changes: ${winner.envFilePath}. Restart the MCP host afterwards.`,
    });
    const alsoPresent = record.reports.filter((r) => r.envFileExists && r !== winner);
    if (alsoPresent.length) {
      out.push({
        id: "env.file.precedence",
        category: "process",
        status: "warn",
        message: `${alsoPresent.length} lower-precedence .env file(s) also exist and lost: ${alsoPresent
          .map((r) => r.envFilePath)
          .join(", ")}. Keys already set by ${winner.envFilePath} are ignored in them.`,
        remediation: `Keep one file. Edit ${winner.envFilePath}, or delete/rename the others, then restart the MCP host.`,
      });
    }
    if (winner.keysShadowed.length) {
      out.push({
        id: "env.shadowedKeys",
        category: "process",
        status: "warn",
        message:
          `${winner.keysShadowed.length} key(s) in ${winner.envFilePath} were SHADOWED by values already in the environment: ` +
          `${summarizeKeys(winner.keysShadowed)}. process.loadEnvFile does not override pre-set keys, so editing them in that file changes nothing.`,
        remediation:
          "Remove those keys from the MCP host `env` block (the `env` object in .claude.json / your MCP client config) — " +
          "or change their values there instead — then restart the MCP host.",
      });
    }
  }
  record.reports
    .filter((r) => r.envFileExists)
    .forEach((r, i) => {
      for (const issue of r.parseIssues) {
        out.push({
          id: i === 0 ? `env.parse.${issue.trap}` : `env.parse.${issue.trap}.${i}`,
          category: "process",
          status: issue.severity,
          message: issue.message,
          remediation: issue.remediation,
        });
      }
    });
  if (last?.unknownDexeVars.length) {
    out.push({
      id: "env.unknownVars",
      category: "process",
      status: "warn",
      message: `unrecognized DEXE_* var(s): ${summarizeKeys(last.unknownDexeVars)} — nothing reads them (a typo silently disables the feature you set it for).`,
      remediation: `Check the spelling against docs/ENVIRONMENT.md, fix or delete the line in ${
        winner?.envFilePath ?? "your .env"
      }, then restart the MCP host.`,
    });
  }
  return out;
}

// ─── the write and dev vars this server reads ──────────────────────────────

/** One `env.<KEY>` row per write/dev var that is set (or required): set, redacted, or invalid. */
function presenceRows(): CheckResult[] {
  const out: CheckResult[] = [];
  const entries: Record<string, EnvEntry> = { ...ENV_SPEC_WRITE, ...ENV_SPEC_DEV };
  for (const [k, v] of Object.entries(entries)) {
    const raw = process.env[k];
    const set = !!raw?.trim();
    if (set) {
      const parsed = v.schema.safeParse(raw);
      out.push(
        parsed.success
          ? { id: `env.${k}`, category: v.category, status: "pass", message: v.secret ? "set (redacted)" : "set" }
          : {
              id: `env.${k}`,
              category: v.category,
              status: "fail",
              message: parsed.error.issues[0]?.message ?? "invalid value",
              remediation: `Fix ${k} in .env. ${v.doc}`,
            },
      );
    } else if (v.required) {
      out.push({
        id: `env.${k}`,
        category: v.category,
        status: "fail",
        message: "not set (required)",
        remediation: `Add ${k}=${v.example} to .env. ${v.doc}`,
      });
    }
  }
  return out;
}

// ─── Pinata (network) ──────────────────────────────────────────────────────

async function pinataRows(timeoutMs: number, probePin: boolean): Promise<CheckResult[]> {
  const budgetMs = timeoutMs * 4;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), budgetMs);
  });
  try {
    const result = await Promise.race([
      Promise.all([pinataJwtCheck(timeoutMs), pinataPinQuotaCheck(timeoutMs, probePin)]),
      deadline,
    ]);
    if (result === "timeout") {
      return [
        {
          id: "network.probes",
          category: "network",
          status: "warn",
          message: `the Pinata probes exceeded the ${budgetMs}ms budget and were abandoned.`,
          remediation: "Usually DNS or a proxy. Retry; uploads fail the same way until api.pinata.cloud answers.",
        },
      ];
    }
    return result.filter((r): r is CheckResult => r !== null);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── WalletConnect ─────────────────────────────────────────────────────────

function walletConnectRows(config: WriteConfig): CheckResult[] {
  if (config.walletConnectProjectId !== DEFAULTS.walletConnectProjectId) return [];
  return [
    {
      id: "walletconnect.sharedProjectId",
      category: "walletconnect",
      status: "warn",
      message: "WalletConnect pairs through the shared public project id shipped with the package. Fine for light use; rate-limited and shared.",
      remediation: "For production / heavy use set your own DEXE_WALLETCONNECT_PROJECT_ID (free at cloud.reown.com). See docs/ENVIRONMENT.md.",
    },
  ];
}

// ─── the state file write flows record into ────────────────────────────────

function stateRows(config: WriteConfig): CheckResult[] {
  const p = config.statePath;
  let probe = dirname(p);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    accessSync(probe, constants.W_OK);
    return [{ id: "state.path", category: "process", status: "pass", message: `writable (${p})` }];
  } catch {
    return [
      {
        id: "state.path",
        category: "process",
        status: "warn",
        message: `persistent-state path may not be writable: ${p}`,
        remediation:
          "Set DEXE_STATE_PATH to a writable location. Without it, the DAOs and proposals the write flows create are not " +
          "recorded across sessions (dexe_write_context, resume) — the tools still work.",
      },
    ];
  }
}

// ─── the tool ──────────────────────────────────────────────────────────────

interface Tally {
  passed: number;
  warnings: number;
  failures: number;
  status: CheckResult["status"];
  advisoryOnly: boolean;
}

function tally(rows: readonly CheckResult[]): Tally {
  const passed = rows.filter((r) => r.status === "pass").length;
  const warnings = rows.filter((r) => r.status === "warn").length;
  const failures = rows.filter((r) => r.status === "fail").length;
  return {
    passed,
    warnings,
    failures,
    status: failures > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    advisoryOnly: failures === 0 && warnings > 0,
  };
}

export function registerWriteDoctorTool(
  server: McpServer,
  config: WriteConfig,
  opts: { toolsets: ToolsetTable },
): void {
  server.registerTool(
    WRITE_DOCTOR_TOOL,
    {
      title: "Diagnose the write setup",
      description: WRITE_DOCTOR_DESCRIPTION,
      inputSchema: { probePin: z.boolean().optional().describe(PROBE_PIN_DESCRIPTION) },
    },
    async ({ probePin }) => {
      const checks = await writeDoctorRows(config, { probePin: probePin === true });
      const summary = tally(checks);
      const remediationSummary = checks
        .filter((c) => c.status !== "pass" && c.remediation)
        .map((c) => `${c.id}: ${c.remediation!.split("\n")[0]!}`);
      const table = opts.toolsets;
      const resolved = resolveToolsetsIn(table, config.toolsets ?? [...table.defaults]);
      const toolsets = {
        requested: resolved.requested,
        mode: resolved.full ? ("full" as const) : ("filtered" as const),
        loadedToolCount: resolved.full ? null : resolved.names!.size,
        availableSets: [...Object.keys(table.sets), "full"],
        ...(resolved.unknown.length ? { unknownSets: resolved.unknown } : {}),
      };
      const startupTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
      const structured = {
        summary,
        checks,
        remediationSummary,
        startupTime,
        surface: config.writeStandalone ? "standalone" : "write-only",
        toolsets,
      };
      return {
        content: [{ type: "text" as const, text: renderText(structured) }],
        structuredContent: structured,
      };
    },
  );
}

function renderText(r: {
  summary: Tally;
  checks: CheckResult[];
  remediationSummary: string[];
  startupTime: string;
  toolsets: { requested: string[]; mode: "full" | "filtered"; loadedToolCount: number | null; unknownSets?: string[] };
}): string {
  const lines: string[] = [];
  lines.push(
    r.summary.advisoryOnly
      ? `dexe-mcp write doctor — OK, no failures: ${r.summary.passed} pass / ${r.summary.warnings} advisory warning(s) / 0 fail.`
      : `dexe-mcp write doctor — ${r.summary.status.toUpperCase()}: ${r.summary.passed} pass / ${r.summary.warnings} warn / ${r.summary.failures} fail`,
  );
  lines.push(`server started ${r.startupTime}. If you just edited .env, restart the MCP host so the new values load.`);
  lines.push(
    r.toolsets.mode === "full"
      ? `toolsets: full — all tools loaded${r.toolsets.unknownSets?.length ? ` (unknown set(s): ${r.toolsets.unknownSets.join(", ")})` : ""}.`
      : `toolsets: [${r.toolsets.requested.join(", ")}] → ${r.toolsets.loadedToolCount} tools loaded. Set DEXE_TOOLSETS=full for all.`,
  );
  lines.push("");
  for (const c of r.checks) {
    const tag = c.status === "pass" ? " OK " : c.status === "warn" ? "WARN" : "FAIL";
    lines.push(`  [${tag}] ${c.id}  ${c.message}`);
    if (c.remediation) for (const rl of c.remediation.split("\n")) lines.push(`         → ${rl}`);
  }
  if (r.remediationSummary.length) {
    lines.push("");
    lines.push("To fix:");
    r.remediationSummary.forEach((m, i) => lines.push(`  ${i + 1}) ${m}`));
  }
  return lines.join("\n");
}
