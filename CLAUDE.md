Always talk in ASD-STE100 Simplified Technical English. Always read CONTEXT.md files, and use their ubiquitous language.

# Team workflow

The issue tracker is GitHub Issues. Read `docs/agents/issue-tracker.md` before you take work. The hard rules:

- Start a ticket with `scripts/start-ticket.sh <N>` (Windows: `.ps1`) — it claims the issue, creates a **git worktree** at `.claude/worktrees/<N>-<slug>`, pushes the branch, and opens a draft PR. An issue with an assignee is taken — do not start it.
- **Implement only inside that worktree.** Do not `git checkout` the ticket branch in the primary repository root, and do not stash another agent's primary-root WIP to switch branches.
- Run `scripts/claimable.sh` (Windows: `scripts/claimable.ps1`) to list free issues (open, `ready-for-agent`, no assignee, all blockers closed).
- **Every implemented issue merges through its own pull request.** Branch `feat/<N>-<slug>`, `Closes #N` in the PR description; the start script opens the draft PR. The **merge gate** is local — in the worktree, `ruff check` and `docker compose -f compose.local.yaml config -q` must pass. When the acceptance criteria pass and the gate is green: `gh pr ready <N>`, then `gh pr merge <N> --merge --delete-branch`. Do not push issue work to main directly.
- When you stop work on an issue, remove your assignee.

# Deployment

- **Agents never deploy.** Only the user deploys, with `./deploy-ionos.sh` from their own machine. This workspace machine has no SSH access to the IONOS host.
- A push to `main` triggers the GitHub Actions image build for ghcr.io. That is expected; it does not deploy anything by itself.
