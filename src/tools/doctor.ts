import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadConfig } from "../configRead.js";
import {
  runAllChecks,
  type CheckResult,
  type CheckStatus,
  type DoctorExtraChecks,
} from "../diag/checks.js";
import { getEnvLoadState } from "../env/loader.js";
import { READ_EDITION_TOOLSETS, resolveToolsetsIn, type ToolsetTable } from "./toolsets.js";

/** The doctor's own wording — per edition, because the checks are. */
export interface DoctorText {
  description: string;
  /**
   * Description of the `probePin` input. Omitted: the input is not published —
   * only an edition whose extra checks own a pin probe has one.
   */
  probePin?: string;
}

/** The read edition's doctor: read checks only, no pin probe. */
export const READ_DOCTOR_TEXT: DoctorText = {
  description:
    "Read-only. Diagnoses env setup — the cause and the fix of an env-related failure: presence + reachability checks (RPC, IPFS gateway DNS, subgraph, backend) as pass/warn/fail with remediation hints. " +
    "Warnings are advisories — a healthy zero-config install always has some.",
};

/** The read edition served remotely: upstream health only, nothing about the host. */
export const REMOTE_DOCTOR_TEXT: DoctorText = {
  description:
    "Read-only. Reports whether this server's upstreams answer right now — the RPC per chain, the DeXe subgraphs, " +
    "the DeXe backend and the IPFS gateway — as pass/warn/fail rows. A failing row explains failing reads.",
};

export interface DoctorOptions {
  /** The server's toolset table, for the `toolsets` report. Default: the read edition's (ungated). */
  toolsets?: ToolsetTable;
  /** Default: READ_DOCTOR_TEXT (REMOTE_DOCTOR_TEXT with `remote`). */
  text?: DoctorText;
  /**
   * Served to many callers over HTTP. The report keeps the upstream rows and
   * drops everything about the host: env files and paths, which vars are set,
   * rejected values, the state path, start time, endpoint hostnames, and every
   * remediation (only the operator can act on one).
   */
  remote?: boolean;
}

/** What a remote caller is told instead of remediation it cannot act on. */
const REMOTE_NOTE =
  "This is a hosted read-only server: its operator sets the RPC, subgraph, backend and IPFS endpoints. A failing " +
  "row means that upstream is down or misconfigured right now — reads that depend on it fail until it recovers; " +
  "retry later.";

