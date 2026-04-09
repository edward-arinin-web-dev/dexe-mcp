import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import type { RunResult } from "../hardhat.js";

export function registerBuildTools(server: McpServer, ctx: ToolContext): void {
  registerCompile(server, ctx);
  registerTest(server, ctx);
  registerCoverage(server, ctx);
  registerLint(server, ctx);
}

// ---------- dexe_compile ----------

function registerCompile(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_compile",
    {
      title: "Compile DeXe-Protocol",
      description:
        "Runs `npm run compile` in DEXE_PROTOCOL_PATH. Parses solc diagnostics and invalidates the artifact cache on success. Must be called at least once per session before introspection tools can read artifacts.",
      inputSchema: {
        // The current protocol's `compile` script already passes `--force`;
        // keep this input for forward-compat and ignore it for now.
        force: z.boolean().optional().describe("Forward-compat only — the current compile script always forces."),
      },
      outputSchema: {
        success: z.boolean(),
        errorCount: z.number(),
        warningCount: z.number(),
        diagnostics: z.array(
          z.object({
            severity: z.enum(["error", "warning"]),
            code: z.string().optional(),
            message: z.string(),
            file: z.string().optional(),
            line: z.number().optional(),
          }),
        ),
        durationMs: z.number(),
        logFile: z.string(),
        stdoutTail: z.string(),
      },
    },
    async () => {
      const result = await ctx.runner.runNpmScript("compile");
      const diags = parseSolcDiagnostics(result.stdout + "\n" + result.stderr);
      const success = result.exitCode === 0;
      if (success) ctx.artifacts.invalidate();

      const structured = {
        success,
        errorCount: diags.filter((d) => d.severity === "error").length,
        warningCount: diags.filter((d) => d.severity === "warning").length,
        diagnostics: diags.slice(0, 20),
        durationMs: result.durationMs,
        logFile: result.logFile,
        stdoutTail: result.stdoutTail,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: summarizeCompile(structured, result),
          },
        ],
        structuredContent: structured,
        isError: !success,
      };
    },
  );
}

function summarizeCompile(
  s: { success: boolean; errorCount: number; warningCount: number; durationMs: number; logFile: string },
  r: RunResult,
): string {
  const header = s.success
    ? `Compile OK (${s.warningCount} warning${s.warningCount === 1 ? "" : "s"}) in ${(s.durationMs / 1000).toFixed(1)}s`
    : `Compile FAILED (${s.errorCount} error${s.errorCount === 1 ? "" : "s"}, ${s.warningCount} warning${s.warningCount === 1 ? "" : "s"}) in ${(s.durationMs / 1000).toFixed(1)}s`;
  return `${header}\nFull log: ${s.logFile}\n\n--- tail ---\n${r.stdoutTail || "(empty)"}`;
}

const SOLC_DIAG = /^(Error|Warning)(?:\s*\(([^)]+)\))?:\s*(.*?)(?:\n\s*-->\s*([^\s:]+):(\d+):\d+)?/gm;

export function parseSolcDiagnostics(text: string): Array<{
  severity: "error" | "warning";
  code?: string;
  message: string;
  file?: string;
  line?: number;
}> {
  const out: ReturnType<typeof parseSolcDiagnostics> = [];
  for (const m of text.matchAll(SOLC_DIAG)) {
    const severity = m[1] === "Error" ? "error" : "warning";
    out.push({
      severity,
      code: m[2],
      message: (m[3] ?? "").trim(),
      file: m[4],
      line: m[5] ? Number(m[5]) : undefined,
    });
  }
  return out;
}

// ---------- dexe_test ----------

