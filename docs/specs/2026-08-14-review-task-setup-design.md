# Review task setup — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it
> gets built). Unattended end-to-end is `/autopilot`. Ask the user which; don't
> pick for them.

Builds on
[2026-07-24-configurable-review-prompt-design.md](2026-07-24-configurable-review-prompt-design.md),
which made the review task configurable, and
[2026-08-07-first-run-wizard-and-denial-surfacing-design.md](2026-08-07-first-run-wizard-and-denial-surfacing-design.md),
which built the wizard this adds a step to. Neither is changed by it.

## Why

Setup covers everything except the one key that decides what a review does.
The wizard walks account → orgs → clones → write → doctor, and
`src/wizard/claude-prompt.md:133` tells the claude-guided route the same thing
in as many words: "Leave out `poll_interval_minutes`, `claude_bin`, `openers`,
and everything else." A finished setup runs the default,
`Review the PR by running /code-review {number}.`, and the only way to change
that is to hand-edit `~/.config/docket/config.json`.

Hand-editing is where the second problem starts. `review_prompt` and
`extra_allowed_tools` are one unit wearing two keys: a task that says "run the
blast-radius skill" needs `Bash(node:*)` and `Bash(git merge-base:*)` — facts
that live inside the skill file, not in the sentence that names it. A headless
run cannot ask, so anything unlisted is denied mid-run. Someone who writes a
custom task by hand gets a review that half-works and a `⊘` chip explaining it
afterwards.

Third, a custom task makes `docket doctor` check *less*. `src/doctor.ts:183`
only verifies the code-review plugin when the effective prompt mentions
`/code-review`; otherwise it prints `code-review plugin: not required (custom
review_prompt)` and verifies nothing about what the custom task actually needs.
A copied config naming an uninstalled plugin passes doctor green — which
CLAUDE.md names as the definition of doctor being wrong.

## 1. One step, two doors

A single step — choose the review task, optionally derive its tools, return
the choice — reachable two ways:

- **`docket prompt`**, a new subcommand, seeded with the current task. This is
  the door for anyone whose setup is already done, which is everyone whose
  prompt is worth tuning.
- **Native wizard step 4**, before the config write. Existing steps shift:
  writing config becomes 5, checking the setup becomes 6.

The step never writes a config. It returns a result that names what the user
chose — "default" is an answer, not an omission:

```ts
type StepResult =
  | { task: "default" }
  | { task: "custom"; review_prompt: string; extra_allowed_tools?: string[] }
  | "aborted";
```

A plain `{ review_prompt?: string }` fragment could not express the one thing
`docket prompt` exists to do for someone with a custom task: clear it —
merging an omitted key changes nothing, so picking the default would silently
keep the custom task. Each door interprets the result instead:

- The wizard, on `"default"`, writes neither key — an omitted key beats a key
  restating the default, the rule it already follows. On `"custom"` it folds
  both keys into the object it is building and keeps its single write.
- `docket prompt`, on `"default"`, deletes `review_prompt` from the loaded
  config; on `"custom"` it sets it. `extra_allowed_tools` is never deleted on
  either path — hand-tuned entries are the user's (see §2).

`docket prompt` loads config through `resolveConfig`, not `withCtx`: it never
talks to GitHub, so a `gh_account` whose token has gone stale must not block
editing the task (doctor already bypasses `withCtx` for the same reason).
Running it with no config offers the wizard as usual — and since the task step
now lives inside the wizard, the command ends there rather than asking the
same question twice. `resolveConfig` grows a flag saying a wizard ran.

## 2. What the user sees

Rendered in the wizard's existing idiom (`ui.step` prints `4. Review task`,
options are numbered lists) — the sketch below is illustrative, not a layout
to chase:

```
4. Review task

   1) default — run /code-review on the PR
   2) custom  — write your own

> 2
  (opens $EDITOR)

  Review task:
    Review the PR by running /code-review {number}, then run the
    blast-radius skill for an advisory impact assessment.

  docket can't tell which tools that needs — a headless review can't
  ask, so anything unlisted is denied mid-run.

  Ask claude to work it out? It reads the skills your prompt names.  [Y/n]

> y
  asking claude… (8s)

  Proposed extra_allowed_tools:
    + Skill(dev-skills:blast-radius)
    + Bash(node:*)
    + Bash(git merge-base:*)

  [a] accept  [e] edit the list  [s] skip — start with none

> a
```

**Capturing the task.** A multi-sentence prompt does not fit a readline line,
so the custom path opens `$EDITOR` on a temp file seeded with the current task
(the default, in the wizard) under a `#` header stripped on save — the
git-commit convention:

```
# The review task docket hands to claude for each PR.
# {number} and {repo} are substituted. Lines starting with # are ignored.
#
# Two things wrap this and are not configurable: the run happens in a git
# worktree, and it ends with a json block {headline, issues, risk}.

Review the PR by running /code-review {number}.
```