/** Rows about the host, its env and its files — never served remotely. */
function hostRow(id: string): boolean {
  return (id.startsWith("env.") && id !== "env.sharedDefaults") || id.startsWith("startup.") || id.startsWith("state.");
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s,;)'"]+/gi;
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;
const IPV4_RE = /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?(?![\w.])/g;
const IPV6_RE = /\[[0-9a-f.%]*:[0-9a-f:.%]*\](?::\d{1,5})?|(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi;
const ENV_NAME_RE = /\bDEXE_[A-Z0-9_*<>]+/g;

/**
 * Endpoint URLs, IP addresses and hostnames out of a row message: an
 * operator's RPC or gateway host — or the address it resolved to — is not
 * public. Setting names go too: a remote caller cannot set them.
 */
export function redactEndpoints(text: string): string {
  return text
    .replace(URL_RE, "<endpoint>")
    .replace(IPV6_RE, "<ip>")
    .replace(IPV4_RE, "<ip>")
    .replace(HOSTNAME_RE, "<host>")
    .replace(ENV_NAME_RE, "a server setting");
}

/** The remote form of a check list: upstream rows only, no remediation, no hostnames or addresses. */
export function remoteCheckRows(checks: readonly CheckResult[]): CheckResult[] {
  return checks
    .filter((c) => !hostRow(c.id))
    .map((c) => ({ id: c.id, category: c.category, status: c.status, message: remoteMessage(c) }));
}

/**
 * The gateway DNS row is ABOUT a host name — one without dots (`internal-gw`)
 * would pass every hostname pattern — so remotely it says only the outcome.
 */
function remoteMessage(c: CheckResult): string {
  if (c.id === "ipfs.gateway.dns") {
    return c.status === "pass"
      ? "the IPFS gateway's name resolves"
      : "the IPFS gateway's name does not resolve, or the gateway does not answer";
  }
  return redactEndpoints(c.message);
}

interface Tally {
  passed: number;
  warnings: number;
  failures: number;
  status: CheckStatus;
  /**
   * Nothing failed, but warnings exist — the normal zero-config state (no
   * .env, public RPC fallback, shared Graph/WC/backend defaults). ADD-ONLY:
   * `status` keeps its legacy mapping because docs and skill branches read it.
   */
  advisoryOnly: boolean;
}

function tally(results: CheckResult[]): Tally {
  let passed = 0;
  let warnings = 0;
  let failures = 0;
  for (const r of results) {
    if (r.status === "pass") passed++;
    else if (r.status === "warn") warnings++;
    else failures++;
  }
  const status: CheckStatus = failures > 0 ? "fail" : warnings > 0 ? "warn" : "pass";
  return { passed, warnings, failures, status, advisoryOnly: failures === 0 && warnings > 0 };
}

/**
 * `dexe_doctor` — first stop when an MCP tool reports an env-related failure.
 * Walks ENV_SPEC, runs network reachability for everything configured, and
 * returns a structured report with paste-ready remediation hints.
 *
 * Read-only by default. Never broadcasts. Safe to call at session start. The
 * one exception is the opt-in `probePin` input, which writes a tiny IPFS pin
 * and says so in its own result row.
 *
 * The checks here are the read ones; `extraChecks` adds another edition's (the
 * single server passes the write checks, src/diag/writeChecks.ts, which own the
 * pin probe — `probePin` is handed through to them, and their `DoctorText`
 * publishes the input). The toolset report reads the server's own table.
 */
export function registerDoctorTool<C extends ReadConfig>(
  server: McpServer,
  config: C,
  extraChecks?: DoctorExtraChecks<C>,
  opts: DoctorOptions = {},
): void {
  const table = opts.toolsets ?? READ_EDITION_TOOLSETS;
  const remote = opts.remote === true;
  const text = opts.text ?? (remote ? REMOTE_DOCTOR_TEXT : READ_DOCTOR_TEXT);
  server.tool(
    "dexe_doctor",
    text.description,
    {
      _placeholder: z
        .boolean()
        .optional()
        .describe("Unused; tool takes no input."),
      ...(text.probePin ? { probePin: z.boolean().optional().describe(text.probePin) } : {}),
    },
    async (args) => {
      const all = await runAllChecks({
        config,
        extraChecks: extraChecks?.({
          probePin: text.probePin !== undefined && (args as { probePin?: boolean } | undefined)?.probePin === true,
        }),
      });
      if (remote) {
        const rows = remoteCheckRows(all);
        const structured = {
          summary: tally(rows),
          checks: rows,
          note: REMOTE_NOTE,
          // A count, not the values: a rejected value can be a credential.
          rejectedSettings: config.startupIssues.length,
        };
        return {
          content: [{ type: "text" as const, text: renderRemoteText(structured) }],
          structuredContent: structured,
        };
      }
      const checks = all;
      const summary = tally(checks);
      const remediationSummary = checks
        .filter(c => c.status !== "pass" && c.remediation)
        .map(c => `${c.id}: ${c.remediation!.split("\n")[0]!}`);

      const startupTime = new Date(Date.now() - process.uptime() * 1000).toISOString();

      // Phase 2 — report which tool profiles are active this session.
      const resolvedSets = resolveToolsetsIn(table, config.toolsets ?? [...table.defaults]);
      const toolsets = {
        requested: resolvedSets.requested,
        mode: resolvedSets.full ? ("full" as const) : ("filtered" as const),
        loadedToolCount: resolvedSets.full ? null : resolvedSets.names!.size,
        // An ungated server (the read edition) has nothing to switch on.
        ...(table.ungated
          ? { ungated: true as const, availableSets: Object.keys(table.sets) }
          : {
              availableSets: [...Object.keys(table.sets), "full"],
              remediation:
                "Set DEXE_TOOLSETS=full to load every tool, or add sets (read, vote, governor, dev). Restart Claude Code after editing .env.",
            }),
        ...(resolvedSets.unknown.length ? { unknownSets: resolvedSets.unknown } : {}),
      };

      // Which .env this server actually loaded, machine-readable. An assisting
      // AI is told (CLAUDE.md, docs/SETUP.md, /dexe-setup) to confirm this
      // before editing anything, and it must not have to parse prose for it.
      const envState = getEnvLoadState();
      const loadedEnv = envState.reports.find(r => r.envFileExists && r.envFileLoaded);
      const envFile = {
        loadedPath: loadedEnv?.envFilePath ?? null,
        candidatesTried: envState.candidates,
        keysFromFile: loadedEnv?.keysApplied ?? [],
        shadowedKeys: loadedEnv?.keysShadowed ?? [],
      };

      const structured = {
        summary,
        checks,
        remediationSummary,
        startupTime,
        uptimeSec: Math.round(process.uptime()),
        envFile,
        startupIssues: config.startupIssues,
        toolsets,
      };

      return {
        content: [{ type: "text" as const, text: renderText(structured) }],
        structuredContent: structured,
      };
    },
  );
}

function renderRemoteText(r: { summary: Tally; checks: CheckResult[]; note: string; rejectedSettings: number }): string {
  const lines = [
    `doctor — ${r.summary.status.toUpperCase()}: ${r.summary.passed} pass / ${r.summary.warnings} warn / ${r.summary.failures} fail`,
    r.note,
  ];
  if (r.rejectedSettings > 0) {
    lines.push(`${r.rejectedSettings} server setting(s) were rejected at startup and fell back to defaults.`);
  }
  lines.push("");
  for (const c of r.checks) {
    const tag = c.status === "pass" ? " OK " : c.status === "warn" ? "WARN" : "FAIL";
    lines.push(`  [${tag}] ${c.id}  ${c.message}`);
  }
  return lines.join("\n");
}

function renderText(r: {
  summary: Tally;
  checks: CheckResult[];
  remediationSummary: string[];
  startupTime: string;
  uptimeSec: number;
  envFile: {
    loadedPath: string | null;
    candidatesTried: string[];
    keysFromFile: string[];
    shadowedKeys: string[];
  };
  startupIssues: { key: string; message: string; fallback: string }[];
  toolsets: {
    requested: string[];
    mode: "full" | "filtered";
    loadedToolCount: number | null;
    ungated?: true;
    unknownSets?: string[];
  };
}): string {
  const lines: string[] = [];
  lines.push(
    r.summary.advisoryOnly
      ? `dexe-mcp doctor — OK, no failures: ${r.summary.passed} pass / ${r.summary.warnings} advisory warning(s) / 0 fail. Advisories are optional upgrades, not errors.`
      : `dexe-mcp doctor — ${r.summary.status.toUpperCase()}: ${r.summary.passed} pass / ${r.summary.warnings} warn / ${r.summary.failures} fail`,
  );
  lines.push(
    `server started ${r.startupTime} (uptime ${r.uptimeSec}s). ` +
      `If you just edited .env, restart Claude Code so the new values load.`,
  );
  lines.push(
    r.envFile.loadedPath
      ? `env file: ${r.envFile.loadedPath} — ${r.envFile.keysFromFile.length} key(s) applied` +
          (r.envFile.shadowedKeys.length
            ? `, ${r.envFile.shadowedKeys.length} SHADOWED by the MCP host env block (${r.envFile.shadowedKeys.join(", ")})`
            : "")
      : `env file: none loaded — tried ${r.envFile.candidatesTried.join(" → ") || "(not recorded)"}`,
  );
  if (r.startupIssues.length) {
    lines.push(
      `config: ${r.startupIssues.length} env value(s) were rejected at startup and fell back to defaults — the server stayed up; see the startup.* rows below.`,
    );
  }
  lines.push(
    r.toolsets.ungated
      ? `toolsets: all ${r.toolsets.loadedToolCount} tools loaded (this server has no profiles to pick).`
      : r.toolsets.mode === "full"
        ? `toolsets: full — all tools loaded${r.toolsets.unknownSets?.length ? ` (unknown set(s): ${r.toolsets.unknownSets.join(", ")})` : ""}.`
        : `toolsets: [${r.toolsets.requested.join(", ")}] → ${r.toolsets.loadedToolCount} tools loaded. Set DEXE_TOOLSETS=full for all.`,
  );
  lines.push("");
  for (const c of r.checks) {
    const tag = c.status === "pass" ? " OK " : c.status === "warn" ? "WARN" : "FAIL";
    lines.push(`  [${tag}] ${c.id}  ${c.message}`);
    if (c.remediation) {
      for (const rl of c.remediation.split("\n")) {
        lines.push(`         → ${rl}`);
      }
    }
  }
  if (r.remediationSummary.length) {
    lines.push("");
    lines.push("To fix:");
    r.remediationSummary.forEach((m, i) => lines.push(`  ${i + 1}) ${m}`));
  }
  return lines.join("\n");
}
