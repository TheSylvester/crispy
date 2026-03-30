#!/usr/bin/env bash
# build-windows.sh — Trigger Tauri build from WSL
# Usage: bash tauri/scripts/build-windows.sh [dev|build]
#   dev   — cargo tauri dev (default)
#   build — cargo tauri build (NSIS installer)

set -euo pipefail
MODE="${1:-dev}"
WIN_REPO='C:\winDev\crispy'
# Git for Windows provides cp/rm/chmod needed by npm scripts
GIT_UNIX='C:\Program Files\Git\usr\bin'

# Sync current branch to Windows clone
BRANCH="$(git branch --show-current)"
echo "=== Syncing branch '$BRANCH' to Windows clone ==="
powershell.exe -Command "cd '$WIN_REPO'; git fetch origin; git checkout '$BRANCH'; git pull origin '$BRANCH'"

# Build crispy-code on Windows side (with Git unix utils on PATH for cp/rm)
echo "=== Installing deps and building crispy-code ==="
powershell.exe -Command "\$env:Path = '$GIT_UNIX;' + \$env:Path; cd '$WIN_REPO'; npm ci; npm run build"

# Bundle runtime and run Tauri
echo "=== Running tauri $MODE ==="
if [ "$MODE" = "build" ]; then
  powershell.exe -Command "cd '$WIN_REPO\tauri'; npm install; powershell -ExecutionPolicy Bypass -File scripts/bundle-runtime.ps1; \$env:TAURI_SIGNING_PRIVATE_KEY=''; npx tauri build"
else
  powershell.exe -Command "cd '$WIN_REPO\tauri'; npm install; powershell -ExecutionPolicy Bypass -File scripts/bundle-runtime.ps1; npx tauri dev"
fi