With `$EDITOR` unset, entry falls back to reading lines until a blank one. An
empty result (editor quit without saving, or nothing typed) keeps the previous
task and writes nothing.

Two mechanics the implementation must not skip: `$EDITOR` is a shell-ish value
(`code --wait` is common), so it is word-split, not exec'd as one token; and
the wizard's readline holds stdin through an async iterator
(`src/wizard/flow.ts:111`), so it is paused around the editor, which inherits
the terminal.

**Merge, never replace.** The union of derived entries with whatever
`extra_allowed_tools` already holds happens inside the step (`mergeTools`,
seeded from the config the step was given), so both doors inherit it — a
wizard run over an existing config (placeholders, or a confirmed overwrite)
must not let a spread replace hand-set extras. Only what is new is shown.
Hand-tuned entries survive, the same guarantee the wizard gives keys it does
not own (`src/wizard/flow.ts:454`).

**Declining is a supported answer.** `n` at the offer, or `[s]` at the
proposal, proceeds and says where the fallout lands: the `⊘` chip, the `D`
view, `a` to append. The denials loop is the backstop; this step is a head
start on it, never a precondition. Nothing downstream requires the allowlist
to be right.

**No claude → no offer.** The check is whether `claudeBin(cfg)` resolves, not
PATH literally — `CLAUDE_BIN` and `claude_bin` can point anywhere. The task is
still written; doctor already fails on the missing binary.

## 3. The derivation call

Mirrors the review invocation (`src/reviewer.ts:309`), read-only and small:

```ts
Bun.spawn([
  claudeBin(cfg), "-p", derivationPrompt(task),
  "--output-format", "text",
  "--permission-mode", "dontAsk",
  "--allowedTools", "Read,Grep,Glob",
], { env: claudeEnv(cfg) })
```

Going through `claudeBin`/`claudeEnv` is load-bearing: `claude_config_dir` is
where the plugins live, so a pinned config dir would otherwise have the deriver
reading an empty plugin tree. The call is capped at **90 seconds**; a timeout,
a non-zero exit, or an unparseable answer all degrade to the same thing — a
one-line "couldn't work it out", the task written, no entries added.

**What it is asked.** The task text, the baseline allowlist for contrast, and
the instruction that carries the whole idea:

> If the task names a slash command or skill, locate it and read it — the
> tools it needs are in the file, not in the task text. Look under
> `<claude config dir>/plugins`, `~/.claude/skills`, and `.claude/skills` in
> the clone paths listed below. Every entry must be traceable to something you
> read; do not guess broadly.

The prompt lists the configured clone paths (`cfg.repos`) so a project skill
is findable, not just plugins — §4's doctor already treats bare `Skill(foo)`
as a personal or project skill, and the deriver has to be able to trace the
same things doctor tolerates.

It answers with a fenced `json` block, `{"tools": [...], "notes": "..."}` — the
convention `src/summary.ts` already parses out of review runs. `notes` is
displayed with the proposal and not stored.

**The posting-tool blocklist is a tripwire, not a guarantee.** The baseline is
deliberately read-only and never posts to GitHub (`src/config.ts:53`), and no
entry-level check can promise that survives: allowlist entries are prefix
patterns, so the flags a run uses are not in the entry text — `Bash(gh api:*)`
contains no `-X` yet allows POSTs, and `gh api` posts on a bare `-f`/`-F`
anyway. What docket can do is catch the obvious cases: derived entries
matching a small blocklist — `gh pr comment`, `gh pr review`, `gh pr create`,
`gh pr merge`, `gh api` with an embedded `-X`/`--method` — are removed before
the proposal is shown, with a line saying how many and why. The real gate is
the user reading the proposal before `[a]`, and the proposal screen says so.
`docs/configuration.md` already says adding posting tools gives the read-only
guarantee up knowingly; knowingly means by hand, and the deriver's only
obligation is to never be the thing that gives it up silently.

## 4. Doctor verifies what the task names

Generalize the existing plugin check rather than adding a config key. Every
`extra_allowed_tools` entry of the form `Skill(plugin:name)` names a plugin
that must be installed, and doctor already knows how to look one up
(`src/doctor.ts:190` reads `installed_plugins.json` and matches
`k.startsWith("code-review@")`).

- For each `Skill(a:b)` entry, confirm a registry key starting with `a@`.
  Missing → fail, naming the plugin. docket cannot know which marketplace it
  came from, so the hint asks for it: `install the 'a' plugin: claude plugin
  install a@<marketplace>`.
- Bare `Skill(foo)` entries are skipped — a personal or project skill is not in
  the registry, and failing on it would be wrong.
- The existing `/code-review` check stands unchanged. The
  `code-review plugin: not required (custom review_prompt)` line stays, because
  it is still true; it is simply no longer the only thing doctor says about a
  custom task.

This is what makes a copied config self-verifying: install docket, paste a
config, run doctor, and a missing plugin is named rather than discovered three
reviews later.

## 5. Module layout

Following the existing pure/impure split (`src/wizard/core.ts` vs
`src/wizard/flow.ts`):

