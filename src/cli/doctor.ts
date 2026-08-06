import { loadConfig } from "../config.js";
import { runAllChecks } from "../diag/checks.js";
import { getEnvLoadState } from "../env/loader.js";

/**
 * CLI entrypoint: `npx dexe-mcp doctor`. Runs the same check suite as the
 * MCP tool, prints a flat colorless table to stdout, exits with:
 *   - 0 when every check passes
 *   - 1 when there are warnings but no failures
 *   - 2 when at least one check fails
 *
 * Designed for both human terminal use and CI pipelines. This is the command
 * every doc points at when the server itself misbehaves, so it must run even
 * when the config is degraded — `loadConfig` never exits, and a throw here is
 * still reported rather than swallowed.
 */
export async function run(): Promise<void> {
  const config = await loadConfig().catch(err => {
    process.stderr.write(
      `[dexe-mcp doctor] config load failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });

  if (!config) {
    process.exit(2);
  }

  // Name the file that supplied the values BEFORE the table — "which .env am I
  // even editing" is the first question in every setup runbook.
  const envState = getEnvLoadState();
  const loadedEnv = envState.reports.find(r => r.envFileExists && r.envFileLoaded);
  process.stdout.write(
    loadedEnv
      ? `env file: ${loadedEnv.envFilePath} (${loadedEnv.keysApplied.length} key(s) applied)\n`
      : `env file: none loaded — tried ${envState.candidates.join(" -> ") || "(not recorded)"}\n`,
  );
  if (config.startupIssues.length) {
    process.stdout.write(
      `config:   ${config.startupIssues.length} env value(s) rejected at startup, fell back to defaults (startup.* below)\n`,
    );
  }
  process.stdout.write("\n");

  const checks = await runAllChecks({ config });
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.status === "pass") pass++;
    else if (c.status === "warn") warn++;
    else fail++;
  }

  for (const c of checks) {
    const tag = c.status === "pass" ? " OK " : c.status === "warn" ? "WARN" : "FAIL";
    process.stdout.write(`[${tag}] ${c.id.padEnd(36)} ${c.message}\n`);
    if (c.remediation) {
      for (const line of c.remediation.split("\n")) {
        process.stdout.write(`         -> ${line}\n`);
      }
    }
  }
  process.stdout.write(`\nsummary: ${pass} pass / ${warn} warn / ${fail} fail\n`);
  if (fail > 0 || warn > 0) {
    process.stdout.write("after editing .env, restart Claude Code — env is read once, at startup\n");
  }
  process.exit(fail > 0 ? 2 : warn > 0 ? 1 : 0);
}
