# First-run wizard prototypes

Throwaway validation artifacts for
`docs/specs/2026-08-07-first-run-wizard-and-denial-surfacing-design.md` —
not product code, not tested, paths hardcoded to the author's machine.
Both write only to a `sandbox/` directory beside themselves and never touch
`~/.config/docket`.

- `claude-wizard/` — variant A: `launch.sh` starts an interactive `claude`
  session with `wizard-prompt.md` as the wizard.
- `native-wizard/` — variant B: `bun run wizard.ts`, plain terminal prompts.

Both were test-driven on 2026-08-08; the spec records the outcome and the
learnings.
