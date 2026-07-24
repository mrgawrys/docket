# Configurable review prompt

## Problem

The instruction handed to `claude -p` for every PR is hardcoded in
`reviewPrompt()` (`src/reviewer.ts`). It always runs `/code-review <number>`.
Two things are tangled together in that one string:

- **Worktree hygiene** — create `.worktrees/pr-N`, do all inspection there,
  never touch the main working copy, keep the worktree afterwards. This is a
  contract with `cleanupEntry`, which owns removing that worktree.
- **The review task itself** — "run `/code-review <number>`".

Only the second is a personal choice. To share auto-review with people who
want a different review flow, the task must be configurable while the worktree
hygiene stays fixed and system-owned.

## Design

`reviewPrompt(number, note)` composes four parts:

```
[ FIXED preamble  ] worktree setup — create, fetch, inspect only inside it,
                    never modify the main working copy
[ CONFIG body     ] cfg.review_prompt, with {tokens} substituted
                    default: "Review the PR by running /code-review {number}."
[ FIXED suffix    ] "Keep the worktree in place afterwards so follow-up
                    questions can use it."
[ note (optional) ] "Additional context from the reviewer: <note>"
```

"Keep the worktree in place" **moves out of the configurable body into the
fixed suffix**. Rationale: the worktree lifecycle is a contract with
`cleanupEntry`; a custom prompt must not be able to drop that line and leave
orphaned worktrees the system believes it owns.

### Tokens

The config body supports substitution of:

- `{number}` — the PR number (e.g. `42`)
- `{repo}` — `org/repo` (e.g. `Recruitee/api`)
- `{worktree}` — the worktree path (e.g. `.worktrees/pr-42`)

Substitution is a literal `replaceAll` per token. A prompt with no tokens is
used verbatim — the fixed preamble has already established "PR #42, worktree
checked out on its branch," so `"review this PR carefully"` works on its own.

### Config

Add `review_prompt?: string` to the `Config` interface (`src/config.ts`).

- **Absent → the current default** (`Review the PR by running
  /code-review {number}.`). Existing installs, including the maintainer's,
  behave identically with no config edit. Backward-compatible by construction.
- Present and non-empty → used as the config body.
- Present but empty string → treat as invalid; `loadConfig` is not the place
  to enforce it (it only validates `orgs`/`repos` today), so `reviewPrompt`
  falls back to the default and `doctor` reports it (see below).

The default string lives in **one** exported constant in `reviewer.ts`
(`DEFAULT_REVIEW_PROMPT`) so `config.ts`, the example, doctor, and tests all
reference the same source of truth.

### Doctor

Today `doctor` unconditionally requires the `code-review` plugin. Once the
prompt is configurable, the plugin is only needed when the effective prompt
references `/code-review`. Change the check to:

- Compute the effective body: `cfg.review_prompt ?? DEFAULT_REVIEW_PROMPT`.
- If it contains `/code-review` → require the plugin exactly as today
  (pass/fail with the same install hint).
- If it does not → skip the plugin requirement; emit an informational line
  noting the custom prompt so the check reads honestly
  (e.g. `code-review plugin: not required (custom review_prompt)`).
- If `review_prompt` is present but empty/whitespace → `fail` with a hint to
  remove the key or give it a value; the default is what runs meanwhile.

This preserves doctor's invariant: **doctor passes ⟺ a fresh install of this
exact config works.**

### Example config + README

- `config.example.json` sets `review_prompt` to the `/code-review {number}`
  default, so the example is literally what the maintainer runs.
- README documents the key under Setup: the three tokens, that omitting it
  keeps the `/code-review` default, and that a prompt without `/code-review`
  does not require the plugin.

## Out of scope

- Per-repo prompts. One global `review_prompt` for now.
- `ALLOWED_TOOLS` changes. The tool allowlist stays fixed; a custom prompt
  runs under the same read-only, no-GitHub-write sandbox. (Noted so it is a
  conscious decision, not an oversight.)

## Testing

- `reviewPrompt`: default (no config), custom with `{number}`, custom with no
  token, custom with `{repo}`/`{worktree}`, and each of those with a note.
- Empty `review_prompt` falls back to the default.
- `doctor`: plugin required + present, plugin required + missing, custom
  prompt without `/code-review` (plugin not required), empty prompt fails.
- Tests stay fully mocked — no network, no tokens (per CLAUDE.md).
