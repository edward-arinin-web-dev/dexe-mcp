import { loadConfig } from "../config.js";
import { runAllChecks } from "../diag/checks.js";

/**
 * CLI entrypoint: `npx dexe-mcp doctor`. Runs the same check suite as the
 * MCP tool, prints a flat colorless table to stdout, exits with:
 *   - 0 when every check passes
 *   - 1 when there are warnings but no failures
 *   - 2 when at least one check fails
 *
 * Designed for both human terminal use and CI pipelines.
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
  process.exit(fail > 0 ? 2 : warn > 0 ? 1 : 0);
}
