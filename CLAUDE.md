# auto-review

Pre-runs Claude Code's `/code-review` on PRs awaiting the user's review.
See README.md for architecture; `bun test` is fully mocked (no network, no
tokens) — keep it that way.

## Dependency changes must update doctor + README

`reviews doctor` (src/doctor.ts) is the contract for what a working setup
looks like. Any change that adds, removes, or alters an external dependency
of the review pipeline — a required binary, a claude plugin or skill, an
entry in `ALLOWED_TOOLS`, a config key — must in the same change:

- update the checks in `src/doctor.ts` (with tests), and
- update README.md (Requirements and/or Setup).

If doctor can pass while a fresh install still fails, doctor is wrong.

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
