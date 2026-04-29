#!/usr/bin/env bash
# Swarm nightly runner — Phase 5 scaffolding.
#
# Cron line example (runs at 03:00 local time, BSC testnet):
#   0 3 * * * cd /d/dev/dexe-mcp && SWARM_CHAIN_ID=97 ./scripts/swarm/nightly.sh >> tests/reports/swarm/nightly.log 2>&1
#
# What this does:
#   1. Pulls latest main (so the agent runs the freshest scenarios + dispatcher).
#   2. Runs `npm install` if package-lock changed (no-op otherwise).
#   3. Runs swarm:preflight; aborts if any wallet is red (funder probably needs a refill).
#   4. Runs the full sweep with broadcast.
#   5. Tails the run report so the cron log captures pass/fail and tx hashes.
#
# Phase 5 follow-ups (not yet wired):
#   - Post a summary line to a tracking issue (gh issue create / Slack webhook).
#   - On first failure, spawn the triage + fixer agents.
#   - Rotate logs older than 30 days.

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
npm run --silent swarm:run

LATEST_REPORT="$(ls -dt tests/reports/swarm/*/ 2>/dev/null | head -1 || true)"
if [[ -n "${LATEST_REPORT}" && -f "${LATEST_REPORT}run.md" ]]; then
  echo "--- run report (${LATEST_REPORT}run.md) ---"
  cat "${LATEST_REPORT}run.md"
fi

echo "=== nightly done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
