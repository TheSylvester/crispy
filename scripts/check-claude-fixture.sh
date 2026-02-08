#!/usr/bin/env bash
#
# check-claude-fixture.sh
#
# Finds the richest Claude Code transcript for a version and runs the
# adapter pipeline tests directly against it. No files are copied.
#
# Usage:
#   ./scripts/check-claude-fixture.sh                     # auto-detect latest version
#   ./scripts/check-claude-fixture.sh 2.1.38              # explicit version
#   ./scripts/check-claude-fixture.sh /path/to/file.jsonl # explicit file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_PROJECTS="$HOME/.claude/projects"

# Size cap: skip files larger than this (bytes). Large transcripts are slow to
# score and test. 512KB covers most real sessions with tools+thinking.
SIZE_CAP=524288

die() { echo "error: $1" >&2; exit 1; }

# Extract the version from the first entry that has one
extract_version() {
  grep -o '"version":"[^"]*"' "$1" 2>/dev/null | head -1 | sed 's/"version":"//;s/"//'
}

# Score a file by how many distinct features it covers.
# Higher = better coverage. Fast: just greps for marker strings.
score_file() {
  local file="$1"
  local score=0

  # Entry types (1 point each)
  grep -q '"type":"user"'                  "$file" 2>/dev/null && ((score+=1)) || true
  grep -q '"type":"assistant"'             "$file" 2>/dev/null && ((score+=1)) || true
  grep -q '"type":"system"'                "$file" 2>/dev/null && ((score+=1)) || true
  grep -q '"type":"summary"'               "$file" 2>/dev/null && ((score+=1)) || true
  grep -q '"type":"result"'                "$file" 2>/dev/null && ((score+=1)) || true
  grep -q '"type":"progress"'              "$file" 2>/dev/null && ((score+=1)) || true
  grep -q '"type":"file-history-snapshot"' "$file" 2>/dev/null && ((score+=1)) || true

  # Content block types (2 points each — rarer, more valuable)
  grep -q '"type":"tool_use"'    "$file" 2>/dev/null && ((score+=2)) || true
  grep -q '"type":"tool_result"' "$file" 2>/dev/null && ((score+=2)) || true
  grep -q '"type":"thinking"'    "$file" 2>/dev/null && ((score+=2)) || true

  # Structural features (2 points each)
  grep -q '"toolUseResult"'      "$file" 2>/dev/null && ((score+=2)) || true
  grep -q '"isSidechain":true'   "$file" 2>/dev/null && ((score+=2)) || true
  grep -q '"usage":'             "$file" 2>/dev/null && ((score+=1)) || true

  echo "$score"
}

# Find the richest transcript for a version under the size cap.
# Samples up to 30 candidates and picks the highest-scoring one.
find_best_fixture() {
  local version="$1"
  local best=""
  local best_score=0

  while IFS= read -r file; do
    local size
    size=$(stat --printf='%s' "$file" 2>/dev/null || stat -f '%z' "$file" 2>/dev/null)

    # Skip files that are too small (<1KB) or too large
    [[ "$size" -gt 1024 && "$size" -lt "$SIZE_CAP" ]] || continue

    local s
    s=$(score_file "$file")

    if [[ "$s" -gt "$best_score" ]]; then
      best="$file"
      best_score="$s"
    fi
  done < <(grep -rl "\"version\":\"$version\"" "$CLAUDE_PROJECTS" --include="*.jsonl" 2>/dev/null | head -30)

  if [[ -n "$best" ]]; then
    echo "$best"
    echo "  score: $best_score" >&2
  fi
}

# Detect latest version from the most recently modified transcripts
detect_latest_version() {
  while IFS= read -r file; do
    local v
    v=$(extract_version "$file")
    if [[ -n "$v" ]]; then
      echo "$v"
      return
    fi
  done < <(find "$CLAUDE_PROJECTS" -name "*.jsonl" -type f -printf '%T@\t%p\n' 2>/dev/null \
    | sort -rn | head -10 | cut -f2)
}

# ---- Main ----

VERSION=""
TARGET_FILE=""

if [[ $# -ge 1 ]]; then
  if [[ -f "$1" ]]; then
    TARGET_FILE="$1"
    VERSION=$(extract_version "$TARGET_FILE")
    [[ -n "$VERSION" ]] || die "could not extract version from $TARGET_FILE"
  else
    VERSION="$1"
  fi
else
  echo "detecting latest Claude Code version from transcripts..."
  VERSION=$(detect_latest_version)
  [[ -n "$VERSION" ]] || die "could not detect version — no .jsonl files found in $CLAUDE_PROJECTS"
fi

echo "version: $VERSION"

# Find best file if not explicitly given
if [[ -z "$TARGET_FILE" ]]; then
  echo "searching for richest transcript (under $(( SIZE_CAP / 1024 ))KB)..."
  TARGET_FILE=$(find_best_fixture "$VERSION")
  [[ -n "$TARGET_FILE" ]] || die "no suitable .jsonl file found for version $VERSION"
fi

FILE_SIZE=$(stat --printf='%s' "$TARGET_FILE" 2>/dev/null || stat -f '%z' "$TARGET_FILE" 2>/dev/null)
echo "file: $TARGET_FILE ($(( FILE_SIZE / 1024 ))KB)"
echo ""

# Run tests with the file path passed via env var
echo "running pipeline tests..."
cd "$PROJECT_DIR"
CLAUDE_FIXTURE_FILE="$TARGET_FILE" CLAUDE_FIXTURE_VERSION="$VERSION" npx vitest run
