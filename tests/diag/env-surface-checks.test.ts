import { describe, expect, it } from "vitest";
import { startupIssueChecks, envSourceChecks, type CheckResult } from "../../src/diag/checks.js";
import type { EnvLoadReport, EnvSourceState } from "../../src/env/loader.js";
import type { DexeConfig, StartupIssue } from "../../src/config.js";

/**
 * 0.30.1 — the two things doctor could not say before this release:
 *   1. that `loadConfig` rejected a value and quietly fell back (it used to
 *      `process.exit(1)`, so there was nothing left to ask);
 *   2. which `.env` was loaded and whether the MCP host `env` block shadows it
 *      — the question CLAUDE.md, docs/SETUP.md and /dexe-setup all open with.
 */

function configWith(startupIssues: StartupIssue[]): DexeConfig {
  return { startupIssues } as unknown as DexeConfig;
}

function report(over: Partial<EnvLoadReport> = {}): EnvLoadReport {
  return {
    envFilePath: "/home/u/.dexe-mcp/.env",
    envFileExists: true,
    envFileLoaded: true,
    loadedNodeVersion: "v22.0.0",
    parseIssues: [],
    fileKeys: ["DEXE_PINATA_JWT"],
    keysApplied: ["DEXE_PINATA_JWT"],
    keysShadowed: [],
    keysDropped: [],
    unknownDexeVars: [],
    missingButEnablesFlows: [],
    preExistingVars: [],
    ...over,
  };
}

function state(over: Partial<EnvSourceState> = {}): EnvSourceState {
  return { candidates: ["/proj/.env", "/home/u/.dexe-mcp/.env"], reports: [report()], ...over };
}

const byId = (rs: CheckResult[], id: string): CheckResult | undefined => rs.find(r => r.id === id);

describe("startupIssueChecks", () => {
  const issue: StartupIssue = {
    key: "DEXE_FORK_BLOCK",
    message: "DEXE_FORK_BLOCK must be a non-negative integer, got: abc",
    fallback: "ignored, forking from the latest block",
  };

  it("a degraded config can never produce a green doctor", () => {
    const rs = startupIssueChecks(configWith([issue]));
    expect(rs).toHaveLength(1);
    expect(rs[0]!.status).toBe("fail");
    expect(rs.every(r => r.status === "pass")).toBe(false);
  });

  it("reports the rejected value, the fallback, and the restart step", () => {
    const r = byId(startupIssueChecks(configWith([issue]), state()), "startup.DEXE_FORK_BLOCK")!;
    expect(r.message).toContain("got: abc");
    expect(r.message).toContain("forking from the latest block");
    expect(r.remediation).toContain("/home/u/.dexe-mcp/.env");
    expect(r.remediation).toContain("restart Claude Code");
  });

  it("a clean config emits an explicit pass so the check is never silent", () => {
    const rs = startupIssueChecks(configWith([]));
    expect(rs).toHaveLength(1);
    expect(rs[0]!.id).toBe("startup.config");
    expect(rs[0]!.status).toBe("pass");
  });

  it("a signer-family issue is filed under the signer category", () => {
    const rs = startupIssueChecks(
      configWith([{ key: "DEXE_AGENT_PK_*", message: "bad key", fallback: "slot skipped" }]),
    );
    expect(rs[0]!.category).toBe("signer");
  });
});

describe("envSourceChecks", () => {
  it("names the .env that was actually loaded", () => {
    const r = byId(envSourceChecks(state()), "env.file")!;
    expect(r.status).toBe("pass");
    expect(r.message).toContain("/home/u/.dexe-mcp/.env");
    expect(r.message).toContain("1 key(s) applied");
  });

  it("no .env anywhere → warn that lists every path tried", () => {
    const r = byId(
      envSourceChecks(state({ reports: [report({ envFileExists: false, envFileLoaded: false })] })),
      "env.file",
    )!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("/proj/.env");
    expect(r.message).toContain("/home/u/.dexe-mcp/.env");
    expect(r.remediation).toContain("npx dexe-mcp init");
  });

  it("shadowed keys are named, with the host env block as the fix", () => {
    const r = byId(
      envSourceChecks(state({ reports: [report({ keysShadowed: ["DEXE_RPC_URL_MAINNET"] })] })),
      "env.shadowedKeys",
    )!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("DEXE_RPC_URL_MAINNET");
    expect(r.remediation).toContain(".claude.json");
  });

  it("a second existing .env is reported as lower precedence", () => {
    const rs = envSourceChecks(
      state({ reports: [report(), report({ envFilePath: "/proj/.env", envFileLoaded: false })] }),
    );
    expect(byId(rs, "env.file.precedence")!.message).toContain("/proj/.env");
  });

  it("parse traps reach doctor with their severity intact", () => {
    const rs = envSourceChecks(
      state({
        reports: [
          report({
            parseIssues: [
              {
                trap: "no-trailing-newline",
                severity: "fail",
                message: "last line dropped",
                remediation: "add a newline",
              },
            ],
          }),
        ],
      }),
    );
    expect(byId(rs, "env.parse.no-trailing-newline")!.status).toBe("fail");
  });

  it("an unrecognized DEXE_* var warns instead of being silently ignored", () => {
    const r = byId(
      envSourceChecks(state({ reports: [report({ unknownDexeVars: ["DEXE_PINATA_JWTT"] })] })),
      "env.unknownVars",
    )!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("DEXE_PINATA_JWTT");
  });

  it("an unrecorded resolution warns rather than guessing a path", () => {
    const r = byId(envSourceChecks(undefined), "env.file")!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("not recorded");
  });
});
