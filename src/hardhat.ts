import { execa, type ResultPromise } from "execa";
import pLimit from "p-limit";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DexeConfig } from "./config.js";
import { ensureBuildReady } from "./bootstrap.js";
import { envWithNodeBinDir, hardhatCommand, npmCommand } from "./runtime.js";

/** Result of a shelled-out hardhat/npm invocation. */
export interface RunResult {
  exitCode: number;
  /** Full captured stdout (uncapped — tools surface `stdoutTail` publicly). */
  stdout: string;
  stderr: string;
  /** Last ~200 lines of stdout, joined with newlines. */
  stdoutTail: string;
  /** Last ~100 lines of stderr, joined with newlines. */
  stderrTail: string;
  /** Absolute path to a tmp file holding the full stdout+stderr log. */
  logFile: string;
  durationMs: number;
  timedOut: boolean;
}

const HARDHAT_TIMEOUT_MS = 10 * 60 * 1000;
const STDOUT_TAIL_LINES = 200;
const STDERR_TAIL_LINES = 100;

// One hardhat invocation at a time per process. Hardhat doesn't parallelize well
// across invocations against the same project, and solidity-coverage definitely
// doesn't.
const limit = pLimit(1);

let tmpRoot: string | null = null;
function getTmpRoot(): string {
  if (!tmpRoot) tmpRoot = mkdtempSync(join(tmpdir(), "dexe-mcp-"));
  return tmpRoot;
}

export class HardhatRunner {
  constructor(private readonly config: DexeConfig) {}

  /**
   * Run `npm run <script>` in the protocol directory.
   *
   * Uses `node <npm-cli.js>` under the hood so this works regardless of
   * whether `npm` is on the MCP's spawn PATH.
   */
  async runNpmScript(script: string, extraArgs: string[] = []): Promise<RunResult> {
    await ensureBuildReady(this.config.protocolPath);
    const npm = npmCommand();
    const args = [...npm.prefixArgs, "run", script];
    if (extraArgs.length > 0) args.push("--", ...extraArgs);
    return this.run(
      npm.command,
      args,
      `npm-run-${script}`,
      npm.needsShell,
      envWithNodeBinDir(npm.binDir),
    );
  }

  /**
   * Run `hardhat <subcommand> <args...>` in the protocol directory.
   *
   * Uses `node <protocol>/node_modules/hardhat/internal/cli/cli.js` so this
   * doesn't require `npx` on PATH.
   */
  async runHardhat(subcommand: string, args: string[] = []): Promise<RunResult> {
    await ensureBuildReady(this.config.protocolPath);
    const hh = hardhatCommand(this.config.protocolPath);
    if (!hh) {
      throw new Error(
        `Hardhat is not installed inside ${this.config.protocolPath}. This should have been fixed by ensureBuildReady — did npm install fail?`,
      );
    }
    // Hardhat is invoked via `node <cli.js>`, which has zero PATH dependency
    // for the command itself, but the hardhat task may still spawn helpers
    // that look for npx on PATH — keep the bin dir prepended to be safe.
    const npm = npmCommand();
    return this.run(
      hh.command,
      [...hh.prefixArgs, subcommand, ...args],
      `hardhat-${subcommand}`,
      false,
      envWithNodeBinDir(npm.binDir),
    );
  }

  private run(
    command: string,
    args: string[],
    label: string,
    useShell: boolean,
    extraEnv: NodeJS.ProcessEnv,
  ): Promise<RunResult> {
    return limit(async () => {
      const started = Date.now();
      let timedOut = false;

      const subprocess: ResultPromise<{
        cwd: string;
        timeout: number;
        reject: false;
        all: true;
        env: NodeJS.ProcessEnv;
        shell: boolean;
      }> = execa(command, args, {
        cwd: this.config.protocolPath,
        timeout: HARDHAT_TIMEOUT_MS,
        reject: false,
        all: true,
        env: { ...extraEnv, FORCE_COLOR: "0", CI: "1" },
        shell: useShell,
      });

      // Best-effort: mirror child stderr to ours in near-real-time so the
      // user sees progress in the MCP's stderr logs. The return value still
      // captures everything.
      subprocess.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      const result = await subprocess;
      const durationMs = Date.now() - started;

      const stdout = (result.stdout as string | undefined) ?? "";
      const stderr = (result.stderr as string | undefined) ?? "";
      if (result.timedOut) timedOut = true;

      const logFile = join(getTmpRoot(), `${label}-${started}.log`);
      try {
        writeFileSync(
          logFile,
          `$ ${command} ${args.join(" ")}\n(cwd: ${this.config.protocolPath})\n\n--- stdout ---\n${stdout}\n\n--- stderr ---\n${stderr}\n`,
        );
      } catch {
        // tmp write failure shouldn't fail the tool; the caller still gets tails.
      }

      return {
        exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
        stdout,
        stderr,
        stdoutTail: tailLines(stdout, STDOUT_TAIL_LINES),
        stderrTail: tailLines(stderr, STDERR_TAIL_LINES),
        logFile,
        durationMs,
        timedOut,
      };
    });
  }
}

function tailLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length <= n) return lines.join("\n");
  return lines.slice(-n).join("\n");
}
