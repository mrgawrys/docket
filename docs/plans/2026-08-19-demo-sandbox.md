# Demo Sandbox & Frame Viewer Implementation Plan

> **To execute this plan:** use the `executing-plans` skill. It reviews the plan,
> then asks how you want it built — review at the end (delegated: one subagent
> builds it all, an independent review at the end), or review each task
> (inline: a diff per task for you to approve).

**Goal:** One shared fake world for docket, reachable two ways: `bun run demo <scenario>` launches the real TUI over seeded mock data with working verbs, and `bun run frames <scenario>` prints headless frames for AI QA.

**Architecture:** The gh/claude/launchctl shims move out of `tests/harness.ts` into `dev/sandbox.ts`, which both the test harness and the new entry points consume. A typed scenario catalog (`dev/scenarios.ts`) is the single source of mock data; `dev/demo.ts` (interactive) and `dev/frames.tsx` (headless, via ink-testing-library) are thin entry points over it.

**Tech Stack:** Bun, Ink 7, ink-testing-library (already a devDependency). No new dependencies.

**Spec:** `docs/specs/2026-08-19-demo-sandbox-design.md`

## Global Constraints

- Everything lands in `dev/` and `tests/`; no file in `src/` changes.
- `DOCKET_CONFIG_DIR`/`DOCKET_STATE_DIR` are always pinned to a fresh scratch dir — a demo run must be unable to touch `~/.config/docket` or `~/.local/state/docket` regardless of the caller's shell env.
- Shim behavior must not change: the existing suite (which exercises the shims through `tests/harness.ts`) passes untouched except for the import move.
- "TUI tests stay thin" (CLAUDE.md) holds: the only new test is the frames smoke test, and it asserts nothing about layout.
- Format with `bun run format` before each commit.

---

### Task 1: Extract the shims into `dev/sandbox.ts`

**Units:** `dev/sandbox.ts` — owns the `gh`, `claude`, and `launchctl` shim sources and knows how to materialize a sandbox directory.

**Interacts:** `tests/harness.ts` imports from it and keeps its capture-file accessors, `run`/`runAsync`, `waitEntry`, and `gitInitDemo` on top. Tasks 2–3 call `materialize` directly.

**Signatures:**

```ts
export interface SandboxDirs {
  root: string;      // the scratch dir everything lives under
  configDir: string; // root/cfg
  stateDir: string;  // root/state
  binDir: string;    // root/bin — shims live here
  env: Record<string, string>;
}
export function materialize(root: string): SandboxDirs;
```

**Constraints:**
- Move the shim strings verbatim from `tests/harness.ts` (`GH_SHIM`, `CLAUDE_SHIM`, the launchctl one-liner). Do not edit their logic.
- The claude shim's capture files use bash `:?` (required). `materialize` therefore always creates the capture files (`gh-calls`, `claude-calls`, `prompt-capture`, `allowed-capture`, `cfgdir-capture`, `watchdog-capture`, `ghtoken-capture`, `status-at-call`) under `root` and sets the corresponding env vars — for the demo they're just inert files, and the harness reads them as before.
- `env` carries: `DOCKET_CONFIG_DIR`, `DOCKET_STATE_DIR`, `DOCKET_NOTIFY=0`, `CLAUDE_BIN`, `GH_BIN`, `LAUNCHCTL_BIN`, plus the eight capture vars.
- `tests/harness.ts` keeps its exact public `Sandbox` interface — `makeSandbox()` now calls `materialize` instead of writing shims itself.

**Seams:** none new — the existing suite is the test of this refactor.

**Done when:** `bun test` passes with no test file edited. Commit.

---

### Task 2: Scenario catalog + `bun run frames`

**Units:**
- `dev/scenarios.ts` — the typed catalog and the seeding function.
- `dev/frames.tsx` — renders a scenario's `<App>` headlessly and prints frames; also the `bun run frames` CLI.
- `tests/frames.test.ts` — smoke test.

**Interacts:** `frames.tsx` calls `materialize` (Task 1) + `seedScenario`, then mounts `src/tui/app.tsx`'s `<App>` with stub actions, mirroring the `mount()` helper in `tests/tui.test.tsx` (stub `TuiActions` that record calls, `resolveOpeners`, `paths()` built from the seeded dirs). The smoke test imports `renderFrames`.

**Signatures:**

```ts
// dev/scenarios.ts
export interface Scenario {
  description: string;
  config: Config;                 // from src/config
  state: State;                   // from src/state
  env?: Record<string, string>;   // shim knobs layered over sandbox env
  hint?: string;                  // e.g. "press D for the denials view"
  args?: string[];                // CLI args for demo.ts; default [] = bare queue
  interactiveOnly?: boolean;      // wizard: skipped by frames
}
export const scenarios: Record<string, Scenario>;
export function seedScenario(dirs: SandboxDirs, s: Scenario, opts?: { runningPid?: number }): void;

// dev/frames.tsx
export function renderFrames(name: string, keys?: string): Promise<string[]>;
```