function registerTest(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_test",
    {
      title: "Run Hardhat tests",
      description:
        "Runs `npx hardhat test` in DEXE_PROTOCOL_PATH. Optionally filters by mocha --grep or a specific test file. Parses pass/fail counts and captures up to 20 failure bodies.",
      inputSchema: {
        grep: z.string().optional().describe("Mocha --grep pattern"),
        file: z.string().optional().describe("Specific test file path (relative to protocol root)"),
        bail: z.boolean().optional().describe("Stop after first failure"),
      },
      outputSchema: {
        success: z.boolean(),
        passing: z.number(),
        failing: z.number(),
        pending: z.number(),
        failures: z.array(
          z.object({
            title: z.string(),
            error: z.string(),
          }),
        ),
        durationMs: z.number(),
        logFile: z.string(),
        stdoutTail: z.string(),
      },
    },
    async ({ grep, file, bail }) => {
      const args: string[] = [];
      if (file) args.push(file);
      if (grep) args.push("--grep", grep);
      if (bail) args.push("--bail");

      const result = await ctx.runner.runHardhat("test", args);
      const parsed = parseMocha(result.stdout);
      const success = result.exitCode === 0;

      const structured = {
        success,
        passing: parsed.passing,
        failing: parsed.failing,
        pending: parsed.pending,
        failures: parsed.failures.slice(0, 20),
        durationMs: result.durationMs,
        logFile: result.logFile,
        stdoutTail: result.stdoutTail,
      };

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Tests: ${structured.passing} passing, ${structured.failing} failing` +
              (structured.pending ? `, ${structured.pending} pending` : "") +
              ` (${(result.durationMs / 1000).toFixed(1)}s)\nFull log: ${result.logFile}\n\n--- tail ---\n${result.stdoutTail || "(empty)"}`,
          },
        ],
        structuredContent: structured,
        isError: !success,
      };
    },
  );
}

export interface MochaParseResult {
  passing: number;
  failing: number;
  pending: number;
  failures: Array<{ title: string; error: string }>;
}

export function parseMocha(text: string): MochaParseResult {
  const clean = stripAnsi(text);
  const passing = Number(/(\d+)\s+passing/.exec(clean)?.[1] ?? 0);
  const failing = Number(/(\d+)\s+failing/.exec(clean)?.[1] ?? 0);
  const pending = Number(/(\d+)\s+pending/.exec(clean)?.[1] ?? 0);

  const failures: Array<{ title: string; error: string }> = [];
  // Mocha failure blocks: "  1) Test title:" followed by an indented error body.
  const failureRe = /^\s*(\d+)\)\s+(.+?)\n([\s\S]*?)(?=\n\s*\d+\)\s+|\n\s*\d+\s+passing|\n\s*\d+\s+failing|$)/gm;
  for (const m of clean.matchAll(failureRe)) {
    failures.push({
      title: (m[2] ?? "").trim(),
      error: (m[3] ?? "").trim().split("\n").slice(0, 20).join("\n"),
    });
  }
  return { passing, failing, pending, failures };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// ---------- dexe_coverage ----------

function registerCoverage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_coverage",
    {
      title: "Run solidity-coverage",
      description:
        "Runs `npm run coverage` in DEXE_PROTOCOL_PATH and reads coverage/coverage-summary.json for per-file line/branch percentages. Slow — can take several minutes.",
      inputSchema: {
        grep: z.string().optional().describe("Mocha --grep pattern (passed through)"),
      },
      outputSchema: {
        success: z.boolean(),
        total: z
          .object({
            lines: z.number(),
            branches: z.number(),
            functions: z.number(),
            statements: z.number(),
          })
          .optional(),
        files: z.array(
          z.object({
            file: z.string(),
            lines: z.number(),
            branches: z.number(),
            functions: z.number(),
            statements: z.number(),
          }),
        ),
        durationMs: z.number(),
        logFile: z.string(),
      },
    },
    async ({ grep }) => {
      const result = grep
        ? await ctx.runner.runNpmScript("coverage", ["--grep", grep])
        : await ctx.runner.runNpmScript("coverage");

      const success = result.exitCode === 0;
      const summary = readCoverageSummary(ctx.config.protocolPath);

      const structured = {
        success,
        total: summary?.total,
        files: summary?.files ?? [],
        durationMs: result.durationMs,
        logFile: result.logFile,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: success
              ? `Coverage OK (${structured.files.length} files). Lines: ${structured.total?.lines ?? "?"}%, Branches: ${structured.total?.branches ?? "?"}%\nFull log: ${result.logFile}`
              : `Coverage FAILED (exit ${result.exitCode})\nFull log: ${result.logFile}\n\n--- tail ---\n${result.stdoutTail}`,
          },
        ],
        structuredContent: structured,
        isError: !success,
      };
    },
  );
}

interface CoverageSummary {
  total: { lines: number; branches: number; functions: number; statements: number };
  files: Array<{ file: string; lines: number; branches: number; functions: number; statements: number }>;
}

function readCoverageSummary(protocolPath: string): CoverageSummary | null {
  const path = join(protocolPath, "coverage", "coverage-summary.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      {
        lines?: { pct?: number };
        branches?: { pct?: number };
        functions?: { pct?: number };
        statements?: { pct?: number };
      }
    >;
    const files: CoverageSummary["files"] = [];
    let total: CoverageSummary["total"] = { lines: 0, branches: 0, functions: 0, statements: 0 };
    for (const [key, entry] of Object.entries(raw)) {
      const rec = {
        file: key,
        lines: entry.lines?.pct ?? 0,
        branches: entry.branches?.pct ?? 0,
        functions: entry.functions?.pct ?? 0,
        statements: entry.statements?.pct ?? 0,
      };
      if (key === "total") total = { lines: rec.lines, branches: rec.branches, functions: rec.functions, statements: rec.statements };
      else files.push(rec);
    }
    return { total, files };
  } catch {
    return null;
  }
}

// ---------- dexe_lint ----------

function registerLint(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dexe_lint",
    {
      title: "Run protocol linters",
      description:
        "Runs the protocol's lint scripts. With `fix: true` runs `npm run lint-fix` (chained solhint/eslint/jsonlint fixers). Without, runs `npm run lint-check` if available.",
      inputSchema: {
        fix: z.boolean().optional().describe("Apply fixes in-place"),
      },
      outputSchema: {
        success: z.boolean(),
        script: z.string(),
        durationMs: z.number(),
        logFile: z.string(),
        stdoutTail: z.string(),
      },
    },
    async ({ fix }) => {
      const script = fix ? "lint-fix" : "lint-check";
      const result = await ctx.runner.runNpmScript(script);
      const success = result.exitCode === 0;

      const structured = {
        success,
        script,
        durationMs: result.durationMs,
        logFile: result.logFile,
        stdoutTail: result.stdoutTail,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `${success ? "Lint OK" : `Lint FAILED (exit ${result.exitCode})`} via \`npm run ${script}\` in ${(result.durationMs / 1000).toFixed(1)}s\nFull log: ${result.logFile}\n\n--- tail ---\n${result.stdoutTail || "(empty)"}`,
          },
        ],
        structuredContent: structured,
        isError: !success,
      };
    },
  );
}
