# Review Task Setup Implementation Plan

> **To execute this plan:** use the `executing-plans` skill. It reviews the plan,
> then asks how you want it built — review at the end (delegated: one subagent
> builds it all, an independent review at the end), or review each task
> (inline: a diff per task for you to approve).

**Goal:** A single setup step — choose the review task, optionally derive its
`extra_allowed_tools` with a claude call — reachable as wizard step 4 and as a
new `docket prompt` command, plus a doctor check that verifies plugins named by
`Skill(a:b)` entries.

**Architecture:** Pure logic in `src/reviewtask.ts` (template, parsing,
blocklist, merge), interactive step in `src/wizard/reviewtask.ts` with injected
`editor`/`derive` (the pure/impure split `src/wizard/core.ts` vs
`src/wizard/flow.ts` already uses). The step returns a tri-state result; the
wizard folds it into its single config write, `docket prompt` applies it to the
loaded config via `writeConfigText`. Spec:
`docs/specs/2026-08-14-review-task-setup-design.md`.

**Tech Stack:** Bun, TypeScript, `bun test` (mocked — no network, no
subprocesses in tests).

## Global Constraints

- `bun test` stays fully mocked: the derivation subprocess and `$EDITOR` are
  injected in every test, never spawned (CLAUDE.md).
- Tests go in `test/<module>.test.ts`, one file per module, matching the
  existing flat layout; interactive flows are driven through injected
  input/output streams as `test/wizard-flow.test.ts` does.
