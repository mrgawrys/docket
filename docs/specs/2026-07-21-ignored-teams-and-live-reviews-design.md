# Ignored teams filter + live review watch/kill — design

Two independent features, one config-driven filter and one runner/UI change.

## Feature 1: `ignored_teams` config filter

### Problem

`gh search prs --review-requested=@me` also matches PRs where a *team* you
belong to is requested (e.g. via CODEOWNERS). PRs that only concern one of
those teams get auto-reviewed — and billed — even though you'd never review
them personally.

### Config

New optional key in `config.json`:

```json
"ignored_teams": ["your-github-org/some-team"]
```

Org-qualified team slugs, matching the `slug` field `gh pr view --json
reviewRequests` returns (e.g. `your-github-org/some-team`). Absent or empty =
feature off, zero extra API calls. The example config and README use
placeholder names only — real team names never enter the repo.

### Detection

New helper in `github.ts` using the existing `prView` wrapper
(`gh pr view --json reviewRequests` returns `__typename` + `login` for users,
`__typename` + org-qualified `slug` for teams), plus a `myTeams` fetch:
`gh api user/teams --paginate` → set of `org/slug` strings, fetched **once per
poll cycle**, and only when `ignored_teams` is non-empty and at least one
unknown candidate exists.

Decision per unknown, non-draft candidate (in `poll.ts`, after the known-PR
check):

1. `ignored_teams` empty → review (today's behavior).
2. Fetch `reviewRequests`. My login requested directly → review.
3. Compute `requestedTeams ∩ myTeams`:
   - non-empty and every team in `ignored_teams` → **skip**,
     log `SKIP <key>: requested only via <teams>`.
   - any team not ignored → review.
   - empty intersection, or any API call failed → review (**fail open** —
     never silently drop a PR).

Note the rule is "skip unless *I* am needed for a non-ignored reason": a PR
touching many teams' paths is still skipped when my only connection is an
ignored team.

### Skip behavior

No state entry is written for a skipped PR. Every poll re-evaluates it (one
`gh pr view` per skipped PR per poll — negligible at a 15-minute interval).
If someone later requests the user directly, step 2 catches it and the review
starts automatically. `reviews poll --dry-run` prints
`would skip (via <team>): <key>`.

## Feature 2: watch + kill running reviews

### Problem

A `reviewing` entry is a black box: `claude -p` output is buffered in memory
until exit, there is no session id mid-run, and `reviews` refuses to open the
entry. If the review is doing something dumb, tokens burn with no way to see
it or stop it.

### Streaming runner

In `reviewer.ts` `execReview`, switch claude to
`--output-format stream-json --verbose` and copy stdout line-by-line, as it
arrives, into a per-review run log:

```
~/.local/state/auto-review/runs/<org>-<repo>-<n>.jsonl
```

(`runs/` sits under the existing state dir; path derived from the entry key.)
On exit the final `result` event — the last line — yields `session_id`
exactly as the buffered JSON did; success/failure handling is unchanged.
The run log is overwritten by a retry and deleted on dismiss alongside the
worktree.

### `reviews` list actions

Two new actions next to `d#`/`r#`, valid for `reviewing` entries:

- `w#` — watch: pretty-render the run log and follow it live. Assistant text
  prints as prose; tool calls render as one-liners
  (`→ Bash: git fetch origin pull/123/head`). Ctrl+C exits the watcher only;
  the review keeps running.
- `k#` — kill: SIGTERM to the runner pid stored on the entry. The existing
  `exec` signal handler already kills the claude child and marks the entry
  `canceled`, so no new state machinery; `r#` re-runs it later.

`reviews watch <key>` becomes the non-interactive spelling of `w#` (no
argument keeps today's behavior: follow the main log). The
"still being reviewed" error in `buildResume` now points at `w#`/`k#`.

## Testing

Follows the existing test layout in `tests/`:

- ignored-teams decision function: pure unit tests over requested
  users/teams × membership × config (direct request wins, all-ignored skips,
  mixed reviews, fail-open on missing data).
- poll wiring: dry-run prints `would skip`, no state entry written, membership
  fetched at most once per cycle.
- stream runner: stdout lines land in the run log incrementally; session_id
  parsed from final `result` line; malformed/missing result → `failed`.
- list actions: `w#`/`k#` parsing in `parseChoice`; kill only offered/valid
  for live `reviewing` entries; run log deleted on dismiss.
