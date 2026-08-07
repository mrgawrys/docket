# First-run wizard & permission-denial surfacing — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (delegated, reviewed
> per task), or *plan first* (`writing-plans`, then how it gets built).
> Unattended end-to-end is `/autopilot`. Ask the user which; don't pick for
> them.

> **Validation gate:** the wizard half of this spec is approved only after
> throwaway prototypes (see [Prototype plan](#prototype-plan)) settle the
> claude-wizard vs native-wizard fork. Do not build the wizard for real before
> the user has test-driven both prototypes and picked a variant.

Two features, one theme: the config's lifecycle. The wizard creates the config;
denial surfacing tells the user how to evolve it. Today both ends are dead
ends — first run seeds a placeholder file and exits, and a review that hits 49
permission denials (PR #6520's real count: 38 true denials among 44 tool
errors) leaves no trace outside the raw run log.

## 1. First-run wizard

### Trigger

Any docket command that finds no config **and** runs on a TTY starts the
wizard. Headless contexts (the launchd poller, pipes) keep today's behavior:
seed `config.example.json`, log the error. Cron never blocks on a prompt.

### Steps

1. **Account** — `gh auth status` lists logged-in accounts. One account: use
   it silently. Several: pick one; the choice becomes `gh_account`. This step
   runs first because org visibility depends on the account.
2. **Orgs** — `gh org list` under the chosen account, multi-select → `orgs`.
3. **Repos** — ask for a projects root (offer likely candidates such as
   `~/Development`, `~/Work`), scan it for git repos whose `origin` points at
   a chosen org, present the found `org/repo → path` mappings pre-checked →
   `repos`. Manual additions allowed; skipping is fine — unmapped repos
   already skip gracefully at review time.
4. **Finish** — write `config.json`, then run the doctor checks inline so the
   user ends on a ✓/✗ list.

### The open fork — settled by prototype, not on paper

- **Variant A — claude wizard.** docket launches `claude` with a wizard
  prompt (or skill) that does all four steps conversationally: runs `gh`
  itself, scans disk itself, writes the config itself. Near-zero docket code;
  handles odd setups (multiple roots, unusual remotes) for free. Costs tokens
  and startup latency on the very first impression.
- **Variant B — native wizard.** docket's own terminal prompts (plain or
  Ink). Instant and free; every edge case is code to write and maintain.

### Prototype plan

Both prototypes are throwaway code in the session scratchpad — never in this
repo, never touching the real `~/.config/docket` (both write to a sandbox
config dir).

- **A**: a wizard prompt file plus a one-line launcher that starts an
  interactive `claude` session with it.
- **B**: a single-file Bun script: `gh auth status` → account pick →
  `gh org list` → multi-select → clone scan → confirm → write config → doctor.

Judgment criteria: time to a working config, how each handles the
two-account/org-visibility wrinkle, how wrong output gets corrected, and how
the first run *feels*. The user test-drives both and picks; the pick amends
this spec.

## 2. Permission-denial surfacing

### Detection — `src/denials.ts`, a pure module

Parse a run's stream-json log after the run finishes (in `reviewer.ts`):

- Collect `tool_use` blocks (`id → name + input`).
- A denial is a `tool_result` with `is_error: true` whose text starts with
  `"Permission to use"`. In real logs this prefix cleanly separates denials
  from ordinary tool failures (exit codes, missing files).
- Join each denial to its `tool_use` via `tool_use_id`, then group:
  - **Bash**: derive the suggestion from the command's leading tokens,
    skipping a leading `cd <dir> &&` — e.g. `Bash(git fetch:*)`.
  - **Other tools**: the tool name — e.g. `WebFetch`.
- Output per group: the suggested `extra_allowed_tools` entry, the denial
  count, and a few example commands.

The summary is stored on the PR's state entry. The TUI reads state as it
already does; nothing parses run logs at render time.

### Surfacing — TUI

The reviewed PR's row shows a compact denial count. A key on the selected row
opens a denials panel: each group with its count, the exact config line it
would add, and example commands. Logic lives in the pure module; per the
repo's TUI rules, no layout tests.

### Apply

Selecting a suggestion appends it to `extra_allowed_tools` in `config.json`
(read, `JSON.parse`, push, rewrite with 2-space indent; key order survives).
Two rails:

- **Write-shaped patterns get no one-key apply.** A small deny-set —
  `gh pr comment`, `gh api` beyond the read-only paths, `git push`, `rm`, and
  kin — still shows in the panel, marked as conflicting with the read-only
  stance (`config.ts:44`), with "add manually or hand to claude" as the way
  forward. The stance must not erode one convenient keypress at a time.
- **Already configured but still denied.** If the suggested string is already
  in the config (the mid-pattern-`*` case), suggest no duplicate; label the
  group "rule exists but didn't match" and route it to the hand-off.

### Hand to claude

From the denials panel, a hand-off key on a group or the whole batch — for
what the mechanical path can't settle: write-shaped suggestions, rules that
exist but don't match, or plain confusion.

docket opens an **interactive** claude session through the existing opener
machinery (the same configurable chain the TUI verbs use, reported by
doctor), running `claude "<prompt>"` in the repo's clone. No headless
pre-run, no new state: the user is present when they press the key, and the
session researches while they watch.

The prompt carries:

- what docket is (two sentences) and its deliberate read-only stance,
- the denial groups with counts and example commands,
- the config path, current `extra_allowed_tools`, and the effective allowlist,
- the run log path for the affected PR,
- the standing order: **research only — investigate, explain, propose
  options, change nothing until the user decides.** The session runs in
  default permission mode, so an edit still hits a permission prompt the user
  answers themselves. Instruction *and* enforcement.

## Out of scope

- The review agent *choosing* to skip allowed work (the worktree-setup skip
  in the motivating conversation) — that is review-prompt engineering, not
  permissions.
- Aggregate denial reporting across runs, notifications, and doctor
  integration — the per-review panel plus hand-off covers the observed pain.

## Testing & docs

- `src/denials.ts` gets normal unit tests with fixture lines lifted from real
  run logs; `bun test` stays fully mocked.
- TUI: at most a thin test if a destructive-adjacent verb (apply) could wire
  to the wrong row; no layout assertions.
- README: Setup gains the wizard; a new section documents the denials panel.
  doctor: the wizard reuses its checks; the denial feature adds no external
  dependency, so no new doctor checks (per CLAUDE.md's doctor contract).
