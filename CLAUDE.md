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
