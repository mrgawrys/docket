# How it works

## The poll

Each poll runs `gh search prs --review-requested=@me` per configured org and
filters out drafts, already-known PRs, and PRs whose only route to you is a
team in `ignored_teams`. Every new PR is handed to its own detached
background runner (`docket exec`) that runs `claude -p` headlessly with a
locked-down, read-only tool allowlist
([`extra_allowed_tools`](configuration.md#extra_allowed_tools) widens it).

Runners are parallel and survive the poll process: Ctrl+C on a poll,
`docket review`, or `docket retry` never cancels an in-flight review — you
get a notification when each one is ready. State updates are serialized
through a lock, and a runner that dies mid-review is detected by its dead
pid and marked failed.

## The worktree

The review happens in an isolated git worktree so the clone's main working
copy is never touched. The review agent chooses the worktree's location
(honoring any worktree conventions in your CLAUDE.md); docket records where
it landed and removes it when the entry is dismissed. Until then the
worktree stays, for follow-up questions from the resumed session, a shell
(`s`), or a diff (`d`).

## Entry lifecycle

`reviewing` → `ready` | `failed` | `canceled` (killed with `K` or Ctrl+C),
plus `skipped` (no local clone mapped) and `done` (dismissed). Orphaned
`reviewing` entries from a dead run flip to `failed` on the next poll.

Every poll (and `docket sync`) also reconciles active entries against
GitHub: merged/closed PRs become `done` and lose their worktree; once you
review a PR its entry shows your verdict — `approved`, `changes-requested`,
or `commented` — with `+re-requested` / `+new-commits` flags when the author
re-requests your review or pushes after it. Flagged entries are acted on
manually (`r` in the queue, or `docket review` with a note).

## Where things live

Statuses, per-review logs, and the lock live in `~/.local/state/docket/`
(`DOCKET_STATE_DIR` overrides). Delete a state entry to force a re-review.
The Claude session for each review is stored in the repo's clone — that is
why `enter` resumes it there.