- The derivation call is capped at **90 seconds**; timeout, non-zero exit, and
  unparseable output all degrade identically: one line ("couldn't work it
  out"), the task still written, no entries added.
- Posting-tool blocklist is a tripwire, not a guarantee (spec §3). Exact list:
  entries containing `gh pr comment`, `gh pr review`, `gh pr create`,
  `gh pr merge`, or `gh api` together with an embedded `-X` or `--method`.
  Nothing else is dropped.
- `extra_allowed_tools` is never deleted by any path; hand-set entries always
  survive (spec §2 "Merge, never replace").
- No TUI work anywhere in this plan; nothing under `src/tui/` changes.
- Every task ends with a commit on `feat/review-task-setup`.

---

### Task 1: Pure module `src/reviewtask.ts`

**Units:** `src/reviewtask.ts` — everything about the review-task step that
needs no I/O: the editor seed text, comment stripping, the derivation prompt,
output parsing, the posting-tool tripwire, and the allowlist union.
`test/reviewtask.test.ts`.

**Interacts:** consumed only by `src/wizard/reviewtask.ts` (Task 2) and its
tests. Imports `ALLOWED_TOOLS` and `DEFAULT_REVIEW_PROMPT` from
`src/config.ts`; imports nothing else.

**Signatures** (later tasks depend on these verbatim):

```ts
export type StepResult =
  | { task: "default" }
  | { task: "custom"; review_prompt: string; extra_allowed_tools?: string[] }
  | "aborted";

export function editorTemplate(current: string): string;
export function stripEditorComments(text: string): string;
export function derivationPrompt(
  task: string,
  clonePaths: string[],
  pluginsDir: string,
): string;
export function parseDerivedTools(
  stdout: string,
): { tools: string[]; notes?: string } | { error: string };
export function dropPostingTools(tools: string[]): {
  kept: string[];
  dropped: string[];
};
export function mergeTools(
  existing: string[],
  derived: string[],
): { merged: string[]; added: string[] };
```

**Constraints:**

- `editorTemplate` produces exactly the spec §2 seed — `#` header lines, blank
  line, then `current`:

  ```
  # The review task docket hands to claude for each PR.
  # {number} and {repo} are substituted. Lines starting with # are ignored.
  #
  # Two things wrap this and are not configurable: the run happens in a git
  # worktree, and it ends with a json block {headline, issues, risk}.

  <current>
  ```

- `stripEditorComments` removes only lines *starting* with `#` (the git-commit
  convention); a `#` mid-line stays. Result is trimmed; an all-comments file
  yields `""`.
- `derivationPrompt` contains: the task text, `ALLOWED_TOOLS` as the baseline
  for contrast, the clone paths, and the spec §3 instruction — locate any
  named slash command or skill under `<claude config dir>/plugins`,
  `~/.claude/skills`, and `.claude/skills` in the listed clones; every entry
  must be traceable to something read, no broad guessing; answer with a fenced
  `json` block `{"tools": [...], "notes": "..."}`.
- `parseDerivedTools` reuses the trailing-fenced-block convention: the block
  must be the **last** thing in the output (a lazy leading group starts at the
  first fence and swallows the message — see the `TRAILING_BLOCK` comment,
  `src/summary.ts:19`). Non-object json, missing `tools`, or non-string array
  members → `{ error }`. `notes` passes through only when it's a string.
- `dropPostingTools` matches the exact blocklist from Global Constraints by
  substring on each entry; `gh api` is dropped only when the same entry also
  embeds `-X` or `--method`. `Bash(gh pr view:*)` and `Bash(gh api user:*)`
  must survive.
- `mergeTools` dedupes exactly (string equality), preserves order (existing
  first, then new derived), and `added` lists only entries not already in
  `existing`.

**Seams:** each exported function, driven directly.

**Done when:** tests cover the spec's Testing bullets — `parseDerivedTools`
(valid block, prose with no block, malformed json, non-string members, block
not last), `mergeTools` (dedupe, order, `added` only genuinely new, empty
existing), `stripEditorComments` (`#` lines removed, mid-line `#` kept,
all-comments → empty), `dropPostingTools` (each blocklist form dropped,
near-misses kept). `bun test` green. Commit.

---

### Task 2: Interactive step `src/wizard/reviewtask.ts`

**Units:**
- `src/wizard/reviewtask.ts` — `runReviewTaskStep` (the dialogue: choose
  default/custom, editor entry, the derivation offer/proposal), plus the real
  `editor` and `derive` implementations used outside tests.
- `src/wizard/flow.ts` — export the `Ui` interface and `makeUi`; `Ui` gains
  `suspend<T>(fn: () => T): T` (pauses readline around a child that inherits
  the terminal, then resumes).
- `test/wizard-reviewtask.test.ts`.

**Interacts:** called by `src/wizard/flow.ts` (Task 3) and `docket prompt`
(Task 4), both passing a real `Ui` and the real `editor`/`derive`; tests pass
fakes. The real `derive` goes through `claudeBin(cfg)`/`claudeEnv(cfg)` from
`src/config.ts` — load-bearing, `claude_config_dir` is where plugins live.

**Signatures:**

```ts
export interface ReviewTaskOptions {
  ui: Ui;
  cfg: Config;              // wizard passes mayOverwrite's `existing` cast down
  // opens $EDITOR on `seed`, returns the saved text; null = editor failed,
  // file unchanged, or result empty. undefined field = $EDITOR unset →
  // line-by-line entry via ui.ask, blank line ends it.
  editor?: (seed: string) => string | null;
  // resolves to claude's stdout; rejects on timeout/non-zero exit.
  // undefined field = claude unavailable → the derivation offer is never made.
  derive?: (prompt: string) => Promise<string>;
}
export function runReviewTaskStep(o: ReviewTaskOptions): Promise<StepResult>;

// the real implementations, wired up by flow.ts / main.ts:
export function makeEditor(ui: Ui, env: NodeJS.ProcessEnv): ((seed: string) => string | null) | undefined;
export function makeDerive(cfg: Config): ((prompt: string) => Promise<string>) | undefined;
```

**Constraints:**

- Dialogue order (spec §2): `1) default / 2) custom` → editor → show the
  can't-tell-which-tools line → `Ask claude to work it out? [Y/n]` → spinner
  line → proposal with `+` per new entry → `[a] accept [e] edit [s] skip`.
  Rendered in the wizard's idiom (`ui.step(4, "Review task")`, numbered
  lists) — the spec's sketch is illustrative, don't chase its layout.
- The union happens **inside the step**: `mergeTools(cfg.extra_allowed_tools
  ?? [], kept)` — read `cfg.extra_allowed_tools` defensively (only if it's an
  array of strings; `cfg` can be whatever was on disk). The proposal shows
  only `added`; the returned `extra_allowed_tools` is the full `merged` list.
- Accepting with nothing derived, declining the offer, or `[s]` → result
  `{ task: "custom", review_prompt }` with `extra_allowed_tools` **omitted**
  (never an empty array — an omitted key must not clobber existing extras).
  Declining also prints where the fallout lands: the `⊘` chip, the `D` view,
  `a` to append (spec §2 "Declining is a supported answer").
- `[e]` re-prompts with the proposed list as an editable comma-separated line;
  the edited list replaces `kept` and still goes through `mergeTools`.
- All-posting-tools proposal: show the empty proposal plus the dropped count
  (spec §6).
- Empty editor result / unchanged file → keep the current task: seeded with
  the default (wizard) that means `{ task: "default" }`; seeded with a custom
  task (`docket prompt`) it means `{ task: "custom", review_prompt: current }`
  with no derivation re-offer.
- The default pick asks nothing further — no editor, no derivation offer.
- `InputEnded` from `ui.ask` (stdin closed) is caught inside the step →
  returns `"aborted"`. It must not leak: the wizard maps it to its aborted
  outcome, `docket prompt` to exit 1.
