# docket

Watches GitHub for PRs awaiting your review and pre-runs Claude Code's
`/code-review` on each one, headlessly, in the PR repo's local clone — so by
the time you sit down, a finished review session is waiting to be resumed.
Reviews never write anything to GitHub.

A launchd job polls on an interval; the `docket` binary is the front end: a
full-screen queue showing each PR's verdict, with four ways into an entry —
resume the Claude session, open a shell or a diff in the PR's worktree, or
follow a running review — plus retry, dismiss, and the poller switch.

## Why "docket"?

A docket is the list of cases waiting on a judge. This is that list for code:
every entry is a case awaiting your judgment, and the triage summary each
review ends with is the brief you read before deciding.

## Requirements

macOS (launchd + osascript), `bun`, `gh` (authenticated), the `claude`
CLI, and a local clone of every repo you review. The default review runs
Claude Code's code-review plugin
(`claude plugin install code-review@claude-plugins-official`); it is required
only while `review_prompt` runs `/code-review` (see below) — a custom prompt
that doesn't need it. `docket doctor` enforces exactly this.

## Setup

1. `./install.sh` — checks dependencies, runs the test suite, builds the
   `docket` binary into `~/.local/bin`, links the shell completions (bash,
   zsh, fish), and clears out what the old `auto-review` install left behind
   (its binary, completions, and launchd job — if that job was polling, the
   installer re-enables it under the new name).

   Or, from Homebrew — `brew install mrgawrys/tap/docket` — which installs the
   same binary and completions without a local checkout. It works from the
   first tagged release onward; `./install.sh` remains the from-source path.
   Coming from `auto-review` this way, run `docket on` afterwards: it removes
   the old poller, which would otherwise keep running and review everything a
   second time. `docket doctor` reports it if it is still there.
2. `docket doctor` — the first run writes a starter config to
   `~/.config/docket/config.json` and stops. Coming from `auto-review`, it
   copies that install's config and state over instead, so the queue survives
   the rename (the originals are left alone). If you pinned the old
   `AUTO_REVIEW_CONFIG_DIR` / `AUTO_REVIEW_STATE_DIR`, those are still honoured
   and used where they are — nothing is copied.
3. Edit `~/.config/docket/config.json`.
   - `orgs` — GitHub orgs to poll for PRs where your review is requested
   - `repos` — `org/repo` → absolute path of your local clone
   - `poll_interval_minutes` — launchd interval (default 15)
   - `claude_bin` — claude binary (default `claude`)
   - `claude_config_dir` — set to use a specific `CLAUDE_CONFIG_DIR`
     (useful with multiple Claude accounts); empty = default
   - `claude_env` — extra environment variables for every claude invocation
     (review runs and resumes), e.g. to mute a notification hook of your
     Claude setup that would otherwise fire from unattended review sessions.
     `claude_config_dir` wins if both set `CLAUDE_CONFIG_DIR`. Empty = none.
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
   - `review_prompt` — the review task handed to claude. Omit (or leave
     blank) to run the default, `Review the PR by running /code-review
     {number}.` Every run is first told to do its work in a git worktree and
     never touch the main working copy — that part is fixed and not
     configurable; `review_prompt` is only the task in between. The agent
     picks *where* the worktree goes (following your own worktree conventions
     in CLAUDE.md, if any); docket discovers it afterwards and removes it
     on dismiss. Every run is also asked — again, not configurably — to end
     its final message with a fenced `json` block,
     `{"headline": …, "issues": …, "risk": "low"|"medium"|"high"}`, which is
     what the queue renders per row. A prompt that cannot answer a field
     omits it: one that never hunts for issues reports no count rather than a
     misleading zero, and the row simply shows less. A run that ignores the
     block falls back to the first lines of its prose, so nothing breaks.
     Tokens `{number}` and `{repo}` (org/repo) are substituted; a
     prompt with no token is used as-is. A prompt that doesn't run
     `/code-review` needs no plugin (doctor checks this).
   - `extra_allowed_tools` — entries appended to the built-in tool allowlist
     for the headless run, in claude's `--allowedTools` grammar (e.g.
     `"Bash(bun test:*)"`, `"Skill(my-review)"`). Needed when a custom
     `review_prompt` uses tools the baseline doesn't cover — headless runs
     can't prompt, so anything outside the allowlist is silently denied. The
     baseline is read-only and never posts to GitHub; entries you add here run
     without prompts, so adding posting tools (e.g. `Bash(gh pr comment:*)`)
     gives that guarantee up knowingly. Empty = baseline only.
   - `openers` — what the queue's `s` and `d` keys run, as a chain of
     candidate commands per verb; the first whose binary is on `PATH` wins, so
     the shipped `diff` chain tries `revdiff`, then `tuicr`, then plain
     `git diff`. Both verbs run in the PR's worktree. Tokens `{worktree}`
     `{clone}` `{base}` `{head}` `{number}` `{repo}` `{url}` are substituted
     per argument — the command is executed directly, never through a shell,
     so a path with spaces stays one argument. The one exception is a literal
     `$SHELL` as the first word, taken from the environment (`/bin/sh` if
     unset). A verb you set **replaces** its default chain rather than adding
     to it, so keep a fallback that always resolves. Omit = the shipped chains
     above; `docket doctor` prints the winner per verb.
