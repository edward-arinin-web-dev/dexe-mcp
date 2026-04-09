import { execa, type ResultPromise } from "execa";
import pLimit from "p-limit";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DexeConfig } from "./config.js";

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

  /** Run `npm run <script>` in the protocol directory. */
  runNpmScript(script: string, extraArgs: string[] = []): Promise<RunResult> {
    const args = ["run", script];
    if (extraArgs.length > 0) {
      args.push("--", ...extraArgs);
    }
    return this.run("npm", args, `npm-run-${script}`);
  }

  /** Run `npx hardhat <subcommand> <args...>` in the protocol directory. */
  runHardhat(subcommand: string, args: string[] = []): Promise<RunResult> {
    return this.run("npx", ["hardhat", subcommand, ...args], `hardhat-${subcommand}`);
  }

  private run(command: string, args: string[], label: string): Promise<RunResult> {
    return limit(async () => {
      const started = Date.now();
      let timedOut = false;

      const subprocess: ResultPromise<{
        cwd: string;
        timeout: number;
        reject: false;
        all: true;
        env: NodeJS.ProcessEnv;
      }> = execa(command, args, {
        cwd: this.config.protocolPath,
        timeout: HARDHAT_TIMEOUT_MS,
        reject: false,
        all: true,
        env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
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
