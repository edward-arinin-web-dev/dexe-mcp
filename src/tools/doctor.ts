import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../config.js";
import {
  runAllChecks,
  type CheckResult,
  type CheckStatus,
} from "../diag/checks.js";

interface Tally {
  passed: number;
  warnings: number;
  failures: number;
  status: CheckStatus;
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
  return { passed, warnings, failures, status };
}

/**
 * `dexe_doctor` — first stop when an MCP tool reports an env-related failure.
 * Walks ENV_SPEC, runs network reachability for everything configured, and
 * returns a structured report with paste-ready remediation hints.
 *
 * Read-only. Never broadcasts. Safe to call at session start.
 */
export function registerDoctorTool(server: McpServer, config: DexeConfig): void {
  server.tool(
    "dexe_doctor",
    "Diagnose env-var setup. Runs presence + reachability checks (RPC, Pinata, IPFS gateway DNS, subgraph, backend) and returns a pass/warn/fail report with remediation hints. " +
      "Call FIRST when the user reports an env-related failure — it pinpoints the missing or invalid value. " +
      "Read-only: never broadcasts, never writes. ",
    {
      _placeholder: z
        .boolean()
        .optional()
        .describe("Unused; tool takes no input."),
    },
    async () => {
      const checks = await runAllChecks({ config });
      const summary = tally(checks);
      const remediationSummary = checks
        .filter(c => c.status !== "pass" && c.remediation)
        .map(c => `${c.id}: ${c.remediation!.split("\n")[0]!}`);

      const startupTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
      const structured = {
        summary,
        checks,
        remediationSummary,
        startupTime,
        uptimeSec: Math.round(process.uptime()),
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
}): string {
  const lines: string[] = [];
  lines.push(
    `dexe-mcp doctor — ${r.summary.status.toUpperCase()}: ${r.summary.passed} pass / ${r.summary.warnings} warn / ${r.summary.failures} fail`,
  );
  lines.push(
    `server started ${r.startupTime} (uptime ${r.uptimeSec}s). ` +
      `If you just edited .env, restart Claude Code so the new values load.`,
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
