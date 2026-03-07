---
name: Add Git Worktree
description: This skill should be used when the user asks to "create a worktree", "add a worktree", "new worktree", "set up a feature branch worktree", "isolate feature development", or mentions "worktree with shared ai-reference".
---

# Add Git Worktree for Crispy

Create a new git worktree for isolated feature development on the Crispy project. The worktree shares `.ai-reference/` via symlink with the main repo, ensuring context files stay synchronized across all worktrees.

## When to Use

- Starting work on a new feature that should be isolated from main development
- Need parallel development environments without multiple clones
- Want to preserve shared `.ai-reference/` context across branches

## Usage

Run the bundled script from the Crispy project root:

```bash
${SKILL_ROOT}/scripts/add-worktree.sh <branch-name>
```

Or invoke directly if already in the main Crispy worktree:

```bash
.claude/skills/add-worktree/scripts/add-worktree.sh <branch-name>
```

## Examples

```bash
# Create worktree at ../crispy-my-feature on branch my-feature
${SKILL_ROOT}/scripts/add-worktree.sh my-feature

# Branch name is normalized - these all create the same worktree:
${SKILL_ROOT}/scripts/add-worktree.sh my-feature
${SKILL_ROOT}/scripts/add-worktree.sh crispy-my-feature
${SKILL_ROOT}/scripts/add-worktree.sh ../my-feature
```

## What the Script Does

1. Creates a new git worktree at `../crispy-<branch-name>`
2. Creates branch `<branch-name>` (or checks out existing branch if it exists)
3. Symlinks `.ai-reference/` from main repo for shared context
4. Reports the full path to the created worktree

## After Creation

1. `cd` to the new worktree path reported by the script
2. Run `npm install` (node_modules are not shared between worktrees)
3. Start development on the isolated branch

## Notes

- The main Crispy worktree is auto-detected via `git rev-parse --show-toplevel`
- Worktrees are created as siblings: `../crispy-<branch-name>`
- The `.ai-reference/` symlink ensures planning docs stay in sync
