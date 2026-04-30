#!/usr/bin/env bash
# Swarm nightly runner — Phase 5.
#
# Cron line example (runs at 03:00 local time, BSC testnet):
#   0 3 * * * cd /d/dev/dexe-mcp && SWARM_CHAIN_ID=97 ./scripts/swarm/nightly.sh >> tests/reports/swarm/nightly.log 2>&1
#
# Optional env:
#   SWARM_SUMMARY_WEBHOOK   — Slack-compat webhook for the one-line SWARM result.
#   SWARM_SUMMARY_ISSUE     — gh issue number to post a summary comment on.
#   SWARM_FIXER             — set to "1" to auto-spawn the fixer subagent on failure
#                             (otherwise we just log "fixer would run").

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "=== swarm nightly $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

git fetch origin
git pull --ff-only origin main

if ! git diff --quiet HEAD@{1} -- package-lock.json package.json 2>/dev/null; then
  echo "package files changed; running npm install"
  npm install --no-audit --no-fund
fi

echo "--- preflight ---"
if ! npm run --silent swarm:preflight; then
  echo "preflight failed — aborting nightly run."
  exit 1
fi

echo "--- full sweep ---"
RUN_LOG="$(mktemp)"
SWEEP_RC=0
npm run --silent swarm:run 2>&1 | tee "$RUN_LOG" || SWEEP_RC=$?

# Orchestrator emits one machine-greppable line:
#   SWARM <runId> <pass>/<total> <mode> <chainTag> <reportPath>
SUMMARY_LINE="$(grep -E '^SWARM [0-9].* [0-9]+/[0-9]+ ' "$RUN_LOG" | tail -1 || true)"

LATEST_REPORT="$(ls -dt tests/reports/swarm/*/ 2>/dev/null | head -1 || true)"
if [[ -n "${LATEST_REPORT}" && -f "${LATEST_REPORT}run.md" ]]; then
  echo "--- run report (${LATEST_REPORT}run.md) ---"
  cat "${LATEST_REPORT}run.md"
fi

# ---- Summary post ----------------------------------------------------------
if [[ -n "${SUMMARY_LINE}" ]]; then
  echo "--- summary ---"
  echo "${SUMMARY_LINE}"

  if [[ -n "${SWARM_SUMMARY_WEBHOOK:-}" ]]; then
    curl -sS -X POST -H 'Content-Type: application/json' \
      --data "$(printf '{"text":"%s"}' "${SUMMARY_LINE}")" \
      "${SWARM_SUMMARY_WEBHOOK}" >/dev/null \
      || echo "warn: webhook post failed (non-fatal)"
  fi

  if [[ -n "${SWARM_SUMMARY_ISSUE:-}" ]] && command -v gh >/dev/null 2>&1; then
    gh issue comment "${SWARM_SUMMARY_ISSUE}" --body "${SUMMARY_LINE}" \
      || echo "warn: gh issue comment failed (non-fatal)"
  fi
fi

# ---- Triage + Fixer on failure --------------------------------------------
if [[ ${SWEEP_RC} -ne 0 ]]; then
  echo "--- failure detected — triage stub ---"
  echo "Failure run: ${LATEST_REPORT:-<unknown>}"
  echo "Bug write target: ${LATEST_REPORT:-./}bugs/"
  if [[ "${SWARM_FIXER:-0}" = "1" ]]; then
    echo "(SWARM_FIXER=1 — wiring not yet implemented; see tests/swarm/prompts/fixer.md)"
  else
    echo "(SWARM_FIXER unset — skipping auto-fixer; would consume tests/swarm/prompts/fixer.md)"
  fi
fi

# ---- Log rotation ---------------------------------------------------------
# Drop run reports older than 30 days. Keep the latest 50 regardless.
if compgen -G "tests/reports/swarm/*/" > /dev/null; then
  find tests/reports/swarm -mindepth 1 -maxdepth 1 -type d -mtime +30 \
    | sort \
    | head -n -50 \
    | xargs -r rm -rf
fi

echo "=== nightly done $(date -u +%Y-%m-%dT%H:%M:%SZ) (rc=${SWEEP_RC}) ==="
exit "${SWEEP_RC}"
