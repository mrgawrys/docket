# Demo sandbox & frame viewer — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it
> gets built). Ask the user which; don't pick for them.

## Goal

Two testing modes that share one fake world:

1. **Human**: after any UI change, launch the real TUI over rich mock data in
   one command and click around immediately — every screen reachable on
   demand, verbs actually working.
2. **AI QA**: verify UI changes without a human — a headless frame sweep for
   fast passes, tmux over the same sandbox for interactive ones.

The world is built from the shims the test suite already trusts, so the demo
can never drift into a second, lying mock layer. Nothing here ships in the
binary; it is all dev-only.

## Components

### `dev/sandbox.ts` — shared shims

The `gh`, `claude`, and `launchctl` bash shims move out of `tests/harness.ts`
into this module: exported shim sources plus a `materialize(dir)` helper that
writes them executable and returns the base env (`GH_BIN`, `CLAUDE_BIN`,
`LAUNCHCTL_BIN`, `DOCKET_CONFIG_DIR`, `DOCKET_STATE_DIR`, `DOCKET_NOTIFY=0`).
`tests/harness.ts` imports from here and keeps its capture-file machinery on
top. Shim knobs (`CLAUDE_FAIL`, `CLAUDE_EMIT_DENIAL`, `CLAUDE_LOGGED_OUT`,
`GH_*`) keep working unchanged for both consumers.

### `dev/scenarios.ts` — the scenario catalog

One exported record of named scenarios; fixtures are typed so a schema change
breaks the demo at compile time, not at render time:

```ts
interface Scenario {
  description: string;          // shown by --list / `frames all`
  config: Config;               // seeded config.json
  state: State;                 // seeded state.json
  env?: Record<string, string>; // shim knobs, e.g. CLAUDE_LOGGED_OUT=1
  hint?: string;                // "press D for the denials view"
  args?: string[];              // CLI args when not the bare queue
}
```

Initial catalog:

- `full` — mixed verdicts, summaries, a denial-chip row; also the state the
  README screenshot (`docs/assets/queue.png`) wants captured.
- `empty` — no pending entries.
- `denials` — an entry with rich denial groups: safe, write-shaped, and
  already-covered, so the `D` view shows all three kinds.
- `failed` — a failed run with denials and no session (`enter` hands to
  claude; panel says so).
- `running` — a review in flight. The launcher spawns a throwaway `sleep`
  and writes its real pid into the entry so `pidAlive` holds; `K` genuinely
  kills it. Launcher-only — `frames` renders this entry as best it can but
  owns no process.
- `auth-warning` — `CLAUDE_LOGGED_OUT=1`, footer warning visible.
- `wizard` — placeholder config so the first-run offer triggers; shims answer
  `gh org list` and the repo scan. Interactive-only (real stdin prompts, not
  Ink input): exercised via the launcher or tmux, never `frames`.

### `dev/demo.ts` — interactive launcher (`bun run demo`)

- `bun run demo <scenario>` (default `full`): fresh scratch dir, materialized
  sandbox, seeded config/state, scenario env applied, then spawns the real
  `bun src/main.ts` with the scenario's `args` and inherited stdio.
- `bun run demo --list`: catalog with descriptions and hints.
- Prints a world card before handing over the terminal: scenario name, hint,
  scratch dir path. The dir is kept after exit for inspection.
- Live dirs are unreachable by construction: `DOCKET_*` always point at the
  scratch dir, overriding the shell's values.

### `dev/frames.ts` — headless frame viewer (`bun run frames`)

- `bun run frames <scenario>`: mounts the real `<App>` via
  `ink-testing-library` over the same seeded scenario, prints the frame,
  exits.
- `--keys "jjD"`: plays the sequence with a short settle between keys,
  printing the frame after each — an interaction as a storyboard.
- `bun run frames all`: every scenario's initial frame in one sweep
  (skipping `wizard`).
- A viewer, never a test: no assertions, nothing committed that breaks on
  cosmetic edits.

Two commands, one core: both entry files import `sandbox.ts` + `scenarios.ts`;
seeding logic exists once. Launcher-only concerns (world card, the `running`
sleeper, kept scratch dir) stay in `demo.ts`.

## AI QA usage

Documented as a short CLAUDE.md entry (no project skill for now):

1. Fast pass after a UI change: `bun run frames all`, then
   `bun run frames <scenario> --keys …` for the touched interaction. Frames
   are evidence to judge by eye — never material for committed assertions.
2. Interactive pass when the fake terminal isn't enough (real width,
   suspend/resume, wizard): `bun run demo <scenario>` in a tmux pane,
   `send-keys` to drive, `capture-pane` to read. `frames` is the fallback
   when tmux is unavailable.

## Testing

- One smoke test: `frames` renders every catalog scenario without throwing —
  guards a schema change silently rotting the demo; asserts nothing about
  layout (per "TUI tests stay thin").
- The shim extraction is covered by the existing suite, which exercises the
  same shims through `tests/harness.ts`.
- No doctor or README-requirements changes: no runtime dependency is added.
  README gets a few lines under Development for `demo` and `frames`.
