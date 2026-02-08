#!/usr/bin/env bash
#
# check-claude-fixture.sh
#
# Checks if the currently-installed Claude Code version has a test fixture.
# If not, finds a small transcript for that version, copies it in, and runs tests.
#
# Usage:
#   ./scripts/check-claude-fixture.sh          # auto-detect version from latest transcripts
#   ./scripts/check-claude-fixture.sh 2.1.38   # explicit version
#   ./scripts/check-claude-fixture.sh /path/to/file.jsonl  # explicit file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$PROJECT_DIR/test/fixtures/claude"
CLAUDE_PROJECTS="$HOME/.claude/projects"

# ---- Helpers ----

die() { echo "error: $1" >&2; exit 1; }

# Extract the version from the first entry that has one
extract_version() {
  local file="$1"
  grep -o '"version":"[^"]*"' "$file" | head -1 | sed 's/"version":"//;s/"//'
}

# Find the smallest .jsonl file (>1KB) containing a given version string
find_small_fixture() {
  local version="$1"
  local best=""
  local best_size=999999999

  while IFS= read -r file; do
    local size
    size=$(stat --printf='%s' "$file" 2>/dev/null || stat -f '%z' "$file" 2>/dev/null)
    if [[ "$size" -gt 1024 && "$size" -lt "$best_size" && "$size" -lt 102400 ]]; then
      best="$file"
      best_size="$size"
    fi
  done < <(grep -rl "\"version\":\"$version\"" "$CLAUDE_PROJECTS" --include="*.jsonl" 2>/dev/null | head -50)

  echo "$best"
}

# Detect latest version from the most recently modified transcripts
detect_latest_version() {
  local latest_version=""

  # Check the 10 most recently modified .jsonl files
  while IFS= read -r file; do
    local v
    v=$(extract_version "$file")
    if [[ -n "$v" ]]; then
      latest_version="$v"
      break
    fi
  done < <(find "$CLAUDE_PROJECTS" -name "*.jsonl" -type f -printf '%T@\t%p\n' 2>/dev/null \
    | sort -rn | head -10 | cut -f2)

  echo "$latest_version"
}

# ---- Main ----

VERSION=""
EXPLICIT_FILE=""

if [[ $# -ge 1 ]]; then
  if [[ -f "$1" ]]; then
    # Argument is a file path
    EXPLICIT_FILE="$1"
    VERSION=$(extract_version "$EXPLICIT_FILE")
    [[ -n "$VERSION" ]] || die "could not extract version from $EXPLICIT_FILE"
  else
    # Argument is a version string
    VERSION="$1"
  fi
else
  # Auto-detect from latest transcripts
  echo "detecting latest Claude Code version from transcripts..."
  VERSION=$(detect_latest_version)
  [[ -n "$VERSION" ]] || die "could not detect version — no .jsonl files found in $CLAUDE_PROJECTS"
fi

echo "version: $VERSION"

# Check if fixture already exists
FIXTURE_DIR="$FIXTURES_DIR/$VERSION"
if [[ -f "$FIXTURE_DIR/sample.jsonl" ]]; then
  echo "fixture already exists: $FIXTURE_DIR/sample.jsonl"
  echo "running tests to verify..."
  cd "$PROJECT_DIR"
  npx vitest run
  exit 0
fi

# Need to create fixture
echo "no fixture for $VERSION — creating one..."

if [[ -n "$EXPLICIT_FILE" ]]; then
  SOURCE="$EXPLICIT_FILE"
else
  echo "searching for a small transcript with version $VERSION..."
  SOURCE=$(find_small_fixture "$VERSION")
  [[ -n "$SOURCE" ]] || die "no .jsonl file found for version $VERSION (under 100KB)"
fi

SOURCE_SIZE=$(stat --printf='%s' "$SOURCE" 2>/dev/null || stat -f '%z' "$SOURCE" 2>/dev/null)
echo "source: $SOURCE ($SOURCE_SIZE bytes)"

mkdir -p "$FIXTURE_DIR"

# If file is under 100KB, copy as-is. Otherwise take first 200 lines.
if [[ "$SOURCE_SIZE" -lt 102400 ]]; then
  cp "$SOURCE" "$FIXTURE_DIR/sample.jsonl"
else
  echo "file too large — taking first 200 lines"
  head -200 "$SOURCE" > "$FIXTURE_DIR/sample.jsonl"
fi

echo "fixture created: $FIXTURE_DIR/sample.jsonl"

# Run tests
echo ""
echo "running tests..."
cd "$PROJECT_DIR"
npx vitest run
