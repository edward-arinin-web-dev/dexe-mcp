import { loadConfig } from "../config.js";
import { runAllChecks } from "../diag/checks.js";
import { getEnvLoadState } from "../env/loader.js";
import { safeErrorMessage } from "../lib/redact.js";

/** Parsed `npx dexe-mcp doctor` flags. Pure, so the CLI surface is testable. */
export interface DoctorArgs {
  /** Promote warnings to a non-zero exit, for CI. */
  strict: boolean;
  /** Run the Pinata pin-capability probe, which WRITES one tiny pin. */
  probePin: boolean;
  /** Flags we did not recognise — reported rather than silently ignored. */
  unknown: string[];
}

/** Flags `doctor` accepts. Keep in sync with `usageText()` in src/index.ts. */
const DOCTOR_FLAGS = new Set(["--strict", "--probe-pin"]);

/**
 * Parse argv[3..]. Unknown `--flags` are collected, not ignored: a CI author
 * who writes `--Strict` or `--strict=true` would otherwise get non-strict
 * silently and a pipeline that is green forever.
 */
export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  const unknown = argv.filter(a => a.startsWith("-") && !DOCTOR_FLAGS.has(a));
  return {
    strict: argv.includes("--strict") || process.env.DEXE_DOCTOR_STRICT === "1",
    probePin: argv.includes("--probe-pin"),
    unknown,
  };
}

/**
 * Exit-code contract (0.34.0). Warnings are the DOCUMENTED zero-config state
 * (no .env, public RPC fallback, shared Graph/WC/backend defaults), so they no
 * longer fail the command. `--strict` (or `DEXE_DOCTOR_STRICT=1`) restores the
 * pre-0.34 CI behaviour.
 *   0 — no failing checks (warnings allowed, unless strict)
 *   1 — strict and >= 1 warning, no failures
 *   2 — >= 1 failing check
 *
 * INVARIANT: `run()` must call process.exit() itself. src/index.ts does
 * `await mod.run(argv); process.exit(0);` — a code returned from here would be
 * swallowed and every doctor run would exit 0.
 */
export function doctorExitCode(t: { warn: number; fail: number }, strict: boolean): 0 | 1 | 2 {
  if (t.fail > 0) return 2;
  if (strict && t.warn > 0) return 1;
  return 0;
}

/**
 * CLI entrypoint: `npx dexe-mcp doctor [--strict] [--probe-pin]`. Runs the same
 * check suite as the MCP tool, prints a flat colorless table to stdout, and
 * exits per `doctorExitCode` above.
 *
 * Designed for both human terminal use and CI pipelines. This is the command
 * every doc points at when the server itself misbehaves, so it must run even
 * when the config is degraded — `loadConfig` never exits, and a throw here is
 * still reported rather than swallowed.
 */
export async function run(argv: readonly string[] = []): Promise<void> {
  const args = parseDoctorArgs(argv);
  if (args.unknown.length) {
    process.stderr.write(
      `[dexe-mcp doctor] unknown option(s): ${args.unknown.join(", ")}. ` +
        `Supported: --strict (exit 1 when there are warnings, for CI), ` +
        `--probe-pin (verify Pinata pin capability — writes one tiny pin).\n`,
    );
    process.exit(2);
  }

  const config = await loadConfig().catch(err => {
    process.stderr.write(
      `[dexe-mcp doctor] config load failed: ${safeErrorMessage(err)}\n`,
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

  const checks = await runAllChecks({ config, probePin: args.probePin });
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
  if (fail > 0 || (warn > 0 && args.strict)) {
    // Only when something actually needs editing. Printing "restart Claude
    // Code" under a verdict that just said nothing is broken is the phantom
    // task this release exists to delete.
    process.stdout.write("after editing .env, restart Claude Code — env is read once, at startup\n");
  } else if (warn > 0) {
    process.stdout.write(
      `verdict: healthy — ${warn} warning(s), 0 failures. Nothing is broken. A zero-config install ` +
        `always shows env.file, chain.publicRpcFallback and env.sharedDefaults; each names an optional ` +
        `upgrade (your own RPC, your own Graph key, a signer), not a problem.\n` +
        `Pass --strict (or set DEXE_DOCTOR_STRICT=1) to exit 1 on warnings in CI.\n`,
    );
  }
  process.exit(doctorExitCode({ warn, fail }, args.strict));
}
