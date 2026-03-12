#!/usr/bin/env bash
#
# Robust embedding backfill — auto-restarts on crash, low CPU priority.
#
# The backfill is incremental: already-vectorized sessions are skipped,
# so restarting after a crash loses zero progress.
#
# Usage:
#   ./scripts/embed-robust.sh              # default: 9999 sessions, 30 days
#   ./scripts/embed-robust.sh --days 7     # last 7 days only
#   ./scripts/embed-robust.sh --force      # re-embed everything
#
# Stop cleanly: Ctrl+C (SIGINT is forwarded to the child process).

set -euo pipefail
cd "$(dirname "$0")/.."

LIMIT="${LIMIT:-9999}"
DAYS="${DAYS:-30}"
MAX_RESTARTS=50
NODE_MEM=1536  # MB — cap heap to prevent WSL OOM
EXTRA_ARGS=("$@")

restart_count=0

cleanup() {
  echo ""
  echo "[embed-robust] Stopped after $restart_count restart(s)."
  exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
  echo "[embed-robust] Run $((restart_count + 1)) — limit=$LIMIT days=$DAYS node_mem=${NODE_MEM}MB"

  # nice -n 19: lowest CPU priority so it doesn't interfere with normal work
  # --expose-gc: allows the backfill to trigger explicit GC after model dispose
  # --max-old-space-size: hard cap on V8 heap to prevent WSL OOM
  set +e
  nice -n 19 node \
    --expose-gc \
    --max-old-space-size="$NODE_MEM" \
    --import tsx \
    scripts/backfill.ts embed-messages \
    -l "$LIMIT" \
    --days "$DAYS" \
    "${EXTRA_ARGS[@]}"
  exit_code=$?
  set -e

  if [ $exit_code -eq 0 ]; then
    echo "[embed-robust] Completed successfully."
    break
  fi

  restart_count=$((restart_count + 1))

  if [ $restart_count -ge $MAX_RESTARTS ]; then
    echo "[embed-robust] Hit max restarts ($MAX_RESTARTS). Giving up."
    exit 1
  fi

  echo "[embed-robust] Exited with code $exit_code — restarting in 5s (attempt $restart_count/$MAX_RESTARTS)..."
  sleep 5
done
