import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DexeConfig } from "../../src/config.js";
import type { CheckResult } from "../../src/diag/checks.js";

/**
 * D8-2 / D10-1, sibling path — the CLI exit code was only half the problem.
 * `dexe_doctor` (the entry point README and docs/DOCTOR.md name FIRST) rendered
 * `dexe-mcp doctor — WARN: 10 pass / 3 warn / 0 fail` on a perfectly healthy
 * zero-config install, and the /dexe-setup skill drives its fix→restart loop
 * off that headline.
 *
 * `summary.status` deliberately keeps its legacy mapping (docs and third-party
 * branches read it); the new `summary.advisoryOnly` is ADD-ONLY.
 */

const checksMock = vi.hoisted(() => ({ results: [] as CheckResult[], opts: undefined as unknown }));

vi.mock("../../src/diag/checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/diag/checks.js")>();
  return {
    ...actual,
    runAllChecks: vi.fn(async (opts: unknown) => {
      checksMock.opts = opts;
      return checksMock.results;
    }),
  };
});

const { registerDoctorTool } = await import("../../src/tools/doctor.js");

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: { summary: { status: string; advisoryOnly: boolean; passed: number; warnings: number; failures: number } };
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function doctorHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (_name: string, ...rest: unknown[]) => {
      handler = rest[rest.length - 1] as ToolHandler;
    },
  } as unknown as McpServer;
  registerDoctorTool(server, { startupIssues: [], toolsets: ["core"] } as unknown as DexeConfig);
  return handler!;
}

const pass = (id: string): CheckResult => ({ id, category: "core", status: "pass", message: "ok" });
const warn = (id: string): CheckResult => ({ id, category: "core", status: "warn", message: "advisory" });
const fail = (id: string): CheckResult => ({ id, category: "core", status: "fail", message: "broken" });

describe("dexe_doctor verdict", () => {
  beforeEach(() => {
    checksMock.results = [];
    checksMock.opts = undefined;
  });
  afterEach(() => vi.clearAllMocks());

  it("warnings with no failures read as OK, not WARN", async () => {
    checksMock.results = [pass("a"), pass("b"), warn("env.file"), warn("chain.publicRpcFallback")];
    const res = await doctorHandler()({});

    const text = res.content.map((c) => c.text).join("\n");
    expect(text.split("\n")[0]).toMatch(/OK, no failures/);
    expect(text.split("\n")[0]).toMatch(/advisory warning/);
    expect(text.split("\n")[0]).not.toMatch(/— WARN:/);

    expect(res.structuredContent!.summary.advisoryOnly).toBe(true);
    // Back-compat lock: the enum must NOT flip.
    expect(res.structuredContent!.summary.status).toBe("warn");
  });

  it("a real failure keeps the FAIL headline", async () => {
    checksMock.results = [pass("a"), warn("b"), fail("rpc.56")];
    const res = await doctorHandler()({});

    const first = res.content.map((c) => c.text).join("\n").split("\n")[0]!;
    expect(first).toMatch(/— FAIL:/);
    expect(res.structuredContent!.summary.advisoryOnly).toBe(false);
    expect(res.structuredContent!.summary.status).toBe("fail");
  });

  it("an all-green run is unchanged", async () => {
    checksMock.results = [pass("a"), pass("b")];
    const res = await doctorHandler()({});

    const first = res.content.map((c) => c.text).join("\n").split("\n")[0]!;
    expect(first).toMatch(/— PASS:/);
    expect(res.structuredContent!.summary.advisoryOnly).toBe(false);
  });

  it("probePin defaults to off and is forwarded only when asked", async () => {
    checksMock.results = [pass("a")];
    await doctorHandler()({});
    expect((checksMock.opts as { probePin?: boolean }).probePin).toBe(false);

    await doctorHandler()({ probePin: true });
    expect((checksMock.opts as { probePin?: boolean }).probePin).toBe(true);
  });
});
