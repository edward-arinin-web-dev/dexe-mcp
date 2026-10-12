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
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "**/.claude/worktrees/**"],
    testTimeout: 20_000,
  },
});
