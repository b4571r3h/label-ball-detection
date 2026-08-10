# Start work on issue N: claim it, make the branch in a worktree, push it,
# and open the draft PR, so the team sees the work immediately. The
# repository runs no GitHub Actions; this script does what CI did.
# The worktree keeps the primary checkout free for other agents.
# macOS/Linux: use scripts/start-ticket.sh.
param([Parameter(Mandatory = $true)][int]$IssueNumber)
$ErrorActionPreference = 'Stop'

$title = gh issue view $IssueNumber --json title --jq .title
$slug = ($title.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
$branch = "feat/$IssueNumber-$slug"
$worktreeDir = ".claude/worktrees/$IssueNumber-$slug"

gh issue edit $IssueNumber --add-assignee '@me'
git fetch -q origin main
New-Item -ItemType Directory -Force -Path '.claude/worktrees' | Out-Null

if (Test-Path $worktreeDir) {
  throw "Worktree path already exists: $worktreeDir"
}

# Add the branch and the worktree without moving the primary HEAD.
git worktree add -b $branch $worktreeDir origin/main

Push-Location $worktreeDir
try {
  git commit --allow-empty -m "chore: start work on #$IssueNumber"
  git push -u origin HEAD
}
finally {
  Pop-Location
}

# Open the draft PR here, not from CI: the repository runs no Actions.
$openCount = gh pr list --head $branch --state open --json number --jq length
if ([int]$openCount -eq 0) {
  $body = "Closes #$IssueNumber`n`nDraft opened by scripts/start-ticket.ps1 on the first push of ``$branch``."
  gh pr create --draft --head $branch --title "$title (#$IssueNumber)" --body $body
}

Write-Host "Branch $branch pushed and its draft PR is open."
Write-Host "Work only in the worktree: $worktreeDir"
Write-Host "Do not git checkout $branch in the primary repository root."
Write-Host "Now run /implement $IssueNumber in a fresh agent session with cwd=$worktreeDir."