```
src/reviewtask.ts          pure, no I/O
  editorTemplate(current)          → seeded temp-file text
  stripEditorComments(text)        → the task, # lines gone
  derivationPrompt(task)           → what claude is asked
  parseDerivedTools(stdout)        → string[] | {error}
  dropPostingTools(tools)          → {kept, dropped}
  mergeTools(existing, derived)    → {merged, added}

src/wizard/reviewtask.ts   interactive
  runReviewTaskStep({ ui, cfg, editor?, derive? })
    → { task: "default" }
    | { task: "custom", review_prompt, extra_allowed_tools? }
    | "aborted"
```

`editor` and `derive` are injected the way `flow.ts` already injects
`getOrigin` and `runDoctor`, so the step is exercisable without an editor, a
subprocess, or a filesystem. The two failure modes are distinct in the
signature because §6 treats them differently: `derive` absent means claude is
unavailable (no offer is made); a `derive` that rejects is a derivation
failure (the offer was made, and it degrades). In the wizard, `cfg` is the
`existing` object read by `mayOverwrite` — nothing is written yet, so
`claude_bin`, `claude_config_dir` and `claude_env` can only come from there. `src/main.ts` gains the `docket prompt` command
and its `USAGE` line; `src/wizard/flow.ts` gains the step 4 call and the step
renumbering.

The claude-guided route gets the equivalent step in
`src/wizard/claude-prompt.md`: after the repos step, ask whether the user wants
the default task or a custom one, and — being a session with file access
already — read the skills a custom task names and propose the allowlist inline,
subject to the same no-posting-tools rule. Its step 4 instruction to leave
other keys out is amended to name `review_prompt` and `extra_allowed_tools` as
keys it may now write.

## 6. Errors

| Situation | Behaviour |
|---|---|
| `$EDITOR` unset | line-by-line entry, blank line ends it |
| editor exits non-zero, or file unchanged/empty | keep the current task, write nothing |
| `docket prompt`: default picked over a custom task on disk | `review_prompt` removed, `extra_allowed_tools` untouched |
| `claudeBin(cfg)` does not resolve | no derivation offer; task still written |
| derivation times out (90s), exits non-zero, or answers unparseably | one line, no entries, task still written |
| derivation proposes only posting tools | proposal shows empty plus the dropped count |
| stdin ends mid-step (ctrl-D, piped input) | step returns `"aborted"`; the wizard handles it as it handles any aborted step, `docket prompt` exits 1 without writing |

## 7. Docs

Per CLAUDE.md, an external-dependency change updates doctor and README in the
same change. This one touches both plus the config reference:

- **README** — Setup gains the review-task step; the `review_prompt` bullet
  points at `docket prompt` instead of implying hand-editing.
- **docs/configuration.md** — `review_prompt` and `extra_allowed_tools` each
  note that `docket prompt` sets them together.
- **src/doctor.ts** — §4, with tests.

## 8. Out of scope

- **A recipe file or URL** (`docket config apply <path|url>`). Attractive for
  distributing a team's task, but it is a new file format and a second way to
  write the same two keys. The step here is a prerequisite for it either way.
- **Shipped presets.** The tasks worth sharing depend on private plugins docket
  cannot know about.
- **A TUI affordance for editing the task.** `docket prompt` is reachable from
  the shell the queue can already drop you into, and the thin-TUI rule argues
  against another mode.
- **Changing what wraps the task.** Worktree hygiene and the json summary block
  stay fixed and system-owned, exactly as the 2026-07-24 design set them.

## Testing

Unit tests against `src/reviewtask.ts` — the pure seam:

- `parseDerivedTools` — a valid fenced block, prose with no block, malformed
  json, a `tools` array containing non-strings, a block that is not the last
  thing in the output.
- `mergeTools` — dedupe, order preserved, `added` reports only genuinely new
  entries, empty existing list.
- `stripEditorComments` — `#` lines removed, a `#` mid-line kept, an
  all-comments file yields empty.
- `dropPostingTools` — each blocklist form dropped, near-misses like
  `Bash(gh pr view:*)` kept.

Step tests against `runReviewTaskStep` with injected `ui`/`editor`/`derive`:
the default pick returns `{ task: "default" }`; custom + accept returns both
keys; declining the offer returns the task alone; an absent `derive` makes no
offer; a failing `derive` degrades to the task alone; merging preserves
hand-set entries — through both doors, since the union lives in the step.

`docket prompt` tests: picking the default with a custom task on disk removes
`review_prompt` and leaves `extra_allowed_tools`; a stale `gh_account` does
not block the command; with no config, the wizard runs and the step is not
asked a second time.

Doctor tests for §4: a `Skill(a:b)` entry with the plugin installed passes,
without it fails, a bare `Skill(foo)` entry is skipped.

Nothing here is TUI, so the thin-TUI rule does not apply. `bun test` stays
fully mocked — the derivation subprocess is injected, never spawned in tests.
