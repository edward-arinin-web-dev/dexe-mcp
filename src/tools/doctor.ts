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

export interface DoctorOptions {
  /** The server's toolset table, for the `toolsets` report. Default: the read edition's (ungated). */
  toolsets?: ToolsetTable;
  /** Default: READ_DOCTOR_TEXT. */
  text?: DoctorText;
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
  const text = opts.text ?? READ_DOCTOR_TEXT;
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
      const checks = await runAllChecks({
        config,
        extraChecks: extraChecks?.({
          probePin: text.probePin !== undefined && (args as { probePin?: boolean } | undefined)?.probePin === true,
        }),
      });
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