4. `docket doctor` again — checks the whole review chain (config, clones, gh
   auth, claude, code-review plugin, openers) and prints a fix for anything
   broken. It also fails while the config still holds the starter placeholders,
   and if the pre-rename poller is still loaded.
   Every line should be ✓ before going further.
5. `docket poll --dry-run` — read-only; lists what would be
   reviewed. **Everything listed gets reviewed (and billed) once the poller
   is on.** Seed a pre-existing backlog as done first:
   `jq '."ORG/REPO#N" = {status: "done", note: "seeded"}' state.json > s && mv s state.json`
   (state lives in `~/.local/state/docket/`).
6. `docket on` — renders the launchd plist for this machine into
   `~/Library/LaunchAgents/` and loads it, baking the `PATH` from the shell you
   run it in ahead of a safe fallback. Run it from your normal shell (with your
   version manager active) so polled runs see the same toolchain — e.g. `node`
   for a blast-radius pass. Re-run `docket on` after changing your PATH.
   `docket status` to confirm.

## Day to day

- `docket` — the review queue. Each row carries the review's verdict at a
  glance — how many issues it would flag, and the risk it graded the PR — and
  a short panel under the list gives the highlighted PR's headline finding.
  It is a triage screen: `enter` is how a review actually gets read.

  ```
  j/k ↑/↓  move          enter  claude       s  shell      d  diff
  w  watch live          r  retry            x  dismiss    K  kill
  p  poll                S  sync             ?  help       q  quit
  ```

  `enter` resumes the Claude session in the clone (that is where the session
  is stored). `s` and `d` open the PR's worktree — a shell in it, or its diff
  in whichever diff tool you have (see `openers`). Each of these hands the
  terminal over and comes back to the list when the program exits; `x` also
  removes the PR's worktree, and `K` kills a running review (marks it
  canceled — no more tokens burned; `r` starts it over). A verb this machine
  cannot run is greyed out with the reason shown in the panel,
  rather than failing after the keypress. Without a terminal — from a script
  or a cron wrapper — it prints the pending queue and exits instead.
- `docket watch ORG/REPO#N` — follow a running review from anywhere; plain
  `docket watch` follows the poller log as before.
- `docket sync` — refresh entries from GitHub before listing: merged/closed
  PRs are dismissed (worktree removed), PRs you already reviewed show your
  verdict. The poller does the same refresh on every poll.
- `docket doctor | status | log [N] | watch | on | off | help`
- `docket review ORG/REPO#N ["note"]` — force-review any PR (e.g.
  author pushed changes without re-requesting review); accepts PR URLs too.
  The note is passed to the reviewer as extra context.
- `docket dismiss ORG/REPO#N` — mark an entry done and remove its worktree
  without reviewing it.

## How it works

Each poll runs `gh search prs --review-requested=@me` per org, skips drafts,
already-known PRs, and PRs whose only route to you is a team in
`ignored_teams`, then hands each new PR to its own detached background
runner (`docket exec`) that runs `claude -p` headlessly with a locked-down
tool allowlist. Runners are parallel and survive the poll process: ctrl+c on
a poll, `docket review`, or `docket retry` never cancels an in-flight
review — you get a notification when each one is ready. State updates are
serialized through a lock, and a runner that dies mid-review is detected by
its dead pid and marked failed. The review happens in an isolated git worktree
so the clone's main working copy is never touched. The review agent chooses the
worktree's location (honoring any worktree conventions in your CLAUDE.md);
docket records where it landed and removes it when the entry is dismissed.
The worktree stays for follow-up questions until then.

Entry lifecycle: `reviewing` → `ready` | `failed` | `canceled` (Ctrl+C), plus
`skipped` (no local clone mapped) and `done` (dismissed). Orphaned
`reviewing` entries from a dead run flip to `failed` on the next poll. Every
poll (and `docket sync`) also reconciles active entries against GitHub:
merged/closed PRs become `done` and lose their worktree; once you review a
PR its entry shows your verdict — `approved`, `changes-requested`, or
`commented` — with `+re-requested` / `+new-commits` flags when the author
re-requests your review or pushes after it. Flagged entries are acted on
manually (`r#` or `docket review` with a note).

Statuses, logs, and the lock live in `~/.local/state/docket/`; delete a
state entry to force a re-review. `bun test` is fully mocked — no
network, no tokens.

## Development

- `bun test` — run the test suite (fully mocked, no network, no tokens)
- `bun run dev` — run the CLI from source, e.g. `bun run dev status`
- `bun run build` — compile the `docket` binary into `dist/`
- `bun run format` — format with Biome (`format:check` is enforced in CI, and a
  Claude Code hook in `.claude/settings.json` auto-formats agent edits)
- `react-devtools-core` is a devDependency solely because Ink's dev-only branch
  is still walked by the bundler; removing it breaks `bun run build`, not the
  tests.
