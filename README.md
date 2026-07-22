# auto-review

Watches GitHub for PRs awaiting your review and pre-runs Claude Code's
`/code-review` on each one, headlessly, in the PR repo's local clone — so by
the time you sit down, a finished review session is waiting to be resumed.
Reviews never write anything to GitHub.

A launchd job polls on an interval; the `reviews` binary is the front
end: list finished reviews, resume one, retry failures, dismiss what's done,
and switch the poller on/off.

## Requirements

macOS (launchd + osascript), `bun`, `gh` (authenticated), the `claude`
CLI with the code-review plugin
(`claude plugin install code-review@claude-plugins-official`), and a local
clone of every repo you review.

## Setup

1. `./install.sh` — checks dependencies, runs the test suite, builds the
   `reviews` binary into `~/.local/bin`, seeds the config, links the fish
   completions.
2. Edit `~/.config/auto-review/config.json`:
   - `orgs` — GitHub orgs to poll for PRs where your review is requested
   - `repos` — `org/repo` → absolute path of your local clone
   - `poll_interval_minutes` — launchd interval (default 15)
   - `claude_bin` — claude binary (default `claude`)
   - `claude_config_dir` — set to use a specific `CLAUDE_CONFIG_DIR`
     (useful with multiple Claude accounts); empty = default
   - `gh_account` — pin all GitHub access to this `gh` account (its token is
     resolved via `gh auth token --user`). Without it, polling silently uses
     whichever account `gh auth switch` last left active — with a personal +
     work account that means the poller can go blind without any error.
     Empty = active account.
   - `ignored_teams` — org-qualified team slugs (e.g.
     `your-github-org/some-team`). A PR that lands in your queue **only**
     because one of these teams was asked to review (CODEOWNERS or a manual
     team request) is skipped — nothing is recorded, so if someone later
     requests *you* directly the PR is picked up normally. A PR where you
     are requested personally, or via any team not listed here, is always
     reviewed. Empty = review everything.
   - `notifications` — macOS notifications on review completion (default true)
3. `reviews doctor` — checks the whole review chain (config, clones, gh
   auth, claude, code-review plugin) and prints a fix for anything broken.
   Every line should be ✓ before going further.
4. `reviews poll --dry-run` — read-only; lists what would be
   reviewed. **Everything listed gets reviewed (and billed) once the poller
   is on.** Seed a pre-existing backlog as done first:
   `jq '."ORG/REPO#N" = {status: "done", note: "seeded"}' state.json > s && mv s state.json`
   (state lives in `~/.local/state/auto-review/`).
5. `reviews on` — renders the launchd plist for this machine into
   `~/Library/LaunchAgents/` and loads it. `reviews status` to confirm.

## Day to day

- `reviews` — interactive list; pick a number to resume the session in the
  right clone, `d#` dismiss (also removes the PR's worktree), `r#` retry,
  `w#` watch a running review live, `k#` kill a running review (marks it
  canceled — no more tokens burned; `r#` starts it over).
- `reviews watch ORG/REPO#N` — follow a running review from anywhere; plain
  `reviews watch` follows the poller log as before.
- `reviews sync` — refresh entries from GitHub before listing: merged/closed
  PRs are dismissed (worktree removed), PRs you already reviewed show your
  verdict. The poller does the same refresh on every poll.
- `reviews doctor | status | log [N] | watch | on | off | help`
- `reviews review ORG/REPO#N ["note"]` — force-review any PR (e.g.
  author pushed changes without re-requesting review); accepts PR URLs too.
  The note is passed to the reviewer as extra context.
- `reviews dismiss ORG/REPO#N` — mark an entry done and remove its worktree
  without reviewing it.

## How it works

Each poll runs `gh search prs --review-requested=@me` per org, skips drafts,
already-known PRs, and PRs whose only route to you is a team in
`ignored_teams`, then hands each new PR to its own detached background
runner (`reviews exec`) that runs `claude -p` headlessly with a locked-down
tool allowlist. Runners are parallel and survive the poll process: ctrl+c on
a poll, `reviews review`, or `reviews retry` never cancels an in-flight
review — you get a notification when each one is ready. State updates are
serialized through a lock, and a runner that dies mid-review is detected by
its dead pid and marked failed. The review happens in an isolated git worktree at
`<clone>/.worktrees/pr-<n>` — the clone's main working copy is never touched;
the worktree stays for follow-up questions until the entry is dismissed.
Add `.worktrees/` to your global git excludes (`~/.config/git/ignore`).

Entry lifecycle: `reviewing` → `ready` | `failed` | `canceled` (Ctrl+C), plus
`skipped` (no local clone mapped) and `done` (dismissed). Orphaned
`reviewing` entries from a dead run flip to `failed` on the next poll. Every
poll (and `reviews sync`) also reconciles active entries against GitHub:
merged/closed PRs become `done` and lose their worktree; once you review a
PR its entry shows your verdict — `approved`, `changes-requested`, or
`commented` — with `+re-requested` / `+new-commits` flags when the author
re-requests your review or pushes after it. Flagged entries are acted on
manually (`r#` or `reviews review` with a note).

Statuses, logs, and the lock live in `~/.local/state/auto-review/`; delete a
state entry to force a re-review. `bun test` is fully mocked — no
network, no tokens.

## Development

- `bun test` — run the test suite (fully mocked, no network, no tokens)
- `bun run dev` — run the CLI from source, e.g. `bun run dev status`
- `bun run build` — compile the `reviews` binary into `dist/`