**Constraints:**
- Catalog entries and their non-obvious content:
  - `full` — 4–5 entries, all `ready` with `summary` (`headline`/`issues`/`risk` from `src/summary.ts`; mix low/medium/high risk and issue counts, one entry with `denials` so the queue shows a ⊘ chip). Config maps each repo to a path under the scratch dir.
  - `empty` — valid config, `{}` state.
  - `denials` — one `ready` entry whose `denials: DenialGroup[]` exercises all three kinds the `D` view distinguishes: a safe group (e.g. `tool: "Bash"`, `suggestion: "Bash(rg:*)"`), a `writeShaped: true` group (e.g. `gh pr comment`), and a group whose `suggestion` is already present in the config's `extra_allowed_tools`. Check `src/denials.ts` `DenialGroup` for the exact fields (including the already-covered flag around line 28) and craft examples accordingly.
  - `failed` — `status: "failed"` with `error`, `denials`, and no `session_id` (the panel advertises the hand-to-claude behavior of `enter`).
  - `running` — one `status: "reviewing"` entry with `pid: 0` in the catalog; `seedScenario` replaces the pid of every `reviewing` entry with `opts.runningPid` when given. Frames passes no pid (the entry renders as a dead runner — acceptable per spec).
  - `auth-warning` — `env: { CLAUDE_LOGGED_OUT: "1" }` over the `full` state.
  - `wizard` — `interactiveOnly: true`, and `seedScenario` writes **no** config.json for it (the `"no-config"` trigger in `src/wizard/trigger.ts`); `env` carries `GH_ORG_LIST: "testorg"` so the shim answers org discovery.
- Entry keys follow the real shape `org/repo#N`; every entry needs `updated_at` (use fixed ISO strings, not `new Date()` — deterministic frames).
- `seedScenario` writes `config.json` and `state.json` into the dirs; it must not mutate the catalog object (the pid substitution happens on a copy).
- `--keys "jjD"` sends one character per keystroke via ink-testing-library's `stdin.write`, waits ~50ms after each, and records the frame after each key; output prints each frame under a `── after "j" ──` style separator. No `enter` support needed — `enter` suspends into a spawned process, which headless mode must not do.
- CLI (`import.meta.main` guard): `bun run frames <scenario>`, `--keys <seq>`, `bun run frames all` (iterate catalog, skip `interactiveOnly`, print scenario name + description above each frame). Unknown scenario → list valid names, exit 1.
- Add `"frames": "bun dev/frames.tsx"` to package.json scripts.
- `tests/frames.test.ts`: for every catalog scenario without `interactiveOnly`, `renderFrames(name)` resolves and the frame is non-empty. No other assertion — guards schema rot, not layout.

**Seams:** `renderFrames(name)` — the smoke test drives it directly.

**Done when:** `bun run frames all` prints a plausible frame per scenario (eyeball it), `bun run frames denials --keys "D"` shows the denials view, `bun test` passes. Commit.

---

### Task 3: Interactive launcher — `bun run demo`

**Units:** `dev/demo.ts` — CLI that seeds a scenario and execs the real app interactively.

**Interacts:** calls `materialize` + `seedScenario`; spawns `bun src/main.ts` with the scenario's `args`, inherited stdio, and `{...process.env, ...dirs.env, ...scenario.env}`.

**Signatures:** CLI only: `bun run demo [scenario]` (default `full`), `bun run demo --list`.

**Constraints:**
- Scratch dir via `mkdtempSync(join(tmpdir(), "docket-demo-"))`; **kept after exit**, and the world card printed before launch names it: scenario, description, hint, and the scratch path.
- For the `running` scenario: spawn `sleep 600` first, pass its pid to `seedScenario`, and kill the sleeper on demo exit if still alive (so `K` in the TUI genuinely kills a live process, but quitting the demo leaves no orphan).
- Await the child and exit with its code. Unknown scenario → same error shape as frames.
- Add `"demo": "bun dev/demo.ts"` to package.json scripts.

**Seams:** none — this task's rigor is a verification run, not tests.

**Done when** (verification, run it): `bun run demo --list` shows the catalog; in a tmux pane, `bun run demo full` shows the queue with mixed verdicts (capture-pane to confirm), `j`/`k` move, `x` dismisses a row, `q` exits and the world card's scratch dir still exists with a mutated `state.json`; `bun run demo wizard` opens on the wizard offer. Commit.

---

### Task 4: Document the commands

**Units:** CLAUDE.md — a short "Testing the TUI by hand and by AI" entry; README.md — two lines under Development.

**Interacts:** prose only.

**Constraints:** The CLAUDE.md entry carries, briefly: `bun run demo <scenario>` / `--list` for hands-on testing; `bun run frames all` and `--keys` as the AI's fast QA pass after UI changes; tmux (`send-keys`/`capture-pane`) over `bun run demo` for interactive QA, frames as the no-tmux fallback; and the standing rule that frames are evidence to eyeball, never material for committed assertions. Keep it to ~10 lines in the existing CLAUDE.md voice. README's Development list gains `bun run demo` and `bun run frames` one-liners.

**Seams:** none.

**Done when:** both files read correctly (read them back); no doctor changes — no runtime dependency was added. Commit.
