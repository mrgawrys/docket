# `reviews doctor` — setup preflight

**Date:** 2026-07-21
**Status:** Approved design

## Problem

A fresh user's first review run can fail for reasons the tool never checks:
the code-review plugin isn't installed in their `claude`, `claude` isn't set
up, `gh` isn't authenticated, or a mapped clone path is wrong. Today the only
signal is a `FAILED … see auto-review.log` entry after a review has already
been attempted (and billed). Nothing in `install.sh` or the README verifies
the piece that most recently broke in practice: that headless `claude` can
actually run `/code-review`.

## Goal

A stranger's first run either works or tells them exactly what to fix,
without adding poller machinery. One diagnostic command, referenced from the
README, install script, and failure messages.

## Design

### 1. `reviews doctor` command

New `src/doctor.ts`, wired as `commands["doctor"]` in `main.ts` and added to
`USAGE`.

Doctor does **not** use `withCtx`: `withCtx` hard-exits on a missing config
or an unresolvable `gh_account` token — exactly the conditions doctor must
report gracefully. It walks the dependency chain itself, prints one `✓`/`✗`
line per check with a fix hint under each failure, and exits 1 if any check
failed. No lock (read-only, safe to run any time).

Checks, in dependency order:

1. **Config** — `~/.config/auto-review/config.json` exists, parses, has
   `orgs`/`repos`. Reuses `loadConfig`; a `ConfigError` message is the hint.
   All later checks that need config are skipped (reported as skipped) if
   this fails.
2. **Repo clones** — each `repos` value exists and is a git repo
   (`git -C <path> rev-parse --git-dir`).
3. **gh** — binary runs (`gh --version`); `gh auth status` exits 0.
4. **gh account pin** — only when `gh_account` is set:
   `gh auth token --user <account>` resolves a token (the same call
   `withCtx` makes at startup).
5. **claude** — `claudeBin(cfg)` runs `--version`, with `CLAUDE_CONFIG_DIR`
   applied when `claude_config_dir` is set.
6. **code-review plugin** — `installed_plugins.json` under the claude config
   dir (`claude_config_dir`, else `~/.claude`) contains a key starting with
   `code-review@`. Fix hint:
   `claude plugin install code-review@claude-plugins-official`.

Non-goal: verifying `claude` is logged in. There is no cheap check that
doesn't spend tokens; an auth failure surfaces in the run log, which now
points at doctor.

### 2. Wiring

- `install.sh`: closing message becomes "edit the config, then run
  `reviews doctor`". It must **not** run doctor itself — the freshly seeded
  config always fails the config check.
- `src/reviewer.ts`: the `FAILED` log line and notification gain
  "…or check your setup: `reviews doctor`".

### 3. README

- **Requirements** gains the code-review plugin as an explicit prerequisite,
  with the install one-liner.
- **Setup** gets a new step between "edit config" and "dry-run":
  "`reviews doctor` — every line should be ✓."

### 4. CLAUDE.md

New repo `CLAUDE.md` with a maintenance rule: any change that adds or
removes an external dependency of the review pipeline (a binary, a claude
plugin/skill, an allowlisted command, a config key) must update `reviews
doctor` and the README in the same change.

## Testing

Follows the existing fully-mocked pattern (`tests/harness.ts`): `gh` and
`claude` invocations already route through `GH_BIN`/`CLAUDE_BIN` env
overrides, so tests point them at stub scripts. The plugin check reads a
path derived from config/`HOME`, testable with temp dirs. Cover: all-green,
each failure mode's message + hint + exit code, and the skip cascade when
config is missing.

## Deferred (deliberately)

- `extra_allowed_tools` config key (allowlist drift escape hatch) — revisit
  when there are external users.
- Poll-time preflight before each review — same.

## Related state

The `ALLOWED_TOOLS` expansion (gh api user / gh search / gh issue view /
gh issue list / git blame) was applied directly in the main working copy on
2026-07-21 and is uncommitted there; it should be committed before this
branch merges (both touch `src/reviewer.ts`).
