#!/usr/bin/env bash
# Start work on issue N: claim it, make the branch in a worktree, push it,
# and open the draft PR, so the team sees the work immediately. The
# repository runs no issue automation; this script does that itself.
# The worktree keeps the primary checkout free for other agents.
# Windows: use scripts/start-ticket.ps1.
set -euo pipefail

n="${1:?usage: start-ticket.sh <issue-number>}"

title=$(gh issue view "$n" --json title --jq .title)
slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)
branch="feat/$n-$slug"
worktree_dir=".claude/worktrees/${n}-${slug}"

gh issue edit "$n" --add-assignee @me
git fetch -q origin main
mkdir -p .claude/worktrees

if [ -e "$worktree_dir" ]; then
  echo "error: worktree path already exists: $worktree_dir" >&2
  exit 1
fi

# Add the branch and the worktree without moving the primary HEAD.
git worktree add -b "$branch" "$worktree_dir" origin/main

(
  cd "$worktree_dir"
  git commit --allow-empty -m "chore: start work on #$n"
  git push -u origin HEAD
)

# Open the draft PR here, not from CI: the repository runs no Actions.
if [ "$(gh pr list --head "$branch" --state open --json number --jq length)" -eq 0 ]; then
  gh pr create --draft --head "$branch" \
    --title "$title (#$n)" \
    --body "$(printf 'Closes #%s\n\nDraft opened by scripts/start-ticket.sh on the first push of `%s`.' "$n" "$branch")"
fi

echo "Branch $branch pushed and its draft PR is open."
echo "Work only in the worktree: $worktree_dir"
echo "Do not git checkout $branch in the primary repository root."
echo "Now run /implement $n in a fresh agent session with cwd=$worktree_dir."
