import { defineConfig } from "vitest/config";

// Keep the default include/exclude, plus: never collect tests from git
// worktrees parked under .claude/worktrees/ (parallel agent checkouts inside the
// repo directory). Without this a run from the main checkout picks up every
// worktree's tests/ tree — N× the file count and failures from someone else's
// half-finished branch.
//
// testTimeout: the 5 s default flakes under the full parallel run (230+ files,
// several spawn the built server over stdio): tests that pass alone in well
// under a second time out when every worker is busy — locally and on the
// Node 22 CI job. 20 s leaves headroom without hiding a genuine hang.
//
// server.deps.inline: the read edition (@dexe-network/dexe-mcp) runs through
// Vitest's module runner like src/ does, instead of as an externalized
// node_modules package. Two reasons, both about the read code the write code
// is built on:
//   - module state stays per test file. The package holds singletons (the
//     known-failure registry the write table is added to, the .env load state,
//     provider caches); an externalized package is one Node module instance
//     per worker, shared by every file that worker runs.
//   - a test can stub what the package's own modules import: `ethers`, or one
//     of its modules by its dist path (vi.mock("../../node_modules/@dexe-network/
//     dexe-mcp/dist/lib/multicall.js") in tests/tools/dao-report.test.ts and
//     three others). An import from @dexe-network/dexe-mcp/core is replaced by
//     mocking that specifier; a call the package makes inside itself is only
//     reachable this way.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "**/.claude/worktrees/**"],
    testTimeout: 20_000,
    server: {
      deps: {
        inline: ["@dexe-network/dexe-mcp"],
      },
    },
  },
});
