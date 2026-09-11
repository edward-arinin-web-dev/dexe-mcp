import { defineConfig } from "vitest/config";

// Keep the default include/exclude, plus: never collect tests from git
// worktrees parked under .claude/worktrees/ (parallel agent checkouts inside the
// repo directory). Without this a run from the main checkout picks up every
// worktree's tests/ tree — N× the file count and failures from someone else's
// half-finished branch.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "**/.claude/worktrees/**"],
  },
});