- `makeEditor`: `undefined` when `env.EDITOR` is unset/blank; otherwise
  word-splits `$EDITOR` (`"code --wait"` is two argv entries), spawns with
  `stdio: "inherit"` inside `ui.suspend`, on a temp file under the scratch of
  `os.tmpdir()`. Non-zero exit or unchanged content → `null`.
- `makeDerive`: `undefined` when `Bun.which(claudeBin(cfg))` is null (the
  check is `claudeBin(cfg)`, not PATH literally — `CLAUDE_BIN`/`claude_bin`
  can point anywhere). Otherwise spawns exactly the spec §3 invocation
  (`-p <prompt> --output-format text --permission-mode dontAsk
  --allowedTools Read,Grep,Glob`, env `claudeEnv(cfg)`), kills at 90s,
  rejects on timeout or non-zero exit.

**Seams:** `runReviewTaskStep` with injected `ui` (piped streams, the
`wizard-flow.test.ts` idiom), `editor`, `derive`. `makeEditor`/`makeDerive`
are not unit-tested (subprocess wrappers; doctor and use cover them).

**Done when:** step tests pass — default pick returns `{ task: "default" }`;
custom + accept returns both keys with the union applied; declining the offer
and `[s]` return the task alone (no `extra_allowed_tools` key); absent
`derive` → the offer is never printed; rejecting `derive` → one degraded line,
task alone; merging preserves hand-set entries; stdin close mid-step →
`"aborted"`. `bun test` green. Commit.

---

### Task 3: Wizard integration (native flow + claude-guided prompt)

**Units:**
- `src/wizard/flow.ts` — the step-4 call between `chooseRepos` and
  `writeConfig`; renumbering (`writeConfig` prints step 5, doctor step 6);
  `writeConfig` gains the step result and folds it in.
- `src/wizard/claude-prompt.md` — the equivalent step for the claude-guided
  route.
- `test/wizard-flow.test.ts` — extended.

**Interacts:** `runNativeWizard` builds `editor`/`derive` via
`makeEditor`/`makeDerive` (Task 2), passing `existing` as the step's `cfg`
(nothing is written yet, so `claude_bin`/`claude_config_dir`/`claude_env` can
only come from there). `WizardOptions` gains optional `reviewTask?: (o:
ReviewTaskOptions) => Promise<StepResult>` injected like `getOrigin`/
`runDoctor`, so flow tests don't drive the step's internals.

**Signatures:**

```ts
// flow.ts, changed:
function writeConfig(
  ui: Ui, p: Paths,
  existing: Record<string, unknown> | undefined,
  orgs: string[], repos: Record<string, string>,
  login: string, account: string | undefined,
  task: Exclude<StepResult, "aborted">,
): boolean;
```

**Constraints:**

- On `{ task: "default" }` the wizard writes **neither** key — an omitted key
  beats a key restating the default. On `"custom"` it sets `review_prompt`
  and, only when present, `extra_allowed_tools` (already merged by the step).
- `"aborted"` from the step → the wizard returns its `"aborted"` outcome with
  the existing "input ended — nothing was written." message path.
- `claude-prompt.md`: insert the review-task step after Step 3 (repos), so
  Write becomes Step 5 and Verify Step 6. It asks default vs custom; for a
  custom task the session reads the named skills itself (it has file access)
  and proposes the allowlist inline, under the same tripwire framing — never
  propose posting tools; the user's explicit ask is the only way those get in.
  Amend the "Leave out `poll_interval_minutes`, ... and everything else" line
  (`src/wizard/claude-prompt.md:133`): `review_prompt` and
  `extra_allowed_tools` are now keys it may write when the user chose them.
- No behavior change for a user who picks the default: same number of
  questions as today plus one.

**Seams:** `runNativeWizard` with injected `reviewTask` (flow-level: the step
result lands in the written config) — the step's own dialogue is Task 2's
tests, not re-tested here.

