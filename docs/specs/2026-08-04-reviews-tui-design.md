# Reviews TUI — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (delegated, reviewed
> per task), or *plan first* (`writing-plans`, then how it gets built).
> Unattended end-to-end is `/autopilot`. Ask the user which; don't pick for
> them.

## Problem

`reviews` with no arguments prints a numbered list and asks for a choice
(`src/list.ts`). Three things are wrong with it:

- **Too little per PR.** A row is key, status, title, timestamp. Claude's
  actual assessment — the thing the whole tool exists to produce — is not shown
  anywhere. It sits unread in `~/.local/state/auto-review/runs/<key>.jsonl`.
- **Acting exits the tool.** Resuming hands the terminal to Claude and the
  process ends (`src/list.ts:192-198`). Anything else means re-running
  `reviews`.
- **One door per entry.** The only way in is resuming the Claude conversation.
  There is no way to enter the PR's worktree, or to open its diff in a review
  tool.

The last one is not a small gap. The review runs in a worktree, that worktree
is kept on purpose, and its path is already recorded on the entry
(`Entry.worktrees`, `src/state.ts:38`) — but nothing exposes it.

### Why resume cannot simply point at the worktree

Claude stores sessions under a slug of the directory it ran in. `execReview`
spawns Claude with `cwd: localPath`, the clone (`src/reviewer.ts:295`), so the
session for `javelo/react-app#6487` lives at
`~/.claude/projects/-Users-gawrys-Work-react-app/<session>.jsonl`. Running
`claude --resume` from the worktree looks under a different project slug and
finds nothing. Entering the worktree must therefore be its own verb, not a
changed `cwd` on the existing one.

## Design

`reviews` becomes a full-screen TUI built with Ink. The list occupies the rows
it needs; Claude's assessment fills the rest and scrolls; a legend sits at the
bottom. Each entry opens four ways, and every opener suspends the TUI, hands
over the terminal, and repaints on return.

```
┌─ reviews ──────────────────────────────────────────────────┐
│ ▸ 1  javelo/react-app#6487   approved    Surveys question … │
│   2  javelo/grow-api#548     commented   Pulse — shared li… │
│   3  javelo/react-app#6493   commented   Pulse — shared li… │
├─ assessment ─────────────────────────────────────── 1/8 ───┤
│ # Code review — PR #6487                                   │
│ One issue cleared the confidence bar. Five agents raised   │
│ candidates; I verified each against the source …           │
└─ enter claude · s shell · d diff · w watch · x dismiss · ? ┘
```

### Engine: Ink

Ink (React for terminals) renders the screen. The decision was made against a
hand-rolled ANSI renderer and against driving `fzf`, because the tool is
expected to grow a second view (see *Deferred*), more actions, and a detail
pane. `fzf` has no concept of views — a second screen means a second process
with no shared state. A hand-rolled renderer means owning raw-mode stdin,
escape decoding, `SIGWINCH`, scroll math and terminal restore: roughly 800–1200
lines re-implementing what Ink provides.

Measured before deciding, on this machine:

| Question | Result |
|---|---|
| Renders the layout above | Yes |
| Survives `bun build --compile` | Yes, after one fix (below) |
| Binary size | 61 MB → 62 MB |
| Dependencies | 38 packages (`ink@7`, `react@19`), +1 devDependency |
| `bun test` stays mocked | Yes — `ink-testing-library`, no TTY, simulated keystrokes |

**The fix**: Ink's reconciler guards its devtools import with
`if (process.env['DEV'] === 'true')`, but the bundler still walks the
`await import('./devtools.js')` edge, and that module top-level-imports
`react-devtools-core`. Dead at runtime is still live in the module graph at
build time. Neither `--external` nor `--define` avoids it; `react-devtools-core`
must be a devDependency or `bun run build` fails.

This ends the repo's zero-runtime-dependency property. Ink is compiled into the
binary, so it adds no requirement to a user's machine — no doctor check, no
README requirement.

### Module layout

Components render; they do not decide. Everything testable lives in plain `.ts`
with no React import.

```
src/
  tui/
    app.tsx        root: view switch, key routing, suspend orchestration
    queue.tsx      the review-queue list (rows, cursor, status colors)
    preview.tsx    assessment pane
    legend.tsx     footer legend, generated from the openers table
    suspend.ts     unmount → run child with inherited stdio → remount
  assessment.ts    NEW  pure: run-log path → assessment text
  openers.ts       NEW  pure: config + entry → { argv, cwd } | unavailable
  list.ts          KEEP buildResume, dismissKey, killEntry
                   DROP renderList, parseChoice, interactiveList
  config.ts        + `openers` key
  doctor.ts        + a check that configured openers resolve
```

