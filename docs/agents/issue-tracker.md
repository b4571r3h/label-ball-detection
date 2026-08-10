# Issue tracker workflow

The tracker is GitHub Issues on this repository. Use the `gh` CLI.

## Find free work

An issue is **claimable** when all of these are true:

- It is open and has the label `ready-for-agent`.
- It has no assignee.
- Every issue in its `## Blocked by` section is closed.
- It is not a parent ticket (label `spec` or `wayfinder:map`).

Run `scripts/claimable.sh` (macOS/Linux) or `scripts/claimable.ps1` (Windows
PowerShell) to print the claimable issues. The script does the blocker check
for you. Both scripts use the built-in jq of `gh`; you do not need a local jq
install.

## Claim and start

- Start work with one command: `scripts/start-ticket.sh <N>` (Windows:
  `scripts/start-ticket.ps1 <N>`). It claims the issue, makes the
  `feat/<N>-<slug>` branch in a **git worktree** under
  `.claude/worktrees/<N>-<slug>`, pushes it, and opens a **draft PR** — the
  team sees who works on which ticket from the first minute. No GitHub
  Actions automation does this; the script does it itself.
- The start script does **not** move the primary repository HEAD. Other
  agents keep their own checkout.
- Manual claim (fallback): `gh issue edit <N> --add-assignee @me`, then
  `git worktree add -b feat/<N>-<slug> .claude/worktrees/<N>-<slug> origin/main`.
- An issue with an assignee is taken. Do not start it.
- You can claim more than one issue, but only issues you start the same day.
  Keep at most 3 claimed issues.
- If two people appear as assignees, the later claimer removes themself.

## Worktrees (required for agents)

- **All ticket work runs inside the issue worktree.** The workspace root for
  `/implement <N>` is `.claude/worktrees/<N>-<slug>`, not the primary clone.
- Do **not** `git checkout` a ticket branch in the primary repository root.
  That steals the shared checkout from other agents.
- Do **not** `git stash` another agent's primary-root WIP to switch branches.
- List worktrees: `git worktree list`. Remove a finished one after merge:
  `git worktree remove .claude/worktrees/<N>-<slug>`.
- `.claude/worktrees/` is gitignored; each folder is its own checkout.

## Work

- One branch per issue: `feat/<N>-<slug>`.
- Reference the issue in each commit subject: `(#N)`.
- Open a **draft pull request early**. The issue's Development link then shows
  live progress to the whole team.
- **Every implemented issue merges through its own pull request.** Put
  `Closes #N` in the PR description. Do not push issue work to main directly.
- When the acceptance criteria pass and the local runs are green, finish the
  PR: `gh pr ready <N>`, then `gh pr merge <N> --merge --delete-branch`.

## Release and stale claims

- When you stop work on an issue, remove your assignee.
- When an issue is assigned for more than 24 hours with no linked branch or
  PR: ping the assignee; after that, anyone can unassign.

## Implement a ticket with an agent

1. `git pull` in the primary root (optional), then see your queue:
   `gh issue list --assignee @me --state open`.
   No queue? Run the claimable script and claim one ticket from your chain.
2. Make sure the issue shows you as assignee before you start.
3. Confirm the worktree exists (`git worktree list`). Start a **fresh agent
   session** with the worktree as the working directory and run
   `/implement <N>`. One ticket per session; clear the context between
   tickets.
4. The implement flow ends in a pull request with `Closes #N` (the draft PR
   from the start push). When done: run the merge gate from `CLAUDE.md` in
   the worktree, mark the PR ready, merge it (`gh pr ready`,
   `gh pr merge --merge --delete-branch`).
5. After the merge: `git worktree remove` the ticket worktree, pull main in
   the primary root, run the claimable script, take the next ticket.

## Fetch an issue (for specs and reviews)

- `gh issue view <N>` — body and criteria.
- `gh issue view <N> --comments` — discussion.

## Create issues

- `gh issue create --title "..." --body "..."`.
- Record blockers in a `## Blocked by` section, one `- #N` line per blocker.
- Add the label `ready-for-agent` only when the issue is complete enough for
  someone to implement without questions.

## Parent tickets and sub-issues

A **parent ticket** is a spec (label `spec`) or a wayfinder map (label
`wayfinder:map`). It is an index and a decision trail. Nobody implements it.

- Each child names its parent in a `## Parent` section: `Spec: #N`.
- Each child is also a **native GitHub sub-issue** of its parent. Link it:

  ```sh
  ID=$(gh api repos/:owner/:repo/issues/<CHILD> --jq '.id')
  gh api -X POST repos/:owner/:repo/issues/<PARENT>/sub_issues -F sub_issue_id=$ID
  ```

  The parent then shows a live progress bar. To list the children and their
  state, use the same route with `gh api`.

- The parent also keeps a `## Tickets` list. It carries the blocker chain,
  which the sub-issue panel does not show. Tick the box when a child closes —
  GitHub does not tick it for you.
- Close the parent when every sub-issue is closed.