**Done when:** flow tests show — default step result writes neither key;
custom result writes both; existing `extra_allowed_tools` in a placeholder
config survives a wizard run (the merged list contains them); aborted step →
aborted wizard, nothing written; step/doctor headings renumbered. Prose check
for `claude-prompt.md`: read it back against the constraint bullet — no tests
(it's a prompt, asserting on its text counterfeits falsifiability). `bun test`
green. Commit.

---

### Task 4: `docket prompt` command

**Units:**
- `src/wizard/trigger.ts` — `Resolved` grows the wizard-ran flag.
- `src/main.ts` — `prompt` command + `USAGE` line.
- `test/wizard-trigger.test.ts`, `test/main.test.ts` — extended.

**Interacts:** `prompt` calls `resolveConfig` **directly, not `withCtx`** — it
never talks to GitHub, so a `gh_account` whose token has gone stale must not
block it (`doctor` at `src/main.ts:288` is the precedent). It then runs
`runReviewTaskStep` with a `Ui` from `makeUi` (exported in Task 2) and the
real `makeEditor`/`makeDerive`, and writes with `writeConfigText` — the one
config-write path, which preserves file mode and symlinks.

**Signatures:**

```ts
// trigger.ts, changed:
export type Resolved =
  | { cfg: Config; wizardRan?: boolean }   // true only on the offer-wizard path
  | { code: number };
```

**Constraints:**

- `wizardRan: true` is set exactly when `resolveConfig` took the
  `offer-wizard` branch and the recursive call produced a config. Existing
  callers (`withCtx`) ignore the flag — no behavior change for them.
- `prompt` on `wizardRan` exits 0 immediately: the task step already happened
  inside the wizard; asking twice is the bug this flag exists to prevent.
- The step is seeded with `effectiveReviewPrompt(cfg)` as the current task.
- Applying the result: `"default"` → `delete cfg.review_prompt`; `"custom"` →
  set `review_prompt`, and set `extra_allowed_tools` only when the result
  carries it. `extra_allowed_tools` is never deleted. `"aborted"` → exit 1,
  nothing written.
- Write: `writeConfigText(p.configPath, JSON.stringify(cfg, null, 2) + "\n")`
  — the wizard's exact serialization. Skip the write entirely when applying
  the result changed nothing (the returned task equals the effective one and
  no extras were added) — spec §6: "keep the current task, write nothing".
- Non-interactive stdin (`!isTTY`) still works the way the wizard's does:
  piped answers drive it; a closed stdin aborts (exit 1).
- `USAGE` gains: `docket prompt            set the review task (and the tools it needs)`.

**Seams:** `resolveConfig` with injected deps for the flag; the command body
factored so tests drive it with injected step/paths (piped-stream idiom)
rather than through `Bun.argv`.

**Done when:** tests show — picking the default with a custom task on disk
removes `review_prompt` and leaves `extra_allowed_tools` untouched; custom
sets both; `gh_account` present but unresolvable does not block the command;
`resolveConfig` reports `wizardRan` on the offer path and the command then
does not run the step; aborted → exit 1, config file byte-identical. `bun
test` green. Commit.

---

### Task 5: Doctor verifies `Skill(plugin:name)` entries

**Units:** `src/doctor.ts` — generalize the plugin-registry check;
`test/doctor.test.ts` — extended.

**Interacts:** reads the same registry the existing check reads
(`installed_plugins.json` under `cfg.claude_config_dir ||
join(HOME, ".claude")` — keep the `||`-not-`??` comment's reasoning, the
seeded config carries `claude_config_dir: ""`). Read the registry once and
share it between the existing `/code-review` check and the new per-entry
checks.

**Constraints:**

- For each `extra_allowed_tools` entry matching exactly `Skill(a:b)` (one
  colon, non-empty halves): pass when a registry key starts with `a@`, else
  fail naming the plugin with hint
  `install the 'a' plugin: claude plugin install a@<marketplace>` — docket
  cannot know the marketplace, so the hint says so.
- Bare `Skill(foo)` entries are skipped silently — personal/project skills
  aren't in the registry, and failing on them would be wrong.
- Non-`Skill` entries are untouched; the existing `/code-review` check and its
  `not required (custom review_prompt)` line stand unchanged.

**Seams:** `doctorCommand` through the existing doctor test harness (mocked
filesystem/registry, whatever `test/doctor.test.ts` already does).

**Done when:** tests show — `Skill(a:b)` with `a@…` in the registry passes;
without it fails naming `a` and the hint; bare `Skill(foo)` produces no line;
a config with no extras behaves exactly as today. `bun test` green. Commit.

---

### Task 6: Docs

**Units:** `README.md`, `docs/configuration.md`.

**Interacts:** documents Tasks 2–5. Per CLAUDE.md, dependency-shaped changes
update doctor and README together — doctor changed in Task 5, README here, one
branch.

**Constraints:**

- README Setup gains the review-task step (wizard step 4 and
  `docket prompt`); the `review_prompt` bullet points at `docket prompt`
  instead of implying hand-editing.
- `docs/configuration.md`: `review_prompt` and `extra_allowed_tools` each note
  that `docket prompt` sets them together; the existing posting-tools
  paragraph keeps its "knowingly means by hand" meaning — the deriver never
  adds posting tools silently, and the blocklist is described as best-effort,
  not a guarantee.
- No new config keys exist, so `configProblem` and the config reference's key
  list don't change.

**Seams:** none — prose.

**Done when:** read back against the spec's §7 bullets; `docket doctor` and a
fresh-install reading of README agree about what a working setup needs. Commit.
