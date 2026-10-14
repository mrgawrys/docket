# PR lifecycle hooks — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it
> gets built). Ask the user which; don't pick for them.

## What and why

Merging a PR is rarely the end of the work: a ticket changes status, someone
gets told, staging gets checked, a translation task gets filed. Those steps
live in the author's head and get forgotten. docket already tracks the user's
authored PRs and notices when they merge; this feature attaches the
follow-up to those moments.

Two halves:

- **Hooks** — user-owned executables docket runs when one of the user's PRs
  opens or merges. They do the deterministic work (move a ticket) and hand
  back to-dos for the human work. No LLM at runtime.
- **To-dos** — an `After merge` task list in the PR description plus anything
  hooks emit, kept on the PR's row in a new **Finished** tab until ticked off.

docket stays tracker-agnostic: it knows nothing about ClickUp, Jira or Slack.
That knowledge lives in the user's hooks, which Claude writes for them
(`docket hooks edit`).

## Decisions (settled during design)

- **Rules are code, not config.** Declarative rules with a built-in tracker
  integration and a cheap-model-per-event runner were both rejected: the first
  couples the open-source tool to one tracker and grows a DSL per nuance, the
  second pays an LLM run per event and isn't deterministic.
- **Per-PR notes live in the PR description**, not a comment (comments email
  every reviewer) and not docket-local state (unreachable from GitHub, other
  machines, other Claude sessions).
- **Events:** `opened` and `merged` only. `closed`-unmerged and `deployed`
  are deferred; `deployed` needs per-repo deploy-workflow knowledge.

## Events and lifecycle

| Event | Fires when | Where |
|---|---|---|
| `opened` | an authored PR is first seen non-draft, or flips draft → ready | poll, mine discovery / sync |
| `merged` | sync sees `MERGED` | `retire()`, before cleanup |

Each event fires at most once per PR, recorded on the entry as
`hooks: { [event]: { at, ok, attempts, did[], warn[] } }`. A failed run
(non-zero exit, timeout) retries on the next poll, up to 3 attempts, then the
row is flagged `hook-failed`. Hooks must therefore be idempotent.

**No backfill.** The first poll that sees a hooks directory marks every
already-tracked open mine entry's `opened` as fired without running it;
turning the feature on must not bulk-move old tickets.

**After merge:** if the PR ends up with any open to-do, the entry takes the new
status `finished` instead of `done` and shows in the Finished tab. With none,
it goes `done` as today. Worktree/checkout cleanup on merge is unchanged.

## Hook contract

- `~/.config/docket/hooks/<event>` (under `DOCKET_CONFIG_DIR`), any
  executable. Missing file → event is a no-op.
- **stdin:** one JSON object:

  ```jsonc
  {
    "event": "merged",
    "dry_run": false,
    "pr": {
      "repo": "org/repo", "number": 331, "url": "…", "title": "…",
      "branch": "…", "base": "main", "draft": false, "labels": ["…"],
      "merged_at": "…",           // null for opened
      "body": "…",
      "files": ["path/…"],
      "comments": [{ "author": "…", "body": "…" }]
    },
    "notes": ["…"],              // unchecked After-merge items
    "local_path": "/path/to/clone"
  }
  ```

- **stdout:** JSON lines — `{"todo": "…", "link": "…"?}`, `{"did": "…"}`,
  `{"warn": "…"}`. Non-JSON lines go to the run log only.
- cwd is the hooks directory; environment is the poller's; timeout 60 s.
  A failed run's `todo`s are discarded so a retry doesn't duplicate them.
- `dry_run: true` means: print what you would do, change nothing.
- Secrets are the hook's business (e.g. macOS Keychain via
  `security find-generic-password`, which works under launchd).

## After-merge notes

At merge, docket parses the PR body for a heading whose text is
`After merge` (any level, case-insensitive) and takes the task-list items
under it, up to the next heading of the same or higher level. Unchecked
`- [ ]` items become to-dos; checked ones are ignored. The same list is
passed to hooks as `notes`.

## Finished tab

A third tab beside the review queue and my PRs, listing `finished` entries.
The panel shows the highlighted row's to-dos (numbered, with links) and the
hook's `did`/`warn` lines. Keys:

- `1`–`9` toggle that to-do; when every to-do is ticked the entry goes `done`
- `o` opens the highlighted row's first open to-do link, else the PR
- `x` dismisses the row (→ `done`)

Ticks live in docket's state only; docket never writes to GitHub.

## Authoring and testing hooks

- `docket hooks payload <pr> --event <e>` prints the JSON a hook would get.
- `docket hooks test <pr> --event <e>` runs the hook with `dry_run: true` and
  prints parsed output.
- `docket hooks edit [event]` opens an interactive `claude` session in the
  hooks directory with a brief: the contract above, a real payload, the test
  command, and the idempotency and dry-run rules.
- `docket doctor` lists hooks and checks each is executable.

## Testing

Pure, mocked seams in `bun test` (no network):

- After-merge parsing (`parseAfterMerge(body)`)
- Hook output parsing (`parseHookOutput(stdout)`)
- Event decisions — which events are due for an entry given PR info and the
  `hooks` record, including retry cap and the no-backfill seed
- Merge outcome: `finished` vs `done` given to-dos
- The runner against a fixture executable (exit codes, timeout, dry run)

TUI tab is checked by hand with `bun run demo` / `bun run frames`.
