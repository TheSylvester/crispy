#!/usr/bin/env bash
# bundle-runtime.sh — Assemble runtime/ directory with portable Node.js + crispy-code
#
# Usage: bash scripts/bundle-runtime.sh
# Run from the tauri/ directory, or the script will cd there automatically.

set -euo pipefail

NODE_VERSION="22.16.0"

# Resolve paths relative to this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAURI_DIR="$SCRIPT_DIR/.."
cd "$TAURI_DIR"

# Detect platform and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *)
    echo "ERROR: Unsupported OS: $OS (use bundle-runtime.ps1 on Windows)"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "ERROR: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

NODE_DIST="node-v${NODE_VERSION}-${PLATFORM}-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz"

RUNTIME_DIR="src-tauri/runtime"

# ---- Step 0: Sync version from root package.json ----
ROOT_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
echo "=== Crispy Runtime Bundler ==="
echo "Platform: ${PLATFORM}-${NODE_ARCH}"
echo "Node.js:  v${NODE_VERSION}"
echo "Version:  ${ROOT_VERSION} (from root package.json)"
echo ""

# Patch Tauri configs to match root version (safety net)
node -e "
    const fs = require('fs');
    const ver = '$ROOT_VERSION';
    for (const f of ['$TAURI_DIR/package.json', '$TAURI_DIR/src-tauri/tauri.conf.json']) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.version !== ver) {
        console.log('    Patching ' + f + ': ' + j.version + ' → ' + ver);
        j.version = ver;
        fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
      }
    }
  "

# Skip if runtime/ already exists, looks valid, AND version matches
if [ -f "$RUNTIME_DIR/node" ] && [ -d "$RUNTIME_DIR/crispy/dist" ]; then
  CACHED_VERSION="$(node -p "require('./$RUNTIME_DIR/crispy/package.json').version" 2>/dev/null || echo "")"
  if [ "$CACHED_VERSION" = "$ROOT_VERSION" ]; then
    echo "runtime/ already exists at v${ROOT_VERSION} — skipping. Delete src-tauri/runtime/ to rebuild."
    exit 0
  else
    echo "runtime/ version mismatch (${CACHED_VERSION:-unknown} → ${ROOT_VERSION}), rebuilding..."
    rm -rf "$RUNTIME_DIR"
  fi
fi

# Clean previous partial builds
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/crispy"

# ---- Step 1: Download portable Node.js ----
echo ">>> Downloading Node.js v${NODE_VERSION} for ${PLATFORM}-${NODE_ARCH}..."

CACHE_DIR="${TMPDIR:-/tmp}/crispy-bundle-cache"
mkdir -p "$CACHE_DIR"
NODE_ARCHIVE="$CACHE_DIR/${NODE_DIST}.tar.xz"

if [ ! -f "$NODE_ARCHIVE" ]; then
  curl -fSL --progress-bar -o "$NODE_ARCHIVE" "$NODE_URL"
else
  echo "    (cached at $NODE_ARCHIVE)"
fi

echo ">>> Extracting Node.js binary..."
tar -xJf "$NODE_ARCHIVE" --strip-components=2 -C "$RUNTIME_DIR" "${NODE_DIST}/bin/node"
chmod +x "$RUNTIME_DIR/node"

echo "    Node.js binary: $(du -h "$RUNTIME_DIR/node" | cut -f1)"

# ---- Step 2: Copy crispy-code ----
echo ">>> Copying crispy-code from local build..."

# Verify the repo has been built
if [ ! -d "$REPO_ROOT/dist" ]; then
  echo "ERROR: $REPO_ROOT/dist not found. Run 'npm run build' in the repo root first."
  exit 1
fi

if [ ! -f "$REPO_ROOT/dist/crispy-cli.js" ]; then
  echo "ERROR: $REPO_ROOT/dist/crispy-cli.js not found. Run 'npm run build' in the repo root first."
  exit 1
fi

cp -r "$REPO_ROOT/dist" "$RUNTIME_DIR/crispy/dist"
cp "$REPO_ROOT/package.json" "$RUNTIME_DIR/crispy/"
cp "$REPO_ROOT/package-lock.json" "$RUNTIME_DIR/crispy/" 2>/dev/null || true

# Fix executable permissions and line endings for scripts with shebangs.
# npm pack on Windows strips Unix execute bits and may introduce CRLF endings,
# which breaks #!/usr/bin/env shebangs when extracted in WSL.
echo ">>> Normalizing script permissions and line endings..."
for f in "$RUNTIME_DIR/crispy/dist/crispy-dispatch.js" \
         "$RUNTIME_DIR/crispy/dist/crispy-cli.js" \
         "$RUNTIME_DIR/crispy/dist/recall.js" \
         "$RUNTIME_DIR/crispy/dist/crispy-agent.js" \
         "$RUNTIME_DIR/crispy/dist/crispy-plugin/scripts/crispy-session"; do
  if [ -f "$f" ]; then
    sed -i 's/\r$//' "$f"
    chmod +x "$f"
  fi
done

# ---- Step 3: Install production dependencies ----
echo ">>> Installing production dependencies (this may take a moment)..."

cd "$RUNTIME_DIR/crispy"
npm install --omit=dev --omit=optional --ignore-scripts 2>&1 | tail -3

# Safety net — remove optional deps if they slipped through
rm -rf node_modules/onnxruntime-node \
       node_modules/sharp \
       node_modules/@huggingface \
       node_modules/.package-lock.json

cd "$TAURI_DIR"

# ---- Step 4: Create WSL install tarball ----
# npm pack creates a portable .tgz that can be installed in WSL via
# `npm install --prefix ~/.crispy <tarball>` — gets correct Linux native deps.
echo ">>> Creating WSL install tarball..."

cd "$REPO_ROOT"
TARBALL_NAME=$(npm pack --pack-destination "$TAURI_DIR/$RUNTIME_DIR" 2>/dev/null | tail -1)
cd "$TAURI_DIR"

if [ -f "$RUNTIME_DIR/$TARBALL_NAME" ]; then
  echo "    Tarball: $TARBALL_NAME"
else
  echo "    WARNING: Failed to create tarball (WSL auto-provision won't work)"
fi

# ---- Step 5: Report sizes ----
echo ""
echo "=== Bundle Summary ==="
echo "Node.js binary: $(du -sh "$RUNTIME_DIR/node" | cut -f1)"
echo "crispy dist/:   $(du -sh "$RUNTIME_DIR/crispy/dist" | cut -f1)"
echo "node_modules/:  $(du -sh "$RUNTIME_DIR/crispy/node_modules" | cut -f1)"
echo "Total runtime/: $(du -sh "$RUNTIME_DIR" | cut -f1)"
echo ""

# Verify no voice/optional deps
if [ -d "$RUNTIME_DIR/crispy/node_modules/onnxruntime-node" ] || \
   [ -d "$RUNTIME_DIR/crispy/node_modules/sharp" ] || \
   [ -d "$RUNTIME_DIR/crispy/node_modules/@huggingface" ]; then
  echo "WARNING: Optional dependencies found in bundle! They should be excluded."
  exit 1
fi

echo "=== Done ==="
