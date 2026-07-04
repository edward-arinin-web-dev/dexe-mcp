---
name: dexe-setup
description: |
  Onboard a user to dexe-mcp. Runs `dexe_doctor`, parses the report, asks the
  user only for what is missing, edits `.env` (NEVER `.claude.json`), and
  tells them to restart Claude Code. Triggered by `/dexe-setup`, or
  proactively when the user reports an env-related MCP tool failure
  ("DEXE_PINATA_JWT not set", "RPC unreachable", "subgraph 401", etc.).
---

# dexe-setup

## What this does

Iterative env-setup loop for `dexe-mcp`. Replaces the brittle workflow where
Claude guesses which file to edit and which keys are needed. Drives entirely
from the `dexe_doctor` tool — no guessing.

## When to invoke

- The user types `/dexe-setup`.
- The user reports any of:
  - "dexe-mcp not working", "tools failing", "RPC error", "missing env"
  - A specific MCP tool error mentioning a `DEXE_*` env var
  - "How do I configure dexe-mcp?"
- You see a tool result containing `"Missing required env: DEXE_*"` or
  `"DEXE_* is not set"` — invoke proactively.

## Hard rules (do not violate)

1. **Never write `DEXE_*` values to `.claude.json`.** The MCP host's env block
   SHADOWS `.env` silently. Edits go in `.env` at the dexe-mcp repo root.
2. **Never write `DEXE_PRIVATE_KEY` without explicit user opt-in.** Default
   to readonly mode. If the user says "I want to broadcast", first suggest
   WalletConnect (`DEXE_WALLETCONNECT_PROJECT_ID`); only fall back to
   `DEXE_PRIVATE_KEY` if the user insists, and warn them that the key
   lives in plaintext on disk.
3. **Always tell the user to restart Claude Code after editing `.env`.**
   `process.loadEnvFile()` runs once at startup; mid-session edits do
   nothing until restart.
4. **Cap the loop at 3 iterations.** If `dexe_doctor` still shows failures
   after three doctor → fix → restart cycles, stop and present the full
   report to the user — the remaining issues need manual investigation.

## Algorithm

1. Call `dexe_doctor` (no input).
2. Read the `summary` and `checks` arrays from the structured response.
   - If `summary.status === "pass"`, congratulate the user — no work to do.
   - If only `warnings`, surface them but don't block.
3. For every `fail`:
   - If it is an env presence/validation issue: collect the env key.
   - If it is a network reachability issue (RPC unreachable, Pinata 401):
     use the `remediation` field verbatim; ask the user for a replacement
     value.
4. Batch the questions by category (RPC, IPFS, subgraph, signer) using
   `AskUserQuestion`. One question per category, not one per key.
5. Locate the `.env` file. The startup banner in the doctor response shows
   `environment.envFile`; if absent, look at the repo root (where
   `package.json` lives — usually `D:\dev\dexe-mcp\.env`).
6. Edit `.env` with the Edit tool. For each provided value:
   - If the key already exists, replace its line.
   - Otherwise, append `KEY=value` at the bottom (preserve trailing newline).
7. Tell the user, verbatim:
   > Edits saved to `.env`. **Restart Claude Code** so the new values load
   > (`Ctrl+R` rebuilds the session, or quit and relaunch). Then I will
   > re-run `dexe_doctor` to confirm.
8. After restart, call `dexe_doctor` again. If still failing, go to step 3.
   Iterate at most 3 times.
9. If after 3 iterations there are still failures, present the full
   `checks` array and tell the user the remaining issues need manual
   investigation (likely: bad credentials, account suspended, paid plan
   required, or a corporate proxy blocking the relevant host).

## Signer mode escalation

If a user wants broadcast capability, walk this ladder (top = safest):

1. **WalletConnect (`DEXE_WALLETCONNECT_PROJECT_ID`).** Key stays on phone.
   Every tx is approved manually.
2. **Safe multisig (`DEXE_SAFE_TX_SERVICE_URL`).** Proposes tx to a Safe;
   owners co-sign separately.
3. **Hot key (`DEXE_PRIVATE_KEY`).** Plaintext on disk. Convenient for CI
   bots, dangerous for humans. Show this warning before writing:
   > Setting `DEXE_PRIVATE_KEY` stores your key in plaintext at `.env`.
   > Anyone who reads the file can drain that wallet. Are you sure you
   > don't want WalletConnect (above) or a Safe multisig instead?
4. Refuse to proceed past step 3 without an explicit "yes" confirming
   the user understands the trade-off.

## .env precedence trap

If `dexe_doctor` returns a check named `env.<KEY>` with the message
"shadowed by host env block", the user has the same key defined in BOTH
`.env` AND `.claude.json`. The host wins. Tell them to either:
  - remove the key from `.claude.json` `env` block (use `.env`), OR
  - update it in `.claude.json` instead of `.env`.

Whichever they pick, restart Claude Code after.

## Useful tools (reference)

- `dexe_doctor` — diagnostic (read-only, safe to call repeatedly).
- `dexe_get_config` — current chain/signer state (lower detail than doctor).
- `npx dexe-mcp doctor` — CLI form of the same diagnostic. Useful when the
  MCP server itself failed to start.
- `npx dexe-mcp init` — fresh-start wizard. Overwrites `.env`. Use for new
  installations, not for fixing an existing setup.
