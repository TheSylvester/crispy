#!/bin/bash
# Create a new git worktree with shared .ai-reference

set -e

MAIN_WORKTREE="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
INPUT="$1"

if [ -z "$INPUT" ]; then
  echo "Usage: add-worktree.sh <branch-name>"
  echo "Example: add-worktree.sh my-feature"
  echo "         add-worktree.sh ../my-feature"
  exit 1
fi

# Strip leading ../ or ./ and any crispy- prefix to get clean branch name
BRANCH=$(echo "$INPUT" | sed -E 's|^\.\.?/||; s|^crispy-||')
WORKTREE_PATH="../crispy-$BRANCH"

echo "Creating worktree at $WORKTREE_PATH on branch $BRANCH..."
git worktree add "$WORKTREE_PATH" -b "$BRANCH" 2>/dev/null || git worktree add "$WORKTREE_PATH" "$BRANCH"

echo "Symlinking .ai-reference..."
ln -s "$MAIN_WORKTREE/.ai-reference" "$WORKTREE_PATH/.ai-reference"

echo "Done! Worktree created at: $(realpath "$WORKTREE_PATH")"