This split is what makes thin UI tests safe. If opener resolution lived in a
component, "don't test the UI much" would silently mean "don't test
resolution".

### Openers

A table in config, shipped with defaults, resolved top to bottom — the first
entry whose binary exists on `PATH` wins:

```jsonc
"openers": {
  "shell": [{ "cmd": ["$SHELL"] }],
  "diff": [
    { "cmd": ["revdiff", "{base}", "{head}"] },
    { "cmd": ["tuicr", "-r", "{base}..{head}"] },
    { "cmd": ["git", "diff", "{base}...{head}"] }
  ]
}
```

Tokens: `{worktree}` `{clone}` `{base}` `{head}` `{number}` `{repo}` `{url}`.

`claude` is built in rather than configurable — it needs the session id, not a
command line, and its argv already comes from `buildResume` (`src/list.ts:54`),
including the guard for entries with no session.

**Config replaces, it does not merge.** A verb present in `openers` replaces
that verb's default chain outright; a verb absent keeps its default. Merging
would make it impossible to *remove* a default entry, and a half-overridden
chain is harder to reason about than a stated one.

**`argv` is exec'd directly, never through a shell.** No globbing, no word
splitting, no quoting rules — a token expanding to a path with spaces stays one
argument. The single exception is a literal `$SHELL` as `cmd[0]`, expanded from
the environment with `/bin/sh` as the fallback, because a login shell is the
whole point of the `shell` verb.

**Resolution is memoized per config load**, not repeated per frame: each
chain's winning entry is computed once and reused, so cursor movement does no
`PATH` lookups. The legend greys out what is not installed rather than failing
after a keypress. The binary check is injected as
`resolve: (bin: string) => boolean`, so tests state the world rather than
inheriting the developer's machine — otherwise the suite passes locally and
fails on CI, where `revdiff` and `tuicr` do not exist.

`git diff` is the floor of the `diff` chain and cannot fail; `git` is already
required.

### Where each verb runs

| key | cwd | why |
|---|---|---|
| `enter` — claude | the clone | the session is stored under the clone's path slug |
| `s` — shell | the worktree | the door missing today |
| `d` — diff | the worktree | it has the PR's branch checked out |

**Worktree resolution**: `entry.worktrees[0]`; if that path no longer exists on
disk, `s` and `d` are disabled with the reason shown in the preview pane — never
a silent fall back to the clone, which would drop the user somewhere they did
not ask to be. An entry that never had a worktree (`skipped`, `failed`) shows
the same disabled state.

**Base and head**: `{head}` is `HEAD` in the worktree. `{base}` is
`git -C <worktree> merge-base HEAD origin/HEAD`, falling back to `origin/main`.

### Suspend

One function, used by every verb:

```
unmount Ink → spawn(argv, { cwd, stdio: "inherit" }) → await exit
            → re-render Ink → reload state.json
```

The reload is not optional: a resumed Claude session can dismiss or re-review a
PR, changing `state.json` underneath the TUI. The readline loop got this free by
re-reading every iteration (`src/list.ts:140`); a long-lived TUI must do it
deliberately.

`suspend.ts` takes its spawner as a parameter, so its sequence is testable
without a terminal.

### Data flow and refresh

```
state.json ──loadState──► pendingEntries() ──► rows
runs/<key>.jsonl ──assessment.ts──► .result ──► preview pane
```

`assessment.ts` reads the **tail**, not the file. Run logs are 1.2–1.6 MB;
`tailLines` (`src/runlog.ts:42`) reads the whole file, which is fine once per
review but wasteful on every cursor move. It does a bounded read of the last
~64 KB — the result event is ~8 KB — and memoizes on `(path, mtime)`.

The assessment is the `result` field of the final stream-json event. Note that
`ReportFindings` is **not** a usable source: in a real run it was called with an
empty array while the review itself went into the prose.

Refresh happens on mount, after any action, after returning from a suspended
child, and on `state.json` changing via `fs.watch` — so a background runner
finishing repaints the list with no timer.

> `saveState` writes a temp file and `rename`s over the target
> (`src/state.ts:61-64`), which breaks a watch bound to the file inode. Watch
> the **directory**, filtered to `state.json`.

### Keymap

```
j/k ↑/↓  move          enter  claude       s  shell      d  diff
w  watch live          r  retry            x  dismiss    K  kill
p  poll                S  sync             ?  help       q  quit
```

