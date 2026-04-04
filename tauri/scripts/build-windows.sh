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

# Always delete runtime cache so fresh webview code gets bundled
echo "=== Clearing runtime cache ==="
powershell.exe -Command "if (Test-Path '$WIN_REPO\tauri\src-tauri\runtime') { Remove-Item -Recurse -Force '$WIN_REPO\tauri\src-tauri\runtime'; Write-Host 'Deleted stale runtime/' } else { Write-Host 'No cache to clear' }"

# Clear WebView2 cache — prevents stale webview HTML/JS/CSS from persisting across installs
echo "=== Clearing WebView2 cache ==="
powershell.exe -Command "
\$wv2 = Join-Path \$env:LOCALAPPDATA 'io.github.thesylvester.crispy\EBWebView'
if (Test-Path \$wv2) {
  Get-Process -Name 'crispy-desktop' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force \$wv2
  Write-Host 'Cleared WebView2 cache'
} else { Write-Host 'No WebView2 cache' }
"

# Rebuild WSL webview dist so the local daemon serves fresh code
echo "=== Building WSL webview ==="
REPO_ROOT="$( cd "$(dirname "$0")/../.." && pwd )"
( cd "$REPO_ROOT" && npm run build:webview )

# Sync current branch to Windows clone
# Cargo dirties Cargo.toml during compilation — restore it before pulling
BRANCH="$(git branch --show-current)"
echo "=== Syncing branch '$BRANCH' to Windows clone ==="
powershell.exe -Command "cd '$WIN_REPO'; git checkout -- tauri/src-tauri/Cargo.toml tauri/package-lock.json 2>\$null; git fetch origin; git checkout '$BRANCH'; git pull origin '$BRANCH'"

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
