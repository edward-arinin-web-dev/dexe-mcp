/**
 * E2E Compat Test Runner
 *
 * This file is a thin entry point. The real test flow is driven by Claude Code
 * using Chrome DevTools MCP + the scripts in tests/compat/.
 *
 * For standalone comparator usage:
 *   npx tsx tests/compat/comparator.ts <frontendHex> <mcpHex> [fixtureId]
 *
 * See tests/compat/GUIDE.md for the full workflow.
 * See tests/compat/orchestrator.md for the step-by-step protocol.
 * See .claude/skills/test-mcp-compat/SKILL.md for the Claude Code skill.
 */

export { compare, toMarkdown, compareHex, deepDiff } from "./compat/comparator.js";
