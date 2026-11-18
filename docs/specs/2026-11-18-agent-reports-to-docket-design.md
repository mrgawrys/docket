# Agents report to docket by command — Design

> **To act on this design:** pick a mode — *vibe* (right now, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it gets built).
> Ask the user which; don't pick for them.

Builds on branch `receive-report-per-point` (one section per review point,
not yet merged): its `RECEIVE_REPORT_INSTRUCTION` stays, the summary demand
after it changes.

## Goal

Two problems, one mechanism:

1. **A worked review stays `ready` forever.** On a mine entry, `ready` means
   "a receive run finished, its report is waiting". Nothing moves it once the
   author has dealt with it — only new feedback, merge or close do.
2. **The summary pollutes the session.** Every run (review and receive) ends
   its last message with a fenced json block docket parses. The author reads
   that block every time they resume the session.

Both become the agent telling docket directly, by running a docket command.

## Decisions

- **The agent calls a docket CLI verb through Bash.** Not an MCP tool: docket
  stays "spawn claude, read state"; no server mode, no `--mcp-config` on every
  launch, and a session resumed by hand still works.
- **Two verbs:** `report` (every run, replaces the json block) and `handled`
  (mine entries, resumed session only).
- **A ready mine row leaves `ready` when** the agent runs `handled`, **or**
  sync sees the PR's review threads go from some unresolved to none. A push
  alone does not count.
- **Leaving `ready` lands on the reviewers' current standing** (worst verdict,
  as `mineStanding` computes it), or `open` when there is none. No new status.
- **Scope: both run kinds.** Review runs switch from the json block to
  `report` too.

## The self command

The prompt and the allowlist name docket by how the running docket was
started, so it works under brew, launchd and `bun src/main.ts`:

- compiled binary (`Bun.main` under `/$bunfs/`): `process.execPath`
- otherwise: `process.execPath` + `Bun.main` (bun + the entry script)

One function, `selfCommand(): string`, injectable in tests. Paths with spaces
are quoted.

Docket sets `DOCKET_CONFIG_DIR` and `DOCKET_STATE_DIR` to its resolved
directories in the env of every claude it spawns — the background run and the
resume behind enter — so a verb the agent runs writes to the same state as the
docket that launched it (scratch-dir runs included).

## `docket report`

```
<self> report <key> [--headline TEXT] [--issues N] [--risk low|medium|high]
                    [--addressed N] [--deferred N]
```

- Validates exactly as the json block was validated (headline cleaned and cut
  to 200 chars, counts non-negative integers, risk one of three). The
  validators move out of `splitSummary` into a shared `toSummary(fields)`.
- Unknown flag, bad value, unknown key, or no field at all → non-zero exit
  with a one-line reason on stderr, so the agent sees it and retries.
- Replaces `entry.summary` (last call wins), under the state lock.
- Callable any time — a resumed session may update the headline after more
  work. Prints one confirmation line.

**Run lifecycle around it:**

- Run start clears `entry.summary`, so a run that never reports shows no
  stale summary from the previous one.
- Run end (the `ready` / `failed` write in `reviewer.ts`) keeps the
  `summary` currently on the entry. Review entries are rewritten wholesale
  there today — `summary` joins what that rewrite carries.
- Run end no longer parses the final message for a summary.
  `splitSummary` stays only where the panel strips a trailing block from the
  prose (`assessment.ts`), for sessions that predate this change.

**Prompt:** `SUMMARY_INSTRUCTION` and `RECEIVE_SUMMARY_INSTRUCTION` become
functions of `(self, key)` and read, for a review:

> As your last action, report to docket's queue by running
> `<self> report <key> --headline "…" --issues N --risk low|medium|high` —
> headline one line, at most 80 characters, the first thing the reviewer
> should know; leave out `--issues` if finding issues was not your task and
> `--risk` if you did not assess it. Run it once; do not repeat the summary in
> your message.

Receive: same, with `--addressed` / `--deferred` and the existing wording for
when to omit them.

**Allowlist:** both background runs get `Bash(<self> report:*)` on top of
their current list. Not `handled`.

## `docket handled`

```
<self> handled <key>
```

- Mine keys only, and only from `ready`; anything else → non-zero exit naming
  the current status, state untouched.
- Sets the entry to `open`, then syncs that one PR at once (the existing
  mine sync path), which moves `open` to the standing verdict and also catches
  any feedback that arrived meanwhile. If that sync fails, the entry stays
  `open` and the next poll corrects it; the command still exits 0 and says so.

**Prompt** (added to the fixed receive wrapper, after the report
instruction):

> This first run ends with your report — never run `handled` in it. If the
> author comes back to this session and has pushed your work or settled every
> point another way: re-read all three feedback sources first. If anything
> arrived after your report, tell them and work it. Otherwise run
> `<self> handled <key>`.

In the resumed session (`claude --resume`, no allowlist) this asks the
author's permission unless their own settings allow it — intended.

## Sync: all threads resolved

In `syncMine`, where the thread counts are refreshed, before writing them:

```
settled = entry.status == "ready"
       && previous.unresolved > 0      // entry.threads as last synced
       && next.unresolved == 0
→ status = standing?.verdict ?? "open", reviewer = standing?.reviewer
```

A pure `threadsSettled(prev, next): boolean` holds the comparison. The
"was > 0" half keeps a PR with no threads, or threads resolved before the run,
from leaving `ready` the moment it lands. Such a row leaves through `handled`,
new feedback, or `x`.

## Doctor and docs

Per CLAUDE.md, the allowlist entry is a pipeline dependency:

- `src/doctor.ts`: a check that `selfCommand()` resolves to an executable
  (binary exists, or bun + entry script exist), with tests.
- README Requirements/Setup: one line that runs call back into docket.
- `docs/configuration.md`: the fixed-wrapper paragraphs under `review_prompt`
  and `receive_prompt` say "a closing `report` call" instead of "a closing
  summary block", and the receive one names `handled`.

## Testing

Seams, all mocked (no network, no tokens):

- **`report` / `handled` command handlers** against a temp state dir:
  valid fields written; each rejection exits non-zero and leaves state
  untouched; `handled` from `ready` lands on `open` then the standing (mocked
  gh), from any other status refuses, and survives a failing sync.
- **`threadsSettled`** — the transition table (>0→0 fires; 0→0, >0→>0,
  no-previous don't).
- **`syncMine`** with mocked gh: a ready row whose threads go to 0 lands on
  the standing; one that was already at 0 stays `ready`.
- **Prompts:** review and receive prompts contain the `report` line with the
  key and self command, no ```` ```json ````; the receive prompt has the
  `handled` paragraph, the review prompt does not.
- **Run lifecycle:** start clears `summary`; end keeps one written mid-run
  for both entry kinds; the final message is not parsed.
- **Allowlist:** both runs include `Bash(<self> report:*)`, neither
  includes `handled`.
- **Doctor:** the self-command check passes and fails as it should.

## Not in this change

- Push detection (head sha moving) — dropped in favour of threads + agent.
- Watching conversation comments in sync — the agent's re-read before
  `handled` covers the case that motivated it.
- A TUI key for `handled` — `x` dismiss and the CLI verb cover it for now.
