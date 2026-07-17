# auto-review

Watches GitHub for PRs awaiting your review and pre-runs Claude Code's
`/code-review` on each one, headlessly, in the PR repo's local clone — so by
the time you sit down, a finished review session is waiting to be resumed.
Reviews never write anything to GitHub.

A launchd job polls on an interval; the `reviews` fish command is the front
end: list finished reviews, resume one, retry failures, dismiss what's done,
and switch the poller on/off.

## Requirements

macOS (launchd + osascript), fish, `jq`, `gh` (authenticated), the `claude`
CLI, and a local clone of every repo you review.

## Setup

1. `./install.sh` — checks dependencies, seeds the config, symlinks the fish
   function, runs the (mocked, offline) test suite.
2. Edit `~/.config/auto-review/config.json`:
   - `orgs` — GitHub orgs to poll for PRs where your review is requested
   - `repos` — `org/repo` → absolute path of your local clone
   - `poll_interval_minutes` — launchd interval (default 15)
   - `claude_bin` — claude binary (default `claude`)
   - `claude_config_dir` — set to use a specific `CLAUDE_CONFIG_DIR`
     (useful with multiple Claude accounts); empty = default
   - `notifications` — macOS notifications on review completion (default true)
3. `bash bin/auto-review --dry-run` — read-only; lists what would be
   reviewed. **Everything listed gets reviewed (and billed) once the poller
   is on.** Seed a pre-existing backlog as done first:
   `jq '."ORG/REPO#N" = {status: "done", note: "seeded"}' state.json > s && mv s state.json`
   (state lives in `~/.local/state/auto-review/`).
4. `reviews on` — renders the launchd plist for this machine into
   `~/Library/LaunchAgents/` and loads it. `reviews status` to confirm.

## Day to day

- `reviews` — interactive list; pick a number to resume the session in the
  right clone, `d#` dismiss (also removes the PR's worktree), `r#` retry.
- `reviews status | log [N] | watch | on | off | help`
- `bin/auto-review --review ORG/REPO#N ["note"]` — force-review any PR (e.g.
  author pushed changes without re-requesting review); accepts PR URLs too.
  The note is passed to the reviewer as extra context.

## How it works

Each poll runs `gh search prs --review-requested=@me` per org, skips drafts
and already-known PRs, then runs `claude -p` headlessly with a locked-down
tool allowlist. The review happens in an isolated git worktree at
`<clone>/.worktrees/pr-<n>` — the clone's main working copy is never touched;
the worktree stays for follow-up questions until the entry is dismissed.
Add `.worktrees/` to your global git excludes (`~/.config/git/ignore`).

Entry lifecycle: `reviewing` → `ready` | `failed` | `canceled` (Ctrl+C), plus
`skipped` (no local clone mapped) and `done` (dismissed). Orphaned
`reviewing` entries from a dead run flip to `failed` on the next poll.

Statuses, logs, and the lock live in `~/.local/state/auto-review/`; delete a
state entry to force a re-review. `tests/tests.sh` is fully mocked — no
network, no tokens.