`s` is shell, so sync moves to `S`; `k` is navigation, so kill moves to `K`.
`w` is not a special case — it suspends and runs `reviews watch KEY`, returning
on Ctrl+C, like any other opener. `?` toggles a full keymap overlay, since the
one-line legend cannot hold every binding.

A running review needs no separate indicator: its row carries the `reviewing`
status, and `fs.watch` repaints when it finishes. This replaces the
`⏳ reviewing now:` header the readline list printed (`src/list.ts:143`).

### Failure modes

| what breaks | what the user sees |
|---|---|
| no run log / no result event | preview says so; row still actionable |
| worktree recorded but gone | `s`/`d` greyed, reason in the preview |
| opener binary missing | greyed in the legend at render, never a dead keypress |
| no session id | `enter` greyed; `buildResume`'s existing message points at `r` |
| child exits non-zero | transient status line; the TUI survives |
| empty queue | hint shown, TUI stays open so `p` can populate it |
| Ctrl+C | clean unmount; terminal restored, not left in raw mode |

## Testing

Pure modules are tested normally: `openers.ts` (token substitution, fallback
order, nothing resolvable) and `assessment.ts` (bounded tail, missing file, no
result event, memoization).

Components get three tests, and only three:

| test | why it earns its place |
|---|---|
| `x` and `K` act on the highlighted row | an off-by-one dismisses the wrong PR and removes its worktree, silently |
| verbs grey out with no worktree / no session | the branch most likely to rot as openers change |
| empty queue keeps the TUI open | a deliberate past decision (`tests/list.test.ts:114`) |

Everything else about the UI is verified by running the binary. This policy is
added to `CLAUDE.md`:

```markdown
## TUI tests stay thin

The logic behind the TUI lives in pure modules (`src/openers.ts`,
`src/assessment.ts`, `src/state.ts`) and is tested normally. Components in
`src/tui/` are not. Write a component test only when the behavior is crucial —
a destructive action wired to the wrong row loses work silently — or genuinely
likely to break: a fallback path, an empty state, a disabled verb.

Never assert on layout, colors, padding, or whole frames. Those change every
time the design does, and a test that fails on cosmetic edits gets deleted
rather than fixed. If a bug is obvious the first time you run the binary, it
doesn't need a test.
```

Deleted: the `parseChoice`, `renderList` and `interactiveList` tests. Kept:
everything for `buildResume`, `dismissKey`, `killEntry`.

`bun test` stays fully mocked — no network, no tokens.

## Doctor and README

`openers` is a new config key, so per `CLAUDE.md` doctor must cover it. Doctor
reports, per verb, which entry in the chain won, and flags a chain where nothing
resolves. If doctor can pass while a fresh install cannot open a diff, doctor is
wrong.

README changes: the new keymap in *Day to day*, `openers` in *Setup*, and one
line in *Development*:

> `react-devtools-core` is a devDependency solely because Ink's dev-only branch
> is still walked by the bundler; removing it breaks `bun run build`, not the
> tests.

`config.example.json` gains the `openers` block. Fish completions need no
change — no subcommand is added or removed.

## Migration

`main.ts`'s no-arg branch renders the TUI instead of calling `interactiveList`,
and the `USAGE` first line changes. The readline menu is deleted rather than
kept as a fallback: Ink is compiled into the binary, so there is no
missing-dependency case to cover, and a second UI is maintenance with no
failure mode behind it.

Every subcommand — `poll`, `sync`, `review`, `retry`, `dismiss`, `watch`,
`doctor`, `status`, `log`, `on`, `off` — is untouched and stays scriptable.

## Build order

Riskiest first; a commit per step.

1. Add dependencies; **prove `suspend.ts` against a real TTY** — confirm the
   terminal survives Claude and revdiff. Everything else is built on this, and
   it is the only step that can invalidate the design.
2. `assessment.ts` + tests
3. `openers.ts` + config key + tests
4. TUI components + the three component tests
5. Wire into `main.ts`; delete the readline menu and its tests
6. Doctor + README + `config.example.json` + the `CLAUDE.md` policy

## Deferred

**A "my open PRs" view** — the PRs the user authored — is out of scope. The
view-switch seam is built in step 4; the second view is empty.

It is separate work because it needs a different data source. The queue view
reads `state.json`, which auto-review owns. The user's own PRs are not in
`state.json` at all — no entry, no run log, no assessment — so that view must
fetch from GitHub and set its own freshness policy. The `my-prs` skill is a
reference for the `gh` queries (CI status, review state, conflicts, unresolved
threads).

Two open questions for it: `claude` has no session to resume for a PR that was
never reviewed, and the diff opener has no fetched branch in the local clone.
