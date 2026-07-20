# auto-review rewrite: TypeScript on Bun — design

Date: 2026-07-20
Status: approved

## Goal

Rewrite the tool — both the bash poller (`bin/auto-review`) and the fish
frontend (`fish/reviews.fish`) — as a single TypeScript program compiled with
`bun build --compile` into one distributable binary named `reviews`. Motivation:
the sh implementation is hard to read, edit, and modularize; a single binary
also gives a clean install story now and a Homebrew path later.

## Non-goals

- No behavior changes: feature parity with the current tool on macOS.
- No GitHub writes — reviews stay read-only, as today.
- Linux support (systemd timer, notify-send) is a follow-up milestone, not
  part of the initial port; interfaces are designed for it from day one.

## Shape: one binary, subcommands

The daemon entry point becomes just another subcommand:

```
reviews                    interactive list (resume / d# / r# / q)
reviews poll [--dry-run]   one poll cycle — what launchd/systemd runs
reviews sync               reconcile state with GitHub
reviews review <pr> [note] force-review a PR (accepts org/repo#N or URLs)
reviews retry <key>        re-run a failed review
reviews dismiss <key>      mark done + remove worktree (scriptable d#)
reviews status | log [n] | watch
reviews on | off           install/remove the scheduler job
```

Fish shrinks to a completions file only; there is no wrapper function — the
binary lives on PATH.

## Module layout

```
src/
  main.ts        subcommand dispatch, flag parsing
  config.ts      load + validate config.json (same file/location as today)
  state.ts       Status union, Entry type, load/save, the pid lock
  github.ts      gh wrappers: search PRs, pr view, review status
  reviewer.ts    worktree setup + headless `claude -p` run, resume
  poll.ts        poll cycle: discover → skip known → review → reconcile
  sync.ts        GitHub reconciliation (merged/closed, verdicts, flags)
  list.ts        interactive list UI
  scheduler.ts   launchd on/off/status (systemd later, same interface)
  notify.ts      osascript now, notify-send later
  log.ts         timestamped file log + tty echo
tests/           bun:test; gh/claude mocked via PATH shims as today
```

Each module maps to a section of the current bash/fish code, so the port can
go file-by-file with the existing mocked tests as the behavioral spec.

## Key decisions

- **On-disk compatibility.** State stays the same JSON file in the same XDG
  location; config and log likewise. The rewrite is drop-in: existing
  `state.json` carries over untouched, and old and new can run side by side
  against the same state during the port to diff behavior.
- **Types model the lifecycle.** `Status` becomes a checked union
  (`"reviewing" | "ready" | "failed" | "canceled" | "skipped" | "done"`),
  flags likewise; the state machine the README documents in prose is enforced
  by the compiler.
- **`Bun.$` for all subprocess work** (`gh`, `git`, `claude`, `launchctl`,
  `osascript`). `resume` spawns `claude --resume <sid>` with `cwd` set to the
  clone and inherited stdio — same effect as fish's `cd; claude`.
- **Single source of config truth.** One `config.ts` replaces the duplicated
  config/path/`claude_bin` derivation currently repeated in both bash and
  fish, eliminating a drift bug class.
- **Lock** ports as-is: pid file, stale-lock takeover.
- **`watch`** follows the log file in-process (no `tail` dependency).

## Platforms

macOS first (launchd + osascript), at parity with today. `scheduler.ts` and
`notify.ts` hide the OS behind a small interface; the Linux implementations
(systemd user timer, `notify-send`) are a later milestone that touches only
those two modules.

## Install & distribution

- **Now:** `install.sh` checks `gh`/`claude`/`bun`, runs
  `bun build --compile` and drops `reviews` into `~/.local/bin`, symlinks the
  fish completions, seeds the config. Development runs use `bun run`.
- **Later (Homebrew):** a GitHub Actions release workflow cross-compiles
  binaries per platform (`bun-darwin-arm64`, `bun-linux-x64`, …) and updates
  a personal tap formula. No code changes required for this step.

## Testing

`bun:test` replaces `tests/tests.sh`, keeping the same strategy: fully
mocked, offline — `gh` and `claude` are PATH shims that record calls and
return canned output. The existing test suite defines the behaviors the port
must preserve.

## Migration

1. Port module-by-module with tests; old bash/fish stays working throughout.
2. Run both implementations against the same state; compare.
3. Switch launchd to the binary (`reviews poll`); remove `bin/auto-review`,
   `fish/reviews.fish`, and `tests/tests.sh` once parity is confirmed.

## Alternatives considered

- **Go** — best-in-class distribution (small static binary), but roughly 2×
  the code, no union types to model the lifecycle, and the user is far more
  fluent in TypeScript. Rejected: verbosity tax paid daily, distribution
  benefit marginal for a personal tool.
- **Python (+ uv)** — tersest option, but weaker typing without added
  ceremony, second-class Homebrew story, and the user's second-best language.
- **Deno** — equivalent fit; Bun chosen for user preference and
  `bun build --compile`.
- **Staying in sh** — the status quo being replaced: no data model (every
  JSON access is a `jq` subprocess), logic split across bash and fish with
  duplicated config handling, hard to modularize as it grows.
