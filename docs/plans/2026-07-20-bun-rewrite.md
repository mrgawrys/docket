# TypeScript/Bun Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `bin/auto-review` (bash) and `fish/reviews.fish` with a single TypeScript program, compiled by `bun build --compile` into one binary named `reviews`, at feature parity on macOS.

**Architecture:** One CLI with subcommands (`poll` is the daemon entry point launchd runs; the bare command is the interactive list). Modules map 1:1 to sections of the old bash/fish. On-disk formats (state.json, config.json, log, lock) and their XDG locations stay byte-compatible so old and new can run side by side during the port.

**Tech Stack:** Bun ≥ 1.2, TypeScript (strict), `Bun.spawnSync`/`Bun.spawn` for subprocesses (`Bun.$` only for osascript), `bun:test`. Zero runtime npm dependencies. (The spec suggested `Bun.$` throughout; array-argv spawn is used instead because every call here passes untrusted strings — PR titles, notes — as single arguments.)

**Spec:** `docs/specs/2026-07-20-bun-rewrite-design.md`. The old mocked suite `tests/tests.sh` (16 scenarios) is the behavioral contract; its scenarios are ported task by task and referenced below as “scenario N”.

## Global Constraints

- Command/binary name: `reviews`. launchd label stays `com.<user>.auto-review` so `reviews on` replaces the old job.
- On-disk compatibility: same paths and JSON shapes as the bash version. Config `${AUTO_REVIEW_CONFIG_DIR:-$XDG_CONFIG_HOME|~/.config}/auto-review/config.json`; state dir `${AUTO_REVIEW_STATE_DIR:-$XDG_STATE_HOME|~/.local/state}/auto-review/` containing `state.json`, `auto-review.log`, `.lock/pid`.
- Env overrides preserved exactly: `AUTO_REVIEW_CONFIG_DIR`, `AUTO_REVIEW_STATE_DIR`, `AUTO_REVIEW_NOTIFY` (0/1), `CLAUDE_BIN`, `GH_BIN`.
- Never writes to GitHub. `gh` is only used for `search prs`, `pr view`, `api user`.
- The claude allowlist and review prompt are copied **verbatim** from the bash version (Task 6) — do not reword them.
- No runtime npm deps; `@types/bun` is the only devDependency. Tests are fully offline: `gh`/`claude` are PATH-shim scripts, as in `tests/tests.sh`.
- Old bash/fish stays working until Task 12; nothing before then may delete or modify `bin/auto-review`, `fish/*`, `tests/tests.sh`.
- TDD; commit at the end of every task (smaller commits inside tasks are fine).

## File Structure

```
package.json, tsconfig.json          Task 1
src/main.ts        dispatch + usage  Task 1 (stub), wired up in Tasks 6–11
src/config.ts      paths + config    Task 2
src/state.ts       types, state IO,  Task 3
                   normalizeKey
src/log.ts         file+tty logger   Task 4
src/notify.ts      osascript         Task 4
src/lock.ts        pid lock          Task 4
tests/harness.ts   sandbox + shims   Task 5
src/github.ts      gh wrappers       Task 5
src/reviewer.ts    claude runs,      Task 6  (+ `review`, `retry` commands)
                   worktree removal
src/sync.ts        reconciliation    Task 7  (+ `sync` command)
src/poll.ts        poll cycle        Task 8  (+ `poll` command)
src/list.ts        interactive list  Task 9  (+ bare command, `dismiss`)
src/status.ts      status/log/watch  Task 10
src/scheduler.ts   launchd on/off    Task 11
install.sh, fish/reviews-completions.fish, README.md, deletions   Task 12
```

---

### Task 1: Project scaffold and CLI dispatch stub

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/main.ts`, `tests/main.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `src/main.ts` exports nothing; it dispatches `Bun.argv[2]` to a `commands` record `Record<string, (args: string[]) => Promise<number>>`. Later tasks register commands by adding entries to this record.

- [ ] **Step 1: Write project files**

`package.json`:

```json
{
  "name": "reviews",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun src/main.ts",
    "test": "bun test",
    "build": "bun build --compile src/main.ts --outfile dist/reviews"
  },
  "devDependencies": {
    "@types/bun": "^1.2.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

Append to `.gitignore` (it currently contains only `.worktrees`):

```
node_modules/
dist/
```

Run: `bun install` (creates `bun.lock`, installs `@types/bun`).

- [ ] **Step 2: Write the failing test**

`tests/main.test.ts`:

```ts
import { expect, test } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function cli(...args: string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test("help prints usage and exits 0", () => {
  const r = cli("help");
  expect(r.code).toBe(0);
  expect(r.out).toContain("reviews poll");
  expect(r.out).toContain("reviews on | off");
});

test("unknown subcommand exits 1", () => {
  const r = cli("frobnicate");
  expect(r.code).toBe(1);
  expect(r.err).toContain("unknown subcommand: frobnicate");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/main.test.ts`
Expected: FAIL (main.ts does not exist yet — spawn exits non-zero / no output).

- [ ] **Step 4: Write `src/main.ts`**

```ts
#!/usr/bin/env bun

const USAGE = `reviews — pre-run Claude Code reviews for PRs awaiting you

Usage:
  reviews                    interactive list (resume #, d# dismiss, r# retry, q quit)
  reviews poll [--dry-run]   one poll cycle (what launchd runs)
  reviews sync               reconcile state with GitHub
  reviews review <pr> [note] force-review a PR (org/repo#N or a GitHub PR URL)
  reviews retry <key>        re-run a failed review
  reviews dismiss <key>      mark done + remove the PR worktree
  reviews status             poller state, live poll, state counts
  reviews log [n]            last n log lines (default 20)
  reviews watch              follow the log live
  reviews on | off           enable/disable the scheduled poller
`;

type Command = (args: string[]) => Promise<number>;

export const commands: Record<string, Command> = {
  help: async () => {
    console.log(USAGE);
    return 0;
  },
};

async function main(): Promise<number> {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === undefined || cmd === "-h" || cmd === "--help") {
    // bare `reviews` becomes the interactive list in Task 9
    return commands["help"]!([]);
  }
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown subcommand: ${cmd} (try: reviews help)`);
    return 1;
  }
  return fn(rest);
}

process.exit(await main());
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/main.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Sanity-check the compiled binary**

Run: `bun run build && ./dist/reviews help`
Expected: usage text prints. (This is the distribution artifact — check it early, not in Task 12.)

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json bun.lock src/main.ts tests/main.test.ts .gitignore
git commit -m "feat: scaffold reviews CLI (bun + strict TS, dispatch stub)"
```

---

### Task 2: config.ts — paths and config loading

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `interface Config { orgs: string[]; repos: Record<string, string>; poll_interval_minutes?: number; claude_bin?: string; claude_config_dir?: string; notifications?: boolean }`
  - `interface Paths { configDir: string; stateDir: string; configPath: string; statePath: string; logPath: string; lockDir: string }`
  - `paths(env?: NodeJS.ProcessEnv): Paths` — XDG + `AUTO_REVIEW_*` override resolution
  - `class ConfigError extends Error`
  - `loadConfig(p?: Paths): Promise<Config>` — throws `ConfigError` if missing/invalid; message must contain `config.example.json` (scenario 9 greps for it)
  - `claudeBin(cfg: Config, env?): string`, `ghBin(env?): string`, `notifyEnabled(cfg: Config, env?): boolean`

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, claudeBin, ghBin, loadConfig, notifyEnabled, paths } from "../src/config";

test("paths: env overrides beat XDG beats HOME defaults", () => {
  const home = { HOME: "/h" } as NodeJS.ProcessEnv;
  expect(paths(home).configPath).toBe("/h/.config/auto-review/config.json");
  expect(paths(home).statePath).toBe("/h/.local/state/auto-review/state.json");
  const xdg = { HOME: "/h", XDG_CONFIG_HOME: "/x/cfg", XDG_STATE_HOME: "/x/st" } as NodeJS.ProcessEnv;
  expect(paths(xdg).configDir).toBe("/x/cfg/auto-review");
  expect(paths(xdg).lockDir).toBe("/x/st/auto-review/.lock");
  const own = { HOME: "/h", AUTO_REVIEW_CONFIG_DIR: "/o/c", AUTO_REVIEW_STATE_DIR: "/o/s" } as NodeJS.ProcessEnv;
  expect(paths(own).configPath).toBe("/o/c/config.json");
  expect(paths(own).logPath).toBe("/o/s/auto-review.log");
});

test("loadConfig: missing file throws ConfigError pointing at config.example.json", async () => {
  const p = paths({ AUTO_REVIEW_CONFIG_DIR: "/nonexistent-xyz", AUTO_REVIEW_STATE_DIR: "/tmp" } as NodeJS.ProcessEnv);
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
  await expect(loadConfig(p)).rejects.toThrow(/config\.example\.json/);
});

test("loadConfig: parses a valid config; rejects one without orgs/repos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-cfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ orgs: ["o"], repos: { "o/r": "/tmp" } }));
  const p = paths({ AUTO_REVIEW_CONFIG_DIR: dir, AUTO_REVIEW_STATE_DIR: dir } as NodeJS.ProcessEnv);
  const cfg = await loadConfig(p);
  expect(cfg.orgs).toEqual(["o"]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ hello: 1 }));
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("binary + notification resolution", () => {
  const cfg = { orgs: [], repos: {}, claude_bin: "/x/claude", notifications: false };
  expect(claudeBin(cfg, {} as NodeJS.ProcessEnv)).toBe("/x/claude");
  expect(claudeBin(cfg, { CLAUDE_BIN: "/env/claude" } as NodeJS.ProcessEnv)).toBe("/env/claude");
  expect(claudeBin({ orgs: [], repos: {} }, {} as NodeJS.ProcessEnv)).toBe("claude");
  expect(ghBin({} as NodeJS.ProcessEnv)).toBe("gh");
  expect(ghBin({ GH_BIN: "/g" } as NodeJS.ProcessEnv)).toBe("/g");
  expect(notifyEnabled(cfg, {} as NodeJS.ProcessEnv)).toBe(false);
  expect(notifyEnabled({ orgs: [], repos: {} }, {} as NodeJS.ProcessEnv)).toBe(true);
  expect(notifyEnabled({ orgs: [], repos: {} }, { AUTO_REVIEW_NOTIFY: "0" } as NodeJS.ProcessEnv)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { join } from "node:path";

export interface Config {
  orgs: string[];
  repos: Record<string, string>;
  poll_interval_minutes?: number;
  claude_bin?: string;
  claude_config_dir?: string;
  notifications?: boolean;
}

export interface Paths {
  configDir: string;
  stateDir: string;
  configPath: string;
  statePath: string;
  logPath: string;
  lockDir: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME ?? "";
  const configDir =
    env.AUTO_REVIEW_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "auto-review");
  const stateDir =
    env.AUTO_REVIEW_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "auto-review");
  return {
    configDir,
    stateDir,
    configPath: join(configDir, "config.json"),
    statePath: join(stateDir, "state.json"),
    logPath: join(stateDir, "auto-review.log"),
    lockDir: join(stateDir, ".lock"),
  };
}

export class ConfigError extends Error {}

export async function loadConfig(p: Paths = paths()): Promise<Config> {
  const file = Bun.file(p.configPath);
  if (!(await file.exists())) {
    throw new ConfigError(
      `no config at ${p.configPath} — copy config.example.json there and fill it in`,
    );
  }
  let cfg: Config;
  try {
    cfg = (await file.json()) as Config;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${p.configPath}: ${e}`);
  }
  if (!Array.isArray(cfg.orgs) || typeof cfg.repos !== "object" || cfg.repos === null) {
    throw new ConfigError(
      `invalid config at ${p.configPath} — need "orgs" (array) and "repos" (object); see config.example.json`,
    );
  }
  return cfg;
}

export const claudeBin = (cfg: Config, env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_BIN ?? cfg.claude_bin ?? "claude";

export const ghBin = (env: NodeJS.ProcessEnv = process.env): string => env.GH_BIN ?? "gh";

export const notifyEnabled = (cfg: Config, env: NodeJS.ProcessEnv = process.env): boolean =>
  env.AUTO_REVIEW_NOTIFY !== undefined
    ? env.AUTO_REVIEW_NOTIFY === "1"
    : cfg.notifications !== false;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config module — XDG paths, env overrides, validation"
```

---

### Task 3: state.ts — types, state IO, key normalization

**Files:**
- Create: `src/state.ts`, `tests/state.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type Verdict = "approved" | "changes-requested" | "commented"`
  - `type Status = "reviewing" | "ready" | "failed" | "canceled" | "skipped" | "done" | Verdict` — note: sync stores your review verdict *in the status field*, exactly like the bash version does.
  - `interface Entry { status: Status; title?: string; url?: string; local_path?: string; session_id?: string; error?: string; flags?: string[]; done_reason?: "merged" | "closed"; my_review_at?: string; note?: string; updated_at: string }`
  - `type State = Record<string, Entry>`
  - `timestamp(): string` — UTC `YYYY-MM-DDTHH:MM:SSZ` (no millis, matching `date -u`)
  - `ensureState(statePath: string): void`, `loadState(statePath: string): State`, `saveState(statePath: string, s: State): void` (tmp-file + rename)
  - `updateEntry(statePath, key, fn: (e: Entry | undefined) => Entry): void`
  - `setStatus(statePath, key, status: Status, error?: string): void`
  - `markDone(statePath, key, reason: "merged" | "closed"): void`
  - `markReviewed(statePath, key, verdict: Verdict, reviewedAt: string, flags: string[]): void`
  - `pendingEntries(s: State): [string, Entry][]` — excludes `done`, ascending by `updated_at`
  - `normalizeKey(input: string): string` — accepts `ORG/REPO#N` or a GitHub PR URL; throws `` Error(`cannot parse '${input}' — expected ORG/REPO#NUM or a GitHub PR URL`) ``
  - `splitKey(key: string): { repo: string; number: string }`

JSON is written pretty-printed; the bash version wrote jq-compact. Both are valid JSON of the same shape — either implementation reads the other's file.

- [ ] **Step 1: Write the failing tests**

`tests/state.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadState, markDone, markReviewed, normalizeKey, pendingEntries,
  saveState, setStatus, splitKey, timestamp,
} from "../src/state";

const statePath = () => join(mkdtempSync(join(tmpdir(), "rv-state-")), "state.json");

test("normalizeKey accepts org/repo#N and PR URLs, rejects garbage", () => {
  expect(normalizeKey("acme/widgets#12")).toBe("acme/widgets#12");
  expect(normalizeKey("https://github.com/acme/widgets/pull/12")).toBe("acme/widgets#12");
  expect(() => normalizeKey("total garbage")).toThrow(/cannot parse/);
  expect(() => normalizeKey("acme/widgets")).toThrow(/cannot parse/);
});

test("splitKey splits on the last #", () => {
  expect(splitKey("acme/widgets#12")).toEqual({ repo: "acme/widgets", number: "12" });
});

test("timestamp is second-precision UTC", () => {
  expect(timestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("load bootstraps {}, save round-trips", () => {
  const p = statePath();
  expect(loadState(p)).toEqual({});
  saveState(p, { "a/b#1": { status: "ready", updated_at: "t" } });
  expect(loadState(p)["a/b#1"]!.status).toBe("ready");
});

test("setStatus updates status + updated_at, records error only when given", () => {
  const p = statePath();
  saveState(p, { "a/b#1": { status: "reviewing", updated_at: "2020-01-01T00:00:00Z" } });
  setStatus(p, "a/b#1", "failed", "boom");
  const e = loadState(p)["a/b#1"]!;
  expect(e.status).toBe("failed");
  expect(e.error).toBe("boom");
  expect(e.updated_at).not.toBe("2020-01-01T00:00:00Z");
  setStatus(p, "a/b#1", "ready");
  expect(loadState(p)["a/b#1"]!.error).toBe("boom"); // untouched when not given
});

test("markDone and markReviewed", () => {
  const p = statePath();
  saveState(p, { "a/b#1": { status: "ready", session_id: "s", updated_at: "t" } });
  markReviewed(p, "a/b#1", "changes-requested", "2026-07-19T10:00:00Z", ["re-requested"]);
  let e = loadState(p)["a/b#1"]!;
  expect(e.status).toBe("changes-requested");
  expect(e.flags).toEqual(["re-requested"]);
  expect(e.session_id).toBe("s"); // must stay resumable (scenario 13)
  markDone(p, "a/b#1", "merged");
  e = loadState(p)["a/b#1"]!;
  expect(e.status).toBe("done");
  expect(e.done_reason).toBe("merged");
});

test("pendingEntries excludes done, sorts by updated_at ascending", () => {
  const s = {
    "a/b#3": { status: "done" as const, updated_at: "2026-01-03T00:00:00Z" },
    "a/b#2": { status: "ready" as const, updated_at: "2026-01-02T00:00:00Z" },
    "a/b#1": { status: "failed" as const, updated_at: "2026-01-01T00:00:00Z" },
  };
  expect(pendingEntries(s).map(([k]) => k)).toEqual(["a/b#1", "a/b#2"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/state.test.ts`
Expected: FAIL — cannot resolve `../src/state`.

- [ ] **Step 3: Write `src/state.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Verdict = "approved" | "changes-requested" | "commented";
export type Status =
  | "reviewing" | "ready" | "failed" | "canceled" | "skipped" | "done" | Verdict;

export interface Entry {
  status: Status;
  title?: string;
  url?: string;
  local_path?: string;
  session_id?: string;
  error?: string;
  flags?: string[];
  done_reason?: "merged" | "closed";
  my_review_at?: string;
  note?: string;
  updated_at: string;
}

export type State = Record<string, Entry>;

export function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function ensureState(statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  if (!existsSync(statePath)) writeFileSync(statePath, "{}\n");
}

export function loadState(statePath: string): State {
  ensureState(statePath);
  return JSON.parse(readFileSync(statePath, "utf8")) as State;
}

export function saveState(statePath: string, s: State): void {
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, statePath);
}

export function updateEntry(
  statePath: string,
  key: string,
  fn: (e: Entry | undefined) => Entry,
): void {
  const s = loadState(statePath);
  s[key] = fn(s[key]);
  saveState(statePath, s);
}

export function setStatus(statePath: string, key: string, status: Status, error?: string): void {
  updateEntry(statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status,
    updated_at: timestamp(),
    ...(error !== undefined ? { error } : {}),
  }));
}

export function markDone(statePath: string, key: string, reason: "merged" | "closed"): void {
  updateEntry(statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status: "done",
    done_reason: reason,
    updated_at: timestamp(),
  }));
}

export function markReviewed(
  statePath: string,
  key: string,
  verdict: Verdict,
  reviewedAt: string,
  flags: string[],
): void {
  updateEntry(statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status: verdict,
    my_review_at: reviewedAt,
    flags,
    updated_at: timestamp(),
  }));
}

export function pendingEntries(s: State): [string, Entry][] {
  return Object.entries(s)
    .filter(([, e]) => e.status !== "done")
    .sort(([, a], [, b]) => a.updated_at.localeCompare(b.updated_at));
}

export function normalizeKey(input: string): string {
  let key = input;
  const url = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) key = `${url[1]}/${url[2]}#${url[3]}`;
  if (!/^[^/#\s]+\/[^/#\s]+#\d+$/.test(key)) {
    throw new Error(`cannot parse '${input}' — expected ORG/REPO#NUM or a GitHub PR URL`);
  }
  return key;
}

export function splitKey(key: string): { repo: string; number: string } {
  const i = key.lastIndexOf("#");
  return { repo: key.slice(0, i), number: key.slice(i + 1) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/state.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: state module — typed entries, atomic writes, key parsing"
```

---

### Task 4: log.ts, notify.ts, lock.ts

**Files:**
- Create: `src/log.ts`, `src/notify.ts`, `src/lock.ts`, `tests/lock.test.ts`, `tests/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Logger = (msg: string) => void` — appends `YYYY-MM-DD HH:MM:SS msg` (local time, like the bash `date`) to the log file; echoes to stderr when it's a TTY
  - `makeLogger(logPath: string): Logger`
  - `notify(enabled: boolean, title: string, body: string): Promise<void>` — macOS `osascript`, double quotes stripped, best-effort (never throws), no-op off-darwin
  - `acquireLock(lockDir: string, log: Logger): (() => void) | null` — `null` means another live run holds it (caller exits 0); stale locks (dead pid) are taken over; returns a release function also registered on `process.on("exit")`

- [ ] **Step 1: Write the failing tests**

`tests/log.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "../src/log";

test("logger appends timestamped lines", () => {
  const p = join(mkdtempSync(join(tmpdir(), "rv-log-")), "x.log");
  const log = makeLogger(p);
  log("hello");
  log("world");
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hello$/);
});
```

`tests/lock.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock";

const noop = () => {};

test("acquire writes our pid; live lock is not stolen; release frees it", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rv-lock-")), "lock");
  const release = acquireLock(dir, noop);
  expect(release).not.toBeNull();
  expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
  expect(acquireLock(dir, noop)).toBeNull(); // our own pid is alive
  release!();
  const again = acquireLock(dir, noop);
  expect(again).not.toBeNull();
  again!();
});

test("stale lock (dead pid) is taken over", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rv-lock-")), "lock");
  const child = Bun.spawn(["true"]);
  await child.exited; // child.pid is now guaranteed dead
  mkdirSync(dir);
  writeFileSync(join(dir, "pid"), String(child.pid));
  const release = acquireLock(dir, noop);
  expect(release).not.toBeNull();
  expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
  release!();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/log.test.ts tests/lock.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the three modules**

`src/log.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (msg: string) => void;

function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function makeLogger(logPath: string): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  return (msg) => {
    const line = `${localTimestamp()} ${msg}`;
    appendFileSync(logPath, line + "\n");
    if (process.stderr.isTTY) console.error(line);
  };
}
```

`src/notify.ts`:

```ts
export async function notify(enabled: boolean, title: string, body: string): Promise<void> {
  if (!enabled || process.platform !== "darwin") return;
  const strip = (s: string) => s.replaceAll('"', "");
  const script = `display notification "${strip(body)}" with title "${strip(title)}"`;
  try {
    await Bun.$`osascript -e ${script}`.quiet();
  } catch {
    // notifications are best-effort, exactly like the bash `|| true`
  }
}
```

`src/lock.ts`:

```ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockDir: string, log: Logger): (() => void) | null {
  const tryMkdir = (): boolean => {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryMkdir()) {
    let pid = NaN;
    try {
      pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
    } catch {
      // unreadable pid file → treat as stale
    }
    if (Number.isFinite(pid) && pidAlive(pid)) {
      log(`lock held by pid ${pid}, skipping run`);
      return null;
    }
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  const release = () => rmSync(lockDir, { recursive: true, force: true });
  process.on("exit", release);
  return release;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/log.test.ts tests/lock.test.ts`
Expected: 3 pass. (`notify` has no automated test — darwin-only side effect; it is exercised manually in Task 12's parity check.)

- [ ] **Step 5: Commit**

```bash
git add src/log.ts src/notify.ts src/lock.ts tests/log.test.ts tests/lock.test.ts
git commit -m "feat: logger, notifications, pid lock"
```

---

### Task 5: Test harness (sandbox + shims) and github.ts

The harness recreates what `tests/tests.sh` builds in its first 55 lines: a temp sandbox with `gh`/`claude` PATH-shim scripts, env overrides, and a black-box `run()` for the CLI. Every integration test from here on uses it.

**Files:**
- Create: `tests/harness.ts`, `src/github.ts`, `tests/github.test.ts`

**Interfaces:**
- Consumes: `paths` from `src/config.ts` (Task 2).
- Produces (`tests/harness.ts`):
  - `makeSandbox(): Sandbox` where `interface Sandbox { tmp: string; env: Record<string, string>; configDir: string; stateDir: string; statePath: string; logPath: string; demoRepo: string; run(args: string[], extraEnv?: Record<string, string | undefined>): { code: number; out: string; err: string }; state(): Record<string, any>; writeConfig(cfg: unknown): void; writeState(s: unknown): void; claudeCalls(): number; promptCapture(): string; cfgdirCapture(): string; statusAtCall(): string; gitInitDemo(): void }`
  - `run` merges `process.env` + sandbox env + `extraEnv`; an `extraEnv` value of `undefined` **deletes** that variable (needed to unset `CLAUDE_BIN`, scenario 11).
- Produces (`src/github.ts`):
  - `interface GhCtx { gh: string; log: Logger; logPath: string }` — gh stderr is appended to `logPath`, matching bash's `2>>"$LOG_FILE"`
  - `interface Candidate { repo: string; number: number; title: string; url: string }`
  - `ghUser(ctx: GhCtx): string | null`
  - `prView<T>(ctx: GhCtx, repo: string, number: string, fields: string): T | null` — null on any failure
  - `searchReviewRequests(ctx: GhCtx, org: string): Candidate[]` — non-draft only; on gh failure logs `gh search failed for org ${org}` and returns `[]`

- [ ] **Step 1: Write the harness**

`tests/harness.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

// Same shims as tests/tests.sh, knobs included: GH_PR_STATUS_JSON,
// GH_PR_VIEW_FAIL, CLAUDE_FAIL. The claude shim records its calls, the
// prompt, CLAUDE_CONFIG_DIR, and the state of testorg/demo#7 at call time.
const GH_SHIM = `#!/usr/bin/env bash
if [ "$1" = api ] && [ "$2" = user ]; then echo testuser; exit 0; fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  for a in "$@"; do
    if [[ "$a" == *state*latestReviews* ]]; then
      [ "\${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      json="\${GH_PR_STATUS_JSON:-}"
      [ -n "$json" ] || json='{"state":"OPEN"}'
      echo "$json"
      exit 0
    fi
  done
  echo '{"title": "Manual PR", "url": "https://example.test/pr/42"}'
  exit 0
fi
cat <<'JSON'
[{"number": 7, "title": "Demo PR", "url": "https://example.test/pr/7",
  "isDraft": false, "repository": {"nameWithOwner": "testorg/demo"}},
 {"number": 8, "title": "Draft PR", "url": "https://example.test/pr/8",
  "isDraft": true, "repository": {"nameWithOwner": "testorg/demo"}}]
JSON
`;

const CLAUDE_SHIM = `#!/usr/bin/env bash
echo run >>"\${CLAUDE_CALLS:?}"
[ "$1" = -p ] && printf '%s' "$2" >"\${PROMPT_CAPTURE:?}"
printf '%s' "\${CLAUDE_CONFIG_DIR:-}" >"\${CFGDIR_CAPTURE:?}"
bun -e 'const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(process.env.AUTO_REVIEW_STATE_DIR+"/state.json","utf8"))}catch{};console.log((s["testorg/demo#7"]||{}).status||"absent")' >"\${STATUS_AT_CALL:?}"
if [ "\${CLAUDE_FAIL:-0}" = 1 ]; then echo "boom" >&2; exit 1; fi
echo '{"type":"result","subtype":"success","result":"ok","session_id":"sess-1234"}'
`;

export interface Sandbox {
  tmp: string;
  env: Record<string, string>;
  configDir: string;
  stateDir: string;
  statePath: string;
  logPath: string;
  demoRepo: string;
  run(args: string[], extraEnv?: Record<string, string | undefined>): { code: number; out: string; err: string };
  state(): Record<string, any>;
  writeConfig(cfg: unknown): void;
  writeState(s: unknown): void;
  claudeCalls(): number;
  promptCapture(): string;
  cfgdirCapture(): string;
  statusAtCall(): string;
  gitInitDemo(): void;
}

export function makeSandbox(): Sandbox {
  const tmp = mkdtempSync(join(tmpdir(), "reviews-it-"));
  const configDir = join(tmp, "cfg");
  const stateDir = join(tmp, "ar");
  const bin = join(tmp, "bin");
  const demoRepo = join(tmp, "demo");
  for (const d of [configDir, stateDir, bin, demoRepo]) mkdirSync(d, { recursive: true });

  const ghShim = join(bin, "gh");
  const claudeShim = join(bin, "claude");
  writeFileSync(ghShim, GH_SHIM);
  writeFileSync(claudeShim, CLAUDE_SHIM);
  chmodSync(ghShim, 0o755);
  chmodSync(claudeShim, 0o755);

  const capture = (name: string) => {
    const p = join(tmp, name);
    writeFileSync(p, "");
    return p;
  };
  const env: Record<string, string> = {
    AUTO_REVIEW_CONFIG_DIR: configDir,
    AUTO_REVIEW_STATE_DIR: stateDir,
    AUTO_REVIEW_NOTIFY: "0",
    CLAUDE_BIN: claudeShim,
    GH_BIN: ghShim,
    CLAUDE_CALLS: capture("claude-calls"),
    PROMPT_CAPTURE: capture("prompt-capture"),
    CFGDIR_CAPTURE: capture("cfgdir-capture"),
    STATUS_AT_CALL: capture("status-at-call"),
  };

  const statePath = join(stateDir, "state.json");
  const writeConfig = (cfg: unknown) =>
    writeFileSync(join(configDir, "config.json"), JSON.stringify(cfg));
  writeConfig({ orgs: ["testorg"], repos: { "testorg/demo": demoRepo } });

  return {
    tmp, env, configDir, stateDir, statePath,
    logPath: join(stateDir, "auto-review.log"),
    demoRepo,
    run(args, extraEnv = {}) {
      const e: Record<string, string | undefined> = { ...process.env, ...env, ...extraEnv };
      for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
      const p = Bun.spawnSync(["bun", MAIN, ...args], { env: e as Record<string, string> });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    },
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    writeConfig,
    writeState: (s) => writeFileSync(statePath, JSON.stringify(s)),
    claudeCalls: () =>
      readFileSync(env.CLAUDE_CALLS!, "utf8").split("\n").filter(Boolean).length,
    promptCapture: () => readFileSync(env.PROMPT_CAPTURE!, "utf8"),
    cfgdirCapture: () => readFileSync(env.CFGDIR_CAPTURE!, "utf8"),
    statusAtCall: () => readFileSync(env.STATUS_AT_CALL!, "utf8").trim(),
    gitInitDemo() {
      const g = (...a: string[]) =>
        Bun.spawnSync(["git", "-C", demoRepo, ...a], { env: process.env as Record<string, string> });
      g("init", "-q");
      g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
      g("worktree", "add", "--quiet", join(demoRepo, ".worktrees", "pr-7"));
    },
  };
}
```

- [ ] **Step 2: Write the failing github tests**

`tests/github.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ghUser, prView, searchReviewRequests, type GhCtx } from "../src/github";
import { makeSandbox } from "./harness";

const sb = makeSandbox();
const ctx: GhCtx = { gh: sb.env.GH_BIN!, log: () => {}, logPath: join(sb.tmp, "gh.log") };

afterEach(() => {
  delete process.env.GH_PR_VIEW_FAIL;
  delete process.env.GH_PR_STATUS_JSON;
});

test("ghUser returns the login", () => {
  expect(ghUser(ctx)).toBe("testuser");
});

test("searchReviewRequests returns non-draft candidates only", () => {
  const c = searchReviewRequests(ctx, "testorg");
  expect(c).toEqual([
    { repo: "testorg/demo", number: 7, title: "Demo PR", url: "https://example.test/pr/7" },
  ]);
});

test("prView parses JSON; returns null on gh failure", () => {
  const info = prView<{ state: string }>(ctx, "testorg/demo", "7", "state,latestReviews,reviewRequests,commits");
  expect(info).toEqual({ state: "OPEN" });
  process.env.GH_PR_VIEW_FAIL = "1";
  expect(prView(ctx, "testorg/demo", "7", "state,latestReviews,reviewRequests,commits")).toBeNull();
});
```

(The shims read `GH_PR_VIEW_FAIL` etc. from the environment; `Bun.spawnSync` inherits `process.env` by default, so setting `process.env` in the test reaches the shim.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/github.test.ts`
Expected: FAIL — `src/github.ts` missing.

- [ ] **Step 4: Write `src/github.ts`**

```ts
import { appendFileSync } from "node:fs";
import type { Logger } from "./log";

export interface GhCtx {
  gh: string;
  log: Logger;
  logPath: string;
}

export interface Candidate {
  repo: string;
  number: number;
  title: string;
  url: string;
}

function gh(ctx: GhCtx, args: string[]): string | null {
  const p = Bun.spawnSync([ctx.gh, ...args], { stderr: "pipe" });
  const err = p.stderr.toString();
  if (err) appendFileSync(ctx.logPath, err);
  if (p.exitCode !== 0) return null;
  return p.stdout.toString();
}

export function ghUser(ctx: GhCtx): string | null {
  const out = gh(ctx, ["api", "user", "--jq", ".login"]);
  const login = out?.trim();
  return login ? login : null;
}

export function prView<T>(ctx: GhCtx, repo: string, number: string, fields: string): T | null {
  const out = gh(ctx, ["pr", "view", number, "--repo", repo, "--json", fields]);
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

interface SearchRow {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  repository: { nameWithOwner: string };
}

export function searchReviewRequests(ctx: GhCtx, org: string): Candidate[] {
  const out = gh(ctx, [
    "search", "prs", "--review-requested=@me", "--state=open",
    "--owner", org, "--limit", "100",
    "--json", "number,title,url,isDraft,repository",
  ]);
  if (out === null) {
    ctx.log(`gh search failed for org ${org}`);
    return [];
  }
  let rows: SearchRow[];
  try {
    rows = JSON.parse(out) as SearchRow[];
  } catch {
    ctx.log(`gh search failed for org ${org}`);
    return [];
  }
  return rows
    .filter((r) => !r.isDraft)
    .map((r) => ({
      repo: r.repository.nameWithOwner,
      number: r.number,
      title: r.title,
      url: r.url,
    }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/github.test.ts`
Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add tests/harness.ts src/github.ts tests/github.test.ts
git commit -m "feat: gh wrappers + offline test harness with gh/claude shims"
```

---

### Task 6: reviewer.ts + `review` and `retry` commands

Ports `review_prompt`, `ALLOWED_TOOLS`, `review_pr`, `remove_worktree`, orphan reconciliation, and the `--review`/`--retry` entry points. Also introduces the shared command bootstrap (`withCtx`/`runLocked`) in `main.ts` that `sync` (Task 7) and `poll` (Task 8) reuse.

**Files:**
- Create: `src/reviewer.ts`, `tests/review.test.ts`
- Modify: `src/main.ts` (bootstrap + two commands), `src/state.ts` (add `reconcileOrphans`)

**Interfaces:**
- Consumes: `Config`/`Paths`/`loadConfig`/`paths`/`claudeBin`/`ghBin`/`notifyEnabled` (Task 2); state helpers (Task 3); `makeLogger`, `notify`, `acquireLock` (Task 4); `GhCtx`, `prView` (Task 5).
- Produces (`src/reviewer.ts`):
  - `const ALLOWED_TOOLS: string` — verbatim from bash
  - `reviewPrompt(number: string, note?: string): string` — verbatim text
  - `interface Counters { reviewed: number; failed: number; skipped: number; synced: number }`
  - `interface Ctx { cfg: Config; paths: Paths; log: Logger; gh: GhCtx; counters: Counters; current: { key: string } }`
  - `reviewPr(ctx: Ctx, key: string, repo: string, number: string, title: string, url: string, note?: string): Promise<void>`
  - `removeWorktree(ctx: Ctx, key: string, logPrefix: string): void` — reads `local_path` from state, `git worktree remove --force`, logs success/failure as `` `${logPrefix} ${key}: removed worktree …` ``
- Produces (`src/state.ts` addition):
  - `reconcileOrphans(statePath: string, log: Logger): void` — every `reviewing` entry → `failed` with error `previous run died mid-review`, logged as `ORPHAN ${key}: … — retry with: reviews retry ${key}`
- Produces (`src/main.ts`):
  - `withCtx(fn: (ctx: Ctx) => Promise<number>): Promise<number>` — builds Ctx; on `ConfigError` prints the message to stderr and returns 1 (scenario 9)
  - `runLocked(ctx, fn): Promise<number>` — acquires the lock (held ⇒ return 0, matching bash `exit 0`), runs `reconcileOrphans`, installs SIGINT/SIGTERM handlers that mark `ctx.current.key` as `canceled`/`run interrupted` and exit 130, releases the lock after `fn`

- [ ] **Step 1: Write the failing integration tests**

`tests/review.test.ts` (ports scenarios 4, 5, 7, 8, 9, 10, 11 through the `review`/`retry` commands):

```ts
import { expect, test } from "bun:test";
import { makeSandbox } from "./harness";

test("review + retry command family", () => {
  const sb = makeSandbox();

  // scenario 7: force-review with a note
  let r = sb.run(["review", "testorg/demo#42", "author pushed changes, focus on the delta"]);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#42"].status).toBe("ready");
  expect(sb.state()["testorg/demo#42"].session_id).toBe("sess-1234");
  expect(sb.state()["testorg/demo#42"].title).toBe("Manual PR");
  expect(sb.promptCapture()).toContain("worktree for PR #42 at .worktrees/pr-42");
  expect(sb.promptCapture()).toContain("/code-review 42");
  expect(sb.promptCapture()).toContain("focus on the delta");

  // scenario 8: URL input normalizes; garbage is rejected
  r = sb.run(["review", "https://github.com/testorg/demo/pull/43"]);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#43"].status).toBe("ready");
  expect(Object.keys(sb.state()).some((k) => k.startsWith("http"))).toBe(false);
  r = sb.run(["review", "total garbage"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("cannot parse");

  // scenario 4 via review: claude failure -> failed + error recorded
  r = sb.run(["review", "testorg/demo#50"], { CLAUDE_FAIL: "1" });
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#50"].status).toBe("failed");
  expect(sb.state()["testorg/demo#50"].error).toBeTruthy();

  // scenario 5: retry flips failed -> ready; unknown key exits non-zero
  r = sb.run(["retry", "testorg/demo#50"]);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#50"].status).toBe("ready");
  expect(sb.state()["testorg/demo#50"].session_id).toBe("sess-1234");
  expect(sb.run(["retry", "nope/nope#1"]).code).not.toBe(0);
});

test("scenario 9: missing config errors, pointing at config.example.json", () => {
  const sb = makeSandbox();
  const r = sb.run(["review", "testorg/demo#1"], { AUTO_REVIEW_CONFIG_DIR: sb.tmp + "/nonexistent" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("config.example.json");
});

test("scenario 10: claude_config_dir reaches claude as CLAUDE_CONFIG_DIR", () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: sb.tmp + "/claude-home",
  });
  expect(sb.run(["review", "testorg/demo#44"]).code).toBe(0);
  expect(sb.cfgdirCapture()).toBe(sb.tmp + "/claude-home");
});

test("scenario 11: claude_bin from config used when CLAUDE_BIN unset", () => {
  const sb = makeSandbox();
  const shim2 = sb.env.CLAUDE_BIN + "2";
  Bun.spawnSync(["cp", sb.env.CLAUDE_BIN!, shim2]);
  sb.writeConfig({ orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo }, claude_bin: shim2 });
  const before = sb.claudeCalls();
  expect(sb.run(["review", "testorg/demo#45"], { CLAUDE_BIN: undefined }).code).toBe(0);
  expect(sb.claudeCalls()).toBe(before + 1); // the copied shim appends to the same CLAUDE_CALLS file
  expect(sb.state()["testorg/demo#45"].status).toBe("ready");
});

test("skipped: unmapped repo -> status skipped, no local_path (scenario 12 core)", () => {
  const sb = makeSandbox();
  sb.writeConfig({ orgs: ["testorg"], repos: {} });
  expect(sb.run(["review", "testorg/demo#46"]).code).toBe(0);
  const e = sb.state()["testorg/demo#46"];
  expect(e.status).toBe("skipped");
  expect("local_path" in e).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/review.test.ts`
Expected: FAIL — `review` is an unknown subcommand.

- [ ] **Step 3: Write `src/reviewer.ts`**

The two template strings below are **copied verbatim** from `bin/auto-review` lines 27–37 — do not reword them.

```ts
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { claudeBin, notifyEnabled, type Config, type Paths } from "./config";
import type { GhCtx } from "./github";
import type { Logger } from "./log";
import { notify } from "./notify";
import { loadState, splitKey, timestamp, updateEntry } from "./state";

export const ALLOWED_TOOLS =
  "Read,Grep,Glob,Task,Agent,TodoWrite,Skill(code-review),Skill(code-review:code-review),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),Bash(gh pr list:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git fetch:*),Bash(git worktree:*),Bash(git checkout:*),Bash(git branch:*),Bash(cd:*),Bash(echo:*)";

export function reviewPrompt(number: string, note?: string): string {
  let p =
    `Create a git worktree for PR #${number} at .worktrees/pr-${number} ` +
    `(fetch the PR branch first). Do ALL branch checkouts and code inspection ` +
    `inside that worktree — never modify the main working copy. Then review ` +
    `the PR by running /code-review ${number}. Keep the worktree in place ` +
    `afterwards so follow-up questions can use it.`;
  if (note) p += `\n\nAdditional context from the reviewer: ${note}`;
  return p;
}

export interface Counters {
  reviewed: number;
  failed: number;
  skipped: number;
  synced: number;
}

export interface Ctx {
  cfg: Config;
  paths: Paths;
  log: Logger;
  gh: GhCtx;
  counters: Counters;
  current: { key: string };
}

export function removeWorktree(ctx: Ctx, key: string, logPrefix: string): void {
  const { number } = splitKey(key);
  const path = loadState(ctx.paths.statePath)[key]?.local_path;
  const wt = join(".worktrees", `pr-${number}`);
  if (!path || !existsSync(join(path, wt))) return;
  const p = Bun.spawnSync(["git", "-C", path, "worktree", "remove", "--force", wt], {
    stderr: "pipe",
  });
  appendFileSync(ctx.paths.logPath, p.stderr.toString());
  if (p.exitCode === 0) {
    ctx.log(`${logPrefix} ${key}: removed worktree ${path}/${wt}`);
  } else {
    ctx.log(`${logPrefix} ${key}: could not remove worktree ${path}/${wt}`);
  }
}

export async function reviewPr(
  ctx: Ctx,
  key: string,
  repo: string,
  number: string,
  title: string,
  url: string,
  note?: string,
): Promise<void> {
  const { statePath } = ctx.paths;
  const localPath = ctx.cfg.repos[repo];
  const enabled = notifyEnabled(ctx.cfg);

  if (!localPath || !existsSync(localPath)) {
    ctx.log(`SKIP ${key}: no local clone mapped`);
    updateEntry(statePath, key, () => ({
      status: "skipped", title, url, updated_at: timestamp(),
    }));
    await notify(enabled, "auto-review: no local clone", key);
    ctx.counters.skipped++;
    return;
  }

  updateEntry(statePath, key, () => ({
    status: "reviewing", title, url, local_path: localPath, updated_at: timestamp(),
  }));
  ctx.current.key = key;
  ctx.log(`REVIEW ${key} in ${localPath} — headless /code-review running, this takes a few minutes`);

  const env: Record<string, string | undefined> = { ...process.env };
  if (ctx.cfg.claude_config_dir) env.CLAUDE_CONFIG_DIR = ctx.cfg.claude_config_dir;
  const p = Bun.spawnSync(
    [
      claudeBin(ctx.cfg), "-p", reviewPrompt(number, note),
      "--output-format", "json", "--permission-mode", "dontAsk",
      "--allowedTools", ALLOWED_TOOLS,
    ],
    { cwd: localPath, env: env as Record<string, string>, stderr: "pipe" },
  );
  appendFileSync(ctx.paths.logPath, p.stderr.toString());

  let sessionId = "";
  if (p.exitCode === 0) {
    try {
      sessionId = JSON.parse(p.stdout.toString()).session_id ?? "";
    } catch {
      // non-JSON output → treated as failure below
    }
  }

  if (sessionId) {
    updateEntry(statePath, key, () => ({
      status: "ready", session_id: sessionId, title, url,
      local_path: localPath, updated_at: timestamp(),
    }));
    ctx.log(`READY ${key} session=${sessionId} — run \`reviews\` to open it`);
    await notify(enabled, `Review ready: ${key}`, title);
    ctx.counters.reviewed++;
  } else {
    updateEntry(statePath, key, () => ({
      status: "failed", title, url, local_path: localPath,
      error: "claude run failed, see auto-review.log", updated_at: timestamp(),
    }));
    ctx.log(`FAILED ${key} — retry with: reviews retry ${key}`);
    await notify(enabled, `Review FAILED: ${key}`, title);
    ctx.counters.failed++;
  }
  ctx.current.key = "";
}
```

- [ ] **Step 4: Add `reconcileOrphans` to `src/state.ts`**

Append to `src/state.ts` (needs `import type { Logger } from "./log";` at the top):

```ts
export function reconcileOrphans(statePath: string, log: Logger): void {
  const s = loadState(statePath);
  for (const [key, e] of Object.entries(s)) {
    if (e.status !== "reviewing") continue;
    setStatus(statePath, key, "failed", "previous run died mid-review");
    log(`ORPHAN ${key}: previous run died mid-review, marked failed — retry with: reviews retry ${key}`);
  }
}
```

- [ ] **Step 5: Wire the bootstrap and both commands into `src/main.ts`**

Add below the `commands` declaration:

```ts
import { ConfigError, ghBin, loadConfig, paths as resolvePaths } from "./config";
import { prView } from "./github";
import { makeLogger } from "./log";
import { acquireLock } from "./lock";
import { reviewPr, type Ctx } from "./reviewer";
import {
  ensureState, loadState, normalizeKey, reconcileOrphans, setStatus, splitKey,
} from "./state";

async function withCtx(fn: (ctx: Ctx) => Promise<number>): Promise<number> {
  const paths = resolvePaths();
  let cfg;
  try {
    cfg = await loadConfig(paths);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  ensureState(paths.statePath);
  const log = makeLogger(paths.logPath);
  const ctx: Ctx = {
    cfg, paths, log,
    gh: { gh: ghBin(), log, logPath: paths.logPath },
    counters: { reviewed: 0, failed: 0, skipped: 0, synced: 0 },
    current: { key: "" },
  };
  return fn(ctx);
}

async function runLocked(ctx: Ctx, fn: () => Promise<number>): Promise<number> {
  const release = acquireLock(ctx.paths.lockDir, ctx.log);
  if (!release) return 0; // another live run holds the lock (bash exits 0 here)
  const onSignal = () => {
    if (ctx.current.key) {
      setStatus(ctx.paths.statePath, ctx.current.key, "canceled", "run interrupted");
      ctx.log(`CANCELED ${ctx.current.key} (interrupted) — retry with: reviews retry ${ctx.current.key}`);
    } else {
      ctx.log("canceled (interrupted)");
    }
    release();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    reconcileOrphans(ctx.paths.statePath, ctx.log);
    return await fn();
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

commands["review"] = (args) =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
      const raw = args[0];
      if (!raw) {
        console.error("usage: reviews review ORG/REPO#NUM|URL [note]");
        return 1;
      }
      let key: string;
      try {
        key = normalizeKey(raw);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      const { repo, number } = splitKey(key);
      const info = prView<{ title?: string; url?: string }>(ctx.gh, repo, number, "title,url");
      if (!info) {
        console.error(`cannot fetch ${key} from GitHub (does the PR exist?)`);
        return 1;
      }
      await reviewPr(ctx, key, repo, number, info.title ?? "", info.url ?? "", args[1]);
      return 0;
    }),
  );

commands["retry"] = (args) =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
      const raw = args[0];
      if (!raw) {
        console.error("usage: reviews retry ORG/REPO#NUM [note]");
        return 1;
      }
      let key: string;
      try {
        key = normalizeKey(raw);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      const entry = loadState(ctx.paths.statePath)[key];
      if (!entry) {
        console.error(`unknown key: ${key}`);
        return 1;
      }
      const { repo, number } = splitKey(key);
      await reviewPr(ctx, key, repo, number, entry.title ?? "", entry.url ?? "", args[1]);
      return 0;
    }),
  );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/review.test.ts`
Expected: 6 pass. Then run the whole suite: `bun test` — everything from Tasks 1–5 must still pass.

- [ ] **Step 7: Commit**

```bash
git add src/reviewer.ts src/state.ts src/main.ts tests/review.test.ts
git commit -m "feat: headless review runs + review/retry commands, lock + interrupt handling"
```

---

### Task 7: sync.ts — GitHub reconciliation + `sync` command

Ports `reconcile()` (bash lines 118–170). The verdict computation — a dense jq program in bash — becomes a pure, unit-testable function.

**Files:**
- Create: `src/sync.ts`, `tests/sync.test.ts`
- Modify: `src/main.ts` (register `sync`)

**Interfaces:**
- Consumes: `Ctx`, `removeWorktree` (Task 6); `ghUser`, `prView` (Task 5); state helpers (Task 3).
- Produces:
  - `interface PrSyncInfo { state: string; latestReviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[]; reviewRequests?: { login?: string }[]; commits?: { committedDate?: string }[] }`
  - `type SyncDecision = { kind: "unchanged" } | { kind: "done"; reason: "merged" | "closed" } | { kind: "reviewed"; verdict: Verdict; reviewedAt: string; flags: string[] }`
  - `decideSync(info: PrSyncInfo, me: string): SyncDecision` — pure
  - `reconcile(ctx: Ctx): void` — updates state + `ctx.counters.synced`; never launches reviews

- [ ] **Step 1: Write the failing tests**

`tests/sync.test.ts`:

```ts
import { expect, test } from "bun:test";
import { decideSync } from "../src/sync";
import { makeSandbox } from "./harness";

test("decideSync: merged/closed/no-review/verdicts/flags", () => {
  expect(decideSync({ state: "MERGED" }, "me")).toEqual({ kind: "done", reason: "merged" });
  expect(decideSync({ state: "CLOSED" }, "me")).toEqual({ kind: "done", reason: "closed" });
  expect(decideSync({ state: "OPEN" }, "me")).toEqual({ kind: "unchanged" });
  expect(
    decideSync(
      { state: "OPEN", latestReviews: [{ author: { login: "other" }, state: "APPROVED", submittedAt: "t" }] },
      "me",
    ),
  ).toEqual({ kind: "unchanged" });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [{ author: { login: "me" }, state: "CHANGES_REQUESTED", submittedAt: "2026-07-19T10:00:00Z" }],
        reviewRequests: [{ login: "me" }],
        commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
      },
      "me",
    ),
  ).toEqual({
    kind: "reviewed", verdict: "changes-requested",
    reviewedAt: "2026-07-19T10:00:00Z", flags: ["re-requested", "new-commits"],
  });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [{ author: { login: "me" }, state: "APPROVED", submittedAt: "2026-07-19T13:00:00Z" }],
        reviewRequests: [],
        commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
      },
      "me",
    ),
  ).toEqual({ kind: "reviewed", verdict: "approved", reviewedAt: "2026-07-19T13:00:00Z", flags: [] });
});

test("sync command: scenarios 13-15", () => {
  const sb = makeSandbox();
  const ready = {
    "testorg/demo#7": {
      status: "ready", session_id: "sess-1234", title: "Demo PR", url: "u",
      local_path: sb.demoRepo, updated_at: "2026-01-01T00:00:00Z",
    },
  };
  sb.writeState(ready);

  // scenario 13: verdict recorded, both flags, session kept, claude never called
  const before = sb.claudeCalls();
  let r = sb.run(["sync"], {
    GH_PR_STATUS_JSON: JSON.stringify({
      state: "OPEN",
      latestReviews: [{ author: { login: "testuser" }, state: "CHANGES_REQUESTED", submittedAt: "2026-07-19T10:00:00Z" }],
      reviewRequests: [{ login: "testuser" }],
      commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
    }),
  });
  expect(r.code).toBe(0);
  let e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("changes-requested");
  expect(e.flags).toEqual(["re-requested", "new-commits"]);
  expect(e.session_id).toBe("sess-1234");
  expect(sb.claudeCalls()).toBe(before);

  // scenario 14: plain approval clears flags
  r = sb.run(["sync"], {
    GH_PR_STATUS_JSON: JSON.stringify({
      state: "OPEN",
      latestReviews: [{ author: { login: "testuser" }, state: "APPROVED", submittedAt: "2026-07-19T13:00:00Z" }],
      reviewRequests: [],
      commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
    }),
  });
  expect(r.code).toBe(0);
  e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("approved");
  expect(e.flags).toEqual([]);

  // scenario 15: gh failure leaves the entry untouched
  r = sb.run(["sync"], { GH_PR_VIEW_FAIL: "1" });
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#7"].status).toBe("approved");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/sync.test.ts`
Expected: FAIL — `src/sync.ts` missing.

- [ ] **Step 3: Write `src/sync.ts`**

```ts
import { ghUser, prView } from "./github";
import { removeWorktree, type Ctx } from "./reviewer";
import { loadState, markDone, markReviewed, splitKey, type Verdict } from "./state";

export interface PrSyncInfo {
  state: string;
  latestReviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
  reviewRequests?: { login?: string }[];
  commits?: { committedDate?: string }[];
}

export type SyncDecision =
  | { kind: "unchanged" }
  | { kind: "done"; reason: "merged" | "closed" }
  | { kind: "reviewed"; verdict: Verdict; reviewedAt: string; flags: string[] };

export function decideSync(info: PrSyncInfo, me: string): SyncDecision {
  if (info.state === "MERGED") return { kind: "done", reason: "merged" };
  if (info.state === "CLOSED") return { kind: "done", reason: "closed" };
  const rev = (info.latestReviews ?? []).find((r) => r.author?.login === me);
  if (!rev) return { kind: "unchanged" };
  const verdict = (rev.state ?? "").toLowerCase().replaceAll("_", "-") as Verdict;
  const flags: string[] = [];
  if ((info.reviewRequests ?? []).some((r) => r.login === me)) flags.push("re-requested");
  const lastCommit = (info.commits ?? []).at(-1)?.committedDate ?? "";
  if (lastCommit > (rev.submittedAt ?? "")) flags.push("new-commits");
  return { kind: "reviewed", verdict, reviewedAt: rev.submittedAt ?? "", flags };
}

export function reconcile(ctx: Ctx): void {
  const { statePath } = ctx.paths;
  const active = Object.entries(loadState(statePath)).filter(
    ([, e]) => e.status !== "done" && e.status !== "reviewing",
  );
  if (active.length === 0) return;

  const me = ghUser(ctx.gh);
  if (!me) {
    ctx.log("sync: cannot resolve GitHub login, skipping");
    return;
  }

  for (const [key, entry] of active) {
    const { repo, number } = splitKey(key);
    const info = prView<PrSyncInfo>(
      ctx.gh, repo, number, "state,latestReviews,reviewRequests,commits",
    );
    if (!info) {
      ctx.log(`SYNC ${key}: gh pr view failed, leaving entry as-is`);
      continue;
    }
    const d = decideSync(info, me);
    if (d.kind === "done") {
      markDone(statePath, key, d.reason);
      removeWorktree(ctx, key, "SYNC");
      ctx.log(`SYNC ${key}: PR ${d.reason} — marked done`);
      ctx.counters.synced++;
    } else if (d.kind === "reviewed") {
      const cur = `${entry.status} ${(entry.flags ?? []).join(" ")}`;
      const next = `${d.verdict} ${d.flags.join(" ")}`;
      if (cur !== next) {
        markReviewed(statePath, key, d.verdict, d.reviewedAt, d.flags);
        ctx.log(`SYNC ${key}: you reviewed (${d.verdict})${d.flags.length ? ` [${d.flags.join(" ")}]` : ""}`);
        ctx.counters.synced++;
      }
    }
  }
}
```

- [ ] **Step 4: Register the `sync` command in `src/main.ts`**

```ts
import { reconcile } from "./sync";

commands["sync"] = () =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
      reconcile(ctx);
      ctx.log(`sync complete: ${ctx.counters.synced} updated`);
      return 0;
    }),
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/sync.test.ts`
Expected: 2 pass (with all sub-assertions).

- [ ] **Step 6: Commit**

```bash
git add src/sync.ts src/main.ts tests/sync.test.ts
git commit -m "feat: GitHub reconciliation — verdicts, flags, merged/closed cleanup"
```

---

### Task 8: poll.ts — the poll cycle + `poll` command

Ports `fetch_candidates` + the `main()` poll loop (bash lines 245–298). After this task the new tool is a complete drop-in for `bin/auto-review`.

**Files:**
- Create: `src/poll.ts`, `tests/poll.test.ts`
- Modify: `src/main.ts` (register `poll`)

**Interfaces:**
- Consumes: `Ctx`, `reviewPr` (Task 6); `reconcile` (Task 7); `searchReviewRequests` (Task 5); state helpers (Task 3).
- Produces: `pollCycle(ctx: Ctx, dry: boolean): Promise<void>` — dry mode prints `would review: ${key} — ${title}` to stdout and never touches claude or entries.

- [ ] **Step 1: Write the failing integration tests**

`tests/poll.test.ts` (scenarios 1, 2, 3, 6, 12, 16):

```ts
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "./harness";

const lastLogLine = (sb: ReturnType<typeof makeSandbox>) =>
  readFileSync(sb.logPath, "utf8").trimEnd().split("\n").at(-1)!;

test("poll: dry-run, real run, dedup (scenarios 1-3)", () => {
  const sb = makeSandbox();

  // scenario 1: dry run lists non-draft only, writes no entries, no claude
  let r = sb.run(["poll", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would review: testorg/demo#7");
  expect(r.out).not.toContain("#8");
  expect(Object.keys(sb.state())).toHaveLength(0);
  expect(sb.claudeCalls()).toBe(0);

  // scenario 2: real run -> ready entry with session id + local path
  r = sb.run(["poll"]);
  expect(r.code).toBe(0);
  const e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("ready");
  expect(e.session_id).toBe("sess-1234");
  expect(e.local_path).toBe(sb.demoRepo);
  expect(sb.statusAtCall()).toBe("reviewing"); // entry was 'reviewing' while claude ran
  expect(sb.promptCapture()).toContain("worktree for PR #7 at .worktrees/pr-7");
  expect(sb.promptCapture()).toContain("/code-review 7");
  expect(lastLogLine(sb)).toContain("poll complete: 1 reviewed");

  // scenario 3: second run must not re-review a known PR
  r = sb.run(["poll"]);
  expect(r.code).toBe(0);
  expect(sb.claudeCalls()).toBe(1);
  expect(lastLogLine(sb)).toContain("poll complete: nothing new");
});

test("poll: orphaned reviewing entry becomes failed (scenario 6)", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#9": { status: "reviewing", title: "Orphan", url: "u", updated_at: "2026-01-01T00:00:00Z" },
  });
  expect(sb.run(["poll"]).code).toBe(0);
  const e = sb.state()["testorg/demo#9"];
  expect(e.status).toBe("failed");
  expect(e.error).toBeTruthy();
});

test("poll: unmapped repo is skipped and counted (scenario 12)", () => {
  const sb = makeSandbox();
  sb.writeConfig({ orgs: ["testorg"], repos: {} });
  expect(sb.run(["poll"]).code).toBe(0);
  expect(sb.state()["testorg/demo#7"].status).toBe("skipped");
  expect(lastLogLine(sb)).toContain("1 skipped");
});

test("poll reconciles too: merged -> done, worktree removed, no re-review (scenario 16)", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeState({
    "testorg/demo#7": {
      status: "ready", session_id: "sess-1234", title: "Demo PR", url: "u",
      local_path: sb.demoRepo, updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const before = sb.claudeCalls();
  const r = sb.run(["poll"], { GH_PR_STATUS_JSON: JSON.stringify({ state: "MERGED" }) });
  expect(r.code).toBe(0);
  const e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("done");
  expect(e.done_reason).toBe("merged");
  expect(existsSync(join(sb.demoRepo, ".worktrees", "pr-7"))).toBe(false);
  expect(sb.claudeCalls()).toBe(before);
  expect(lastLogLine(sb)).toContain("1 synced");
});
```

Note on scenario 16: the poll also re-discovers PR #7 from `gh search` after marking it done — but a `done` entry exists in state, so the dedup check skips it, same as bash. That is exactly what "no re-review" asserts.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/poll.test.ts`
Expected: FAIL — `poll` is an unknown subcommand.

- [ ] **Step 3: Write `src/poll.ts`**

```ts
import { searchReviewRequests } from "./github";
import { reviewPr, type Ctx } from "./reviewer";
import { loadState } from "./state";
import { reconcile } from "./sync";

export async function pollCycle(ctx: Ctx, dry: boolean): Promise<void> {
  if (!dry) reconcile(ctx);
  ctx.log(`polling ${ctx.cfg.orgs.join(", ")} for review requests`);

  for (const org of ctx.cfg.orgs) {
    for (const c of searchReviewRequests(ctx.gh, org)) {
      const key = `${c.repo}#${c.number}`;
      if (loadState(ctx.paths.statePath)[key]) continue; // known PR — never re-review
      if (dry) {
        console.log(`would review: ${key} — ${c.title}`);
      } else {
        await reviewPr(ctx, key, c.repo, String(c.number), c.title, c.url);
      }
    }
  }

  const { reviewed, failed, skipped, synced } = ctx.counters;
  if (dry) {
    ctx.log("poll complete (dry run)");
  } else if (reviewed + failed + skipped + synced === 0) {
    ctx.log("poll complete: nothing new");
  } else {
    ctx.log(`poll complete: ${reviewed} reviewed, ${failed} failed, ${skipped} skipped, ${synced} synced`);
  }
}
```

- [ ] **Step 4: Register the `poll` command in `src/main.ts`**

```ts
import { pollCycle } from "./poll";

commands["poll"] = (args) =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
      await pollCycle(ctx, args.includes("--dry-run"));
      return 0;
    }),
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/poll.test.ts`, then the full suite `bun test`.
Expected: all pass.

- [ ] **Step 6: Parity smoke test against the bash version (manual, read-only)**

With your real config present:

Run: `bash bin/auto-review --dry-run; bun src/main.ts poll --dry-run`
Expected: both list the same `would review:` keys. (Both are read-only; neither invokes claude.)

- [ ] **Step 7: Commit**

```bash
git add src/poll.ts src/main.ts tests/poll.test.ts
git commit -m "feat: poll cycle — discovery, dedup, dry-run, summary"
```

---

### Task 9: list.ts — interactive list, resume, `dismiss` command

Ports the fish frontend's core (list rendering, choice parsing, resume, dismiss). The interactive loop itself is thin; everything it does is a pure function or an already-tested state operation.

**Files:**
- Create: `src/list.ts`, `tests/list.test.ts`
- Modify: `src/main.ts` (bare command → interactive list; register `dismiss`)

**Interfaces:**
- Consumes: `pendingEntries`, `normalizeKey`, `splitKey`, `updateEntry`, `timestamp`, `loadState` (Task 3); `removeWorktree`, `Ctx` (Task 6); `claudeBin` (Task 2).
- Produces:
  - `renderList(s: State): { keys: string[]; lines: string[] }` — pure; line format matches fish: `%2d  %-32s [status +flag …]\t<title>\t<updated_at>`
  - `parseChoice(input: string, max: number): { action: "resume" | "dismiss" | "retry"; index: number } | "quit" | null` — `""`/`"q"` → `"quit"`; `d3`/`r3`/`3` → action+index; anything else or out-of-range → `null`
  - `buildResume(entry: Entry, cfg: Config): { argv: string[]; cwd: string; env: Record<string, string> } | { error: string }` — pure; errors: still `reviewing` → `"<wait>"` message, missing session/path → `"no session"` message (exact strings in the code below)
  - `dismissKey(ctx: Ctx, key: string): void` — status → `done`, remove worktree, print `dismissed ${key}`
  - `interactiveList(ctx: Ctx, retry: (key: string) => Promise<number>): Promise<number>` — the loop `main.ts` calls for the bare command; retry is injected as a callback (see Step 4's note)

- [ ] **Step 1: Write the failing tests**

`tests/list.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildResume, parseChoice, renderList } from "../src/list";
import { makeSandbox } from "./harness";

test("renderList formats pending entries in updated_at order", () => {
  const { keys, lines } = renderList({
    "acme/w#2": { status: "ready", title: "Two", updated_at: "2026-01-02T00:00:00Z" },
    "acme/w#1": {
      status: "changes-requested", title: "One", flags: ["re-requested", "new-commits"],
      updated_at: "2026-01-01T00:00:00Z",
    },
    "acme/w#3": { status: "done", title: "Gone", updated_at: "2026-01-03T00:00:00Z" },
  });
  expect(keys).toEqual(["acme/w#1", "acme/w#2"]);
  expect(lines[0]).toContain("[changes-requested +re-requested +new-commits]");
  expect(lines[0]).toContain("One");
  expect(lines[1]).toMatch(/^ 2  acme\/w#2/);
  expect(lines).toHaveLength(2);
});

test("parseChoice", () => {
  expect(parseChoice("", 5)).toBe("quit");
  expect(parseChoice("q", 5)).toBe("quit");
  expect(parseChoice("3", 5)).toEqual({ action: "resume", index: 2 });
  expect(parseChoice("d1", 5)).toEqual({ action: "dismiss", index: 0 });
  expect(parseChoice("r2", 5)).toEqual({ action: "retry", index: 1 });
  expect(parseChoice("6", 5)).toBeNull();
  expect(parseChoice("0", 5)).toBeNull();
  expect(parseChoice("dx", 5)).toBeNull();
  expect(parseChoice("banana", 5)).toBeNull();
});

test("buildResume guards and command construction", () => {
  const cfg = { orgs: [], repos: {}, claude_bin: "/x/claude", claude_config_dir: "/x/home" };
  expect(buildResume({ status: "reviewing", updated_at: "t" }, cfg)).toHaveProperty("error");
  expect(buildResume({ status: "failed", updated_at: "t" }, cfg)).toHaveProperty("error");
  const r = buildResume(
    { status: "ready", session_id: "s1", local_path: "/repo", updated_at: "t" },
    cfg,
  );
  expect(r).toEqual({
    argv: ["/x/claude", "--resume", "s1"],
    cwd: "/repo",
    env: { CLAUDE_CONFIG_DIR: "/x/home" },
  });
});

test("dismiss command marks done and removes the worktree", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeState({
    "testorg/demo#7": {
      status: "ready", session_id: "s", title: "Demo PR", url: "u",
      local_path: sb.demoRepo, updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const r = sb.run(["dismiss", "testorg/demo#7"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("dismissed testorg/demo#7");
  expect(sb.state()["testorg/demo#7"].status).toBe("done");
  expect(existsSync(join(sb.demoRepo, ".worktrees", "pr-7"))).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/list.test.ts`
Expected: FAIL — `src/list.ts` missing.

- [ ] **Step 3: Write `src/list.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { claudeBin, type Config } from "./config";
import { removeWorktree, type Ctx } from "./reviewer";
import {
  loadState, pendingEntries, timestamp, updateEntry, type Entry, type State,
} from "./state";

export function renderList(s: State): { keys: string[]; lines: string[] } {
  const pending = pendingEntries(s);
  const keys = pending.map(([k]) => k);
  const lines = pending.map(([key, e], i) => {
    const flags = (e.flags ?? []).map((f) => ` +${f}`).join("");
    const n = String(i + 1).padStart(2);
    return `${n}  ${key.padEnd(32)} [${e.status}${flags}]\t${e.title ?? ""}\t${e.updated_at}`;
  });
  return { keys, lines };
}

export function parseChoice(
  input: string,
  max: number,
): { action: "resume" | "dismiss" | "retry"; index: number } | "quit" | null {
  const t = input.trim();
  if (t === "" || t === "q") return "quit";
  const action = t.startsWith("d") ? "dismiss" : t.startsWith("r") ? "retry" : "resume";
  const num = action === "resume" ? t : t.slice(1);
  if (!/^\d+$/.test(num)) return null;
  const n = Number(num);
  if (n < 1 || n > max) return null;
  return { action, index: n - 1 };
}

export function buildResume(
  entry: Entry,
  cfg: Config,
): { argv: string[]; cwd: string; env: Record<string, string> } | { error: string } {
  if (entry.status === "reviewing") {
    return { error: "still being reviewed — wait for the notification, then rerun reviews" };
  }
  if (!entry.session_id || !entry.local_path) {
    return { error: `no session (${entry.status}) — use r# to (re)run the review` };
  }
  const env: Record<string, string> = {};
  if (cfg.claude_config_dir) env.CLAUDE_CONFIG_DIR = cfg.claude_config_dir;
  return {
    argv: [claudeBin(cfg), "--resume", entry.session_id],
    cwd: entry.local_path,
    env,
  };
}

export function dismissKey(ctx: Ctx, key: string): void {
  updateEntry(ctx.paths.statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status: "done",
    updated_at: timestamp(),
  }));
  removeWorktree(ctx, key, "DISMISS");
  console.log(`dismissed ${key}`);
}

function lockPid(ctx: Ctx): number | null {
  try {
    const pid = Number(readFileSync(join(ctx.paths.lockDir, "pid"), "utf8").trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function interactiveList(
  ctx: Ctx,
  retry: (key: string) => Promise<number>,
): Promise<number> {
  const state = loadState(ctx.paths.statePath);

  const pid = lockPid(ctx);
  if (pid !== null) {
    const current = Object.entries(state)
      .filter(([, e]) => e.status === "reviewing")
      .map(([k]) => k);
    console.log(
      current.length
        ? `⏳ poll running (pid ${pid}) — reviewing: ${current.join(", ")}`
        : `⏳ poll running (pid ${pid})`,
    );
  }

  const { keys, lines } = renderList(state);
  if (keys.length === 0) {
    console.log("No pending reviews.");
    return 0;
  }
  for (const line of lines) console.log(line);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("resume #  (d# dismiss, r# retry, q quit): ");
  rl.close();

  const choice = parseChoice(answer, keys.length);
  if (choice === "quit") return 0;
  if (choice === null) {
    console.error("bad choice");
    return 1;
  }
  const key = keys[choice.index]!;

  switch (choice.action) {
    case "dismiss":
      dismissKey(ctx, key);
      return 0;
    case "retry":
      return retry(key);
    case "resume": {
      const entry = loadState(ctx.paths.statePath)[key]!;
      const r = buildResume(entry, ctx.cfg);
      if ("error" in r) {
        console.error(`${key} ${r.error}`);
        return 1;
      }
      const p = Bun.spawn(r.argv, {
        cwd: r.cwd,
        env: { ...process.env, ...r.env } as Record<string, string>,
        stdio: ["inherit", "inherit", "inherit"],
      });
      return await p.exited;
    }
  }
}
```

- [ ] **Step 4: Wire the bare command and `dismiss` into `src/main.ts`**

Replace the `cmd === undefined` branch of `main()` (which currently prints usage) with the interactive list, and register `dismiss`:

```ts
import { dismissKey, interactiveList } from "./list";

// in main():
if (cmd === undefined)
  return withCtx((ctx) => interactiveList(ctx, (key) => commands["retry"]!([key])));
if (cmd === "-h" || cmd === "--help") return commands["help"]!([]);

commands["dismiss"] = (args) =>
  withCtx(async (ctx) => {
    const raw = args[0];
    if (!raw) {
      console.error("usage: reviews dismiss ORG/REPO#NUM");
      return 1;
    }
    let key: string;
    try {
      key = normalizeKey(raw);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    dismissKey(ctx, key);
    return 0;
  });
```

The retry action is injected as a callback rather than `list.ts` importing `main.ts` — importing the entry module from a module it is itself awaiting (its top-level `await main()`) would deadlock module evaluation.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/list.test.ts`, then `bun test`.
Expected: all pass. The interactive loop itself (readline prompt, resume spawn) is covered manually in Step 6 — its logic lives entirely in the pure functions already tested.

- [ ] **Step 6: Manual check of the interactive loop**

With your real state present:

Run: `bun src/main.ts`
Expected: same list the fish `reviews` shows; `q` exits cleanly; picking a ready entry opens the resumed claude session in the right clone (Ctrl+C out of it).

- [ ] **Step 7: Commit**

```bash
git add src/list.ts src/main.ts tests/list.test.ts
git commit -m "feat: interactive list, resume, dismiss"
```

---

### Task 10: status.ts — `status`, `log`, `watch` commands

**Files:**
- Create: `src/status.ts`, `tests/status.test.ts`
- Modify: `src/main.ts` (register the three commands)

**Interfaces:**
- Consumes: `loadState` (Task 3), `Ctx` (Task 6), `launchdLabel` — defined here, reused by Task 11: `` export const launchdLabel = () => `com.${userInfo().username}.auto-review` ``.
- Produces:
  - `stateCounts(s: State): string` — `"empty"` or `"2 ready, 1 failed"` (statuses alphabetical, matching jq `group_by`)
  - `statusCommand(ctx: Ctx): Promise<number>`, `logCommand(ctx: Ctx, n: number): Promise<number>`, `watchCommand(ctx: Ctx): Promise<number>`

- [ ] **Step 1: Write the failing tests**

`tests/status.test.ts`:

```ts
import { expect, test } from "bun:test";
import { stateCounts } from "../src/status";
import { makeSandbox } from "./harness";

test("stateCounts groups and sorts statuses", () => {
  expect(stateCounts({})).toBe("empty");
  expect(
    stateCounts({
      "a#1": { status: "ready", updated_at: "t" },
      "a#2": { status: "ready", updated_at: "t" },
      "a#3": { status: "failed", updated_at: "t" },
    }),
  ).toBe("1 failed, 2 ready");
});

test("log command prints the last n lines", () => {
  const sb = makeSandbox();
  sb.run(["poll", "--dry-run"]); // generates a few log lines
  sb.run(["poll", "--dry-run"]);
  const all = sb.run(["log", "50"]).out.trimEnd().split("\n");
  const two = sb.run(["log", "2"]).out.trimEnd().split("\n");
  expect(two).toHaveLength(2);
  expect(two).toEqual(all.slice(-2));
  expect(sb.run(["log"]).code).toBe(0); // default 20
});

test("status exits 0 and shows state counts even without launchd", () => {
  const sb = makeSandbox();
  sb.run(["poll", "--dry-run"]);
  const r = sb.run(["status"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("poller:");
  expect(r.out).toContain("state:");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/status.test.ts`
Expected: FAIL — `src/status.ts` missing.

- [ ] **Step 3: Write `src/status.ts`**

```ts
import { existsSync, readFileSync, statSync, watchFile } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./reviewer";
import { loadState, type State } from "./state";

export const launchdLabel = (): string => `com.${userInfo().username}.auto-review`;

export function stateCounts(s: State): string {
  const entries = Object.values(s);
  if (entries.length === 0) return "empty";
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}

function launchdLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  const p = Bun.spawnSync(
    ["launchctl", "print", `gui/${process.getuid!()}/${launchdLabel()}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  return p.exitCode === 0;
}

function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).slice(-n);
}

export async function statusCommand(ctx: Ctx): Promise<number> {
  console.log(
    launchdLoaded()
      ? "poller:  ON (launchd) — 'reviews off' to disable"
      : "poller:  OFF — 'reviews on' to enable, or run 'reviews poll' manually",
  );
  try {
    const pid = Number(readFileSync(join(ctx.paths.lockDir, "pid"), "utf8").trim());
    process.kill(pid, 0);
    console.log(`poll:    running right now (pid ${pid})`);
  } catch {
    // no live poll
  }
  console.log(`state:   ${stateCounts(loadState(ctx.paths.statePath))}`);
  console.log(`log:     last lines of ${ctx.paths.logPath}`);
  for (const line of tailLines(ctx.paths.logPath, 3)) console.log(`         ${line}`);
  return 0;
}

export async function logCommand(ctx: Ctx, n: number): Promise<number> {
  for (const line of tailLines(ctx.paths.logPath, n)) console.log(line);
  return 0;
}

export async function watchCommand(ctx: Ctx): Promise<number> {
  const path = ctx.paths.logPath;
  for (const line of tailLines(path, 10)) console.log(line);
  let offset = existsSync(path) ? statSync(path).size : 0;
  watchFile(path, { interval: 500 }, () => {
    const size = statSync(path).size;
    if (size < offset) offset = 0; // log rotated/truncated
    if (size > offset) {
      const fd = readFileSync(path, "utf8");
      process.stdout.write(fd.slice(offset));
      offset = size;
    }
  });
  return new Promise(() => {}); // runs until Ctrl+C
}
```

- [ ] **Step 4: Register the commands in `src/main.ts`**

```ts
import { logCommand, statusCommand, watchCommand } from "./status";

commands["status"] = () => withCtx((ctx) => statusCommand(ctx));
commands["log"] = (args) => withCtx((ctx) => logCommand(ctx, Number(args[0] ?? 20) || 20));
commands["watch"] = () => withCtx((ctx) => watchCommand(ctx));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/status.test.ts`, then `bun test`.
Expected: all pass. `watch` is verified manually: `bun src/main.ts watch` in one terminal, `bun src/main.ts poll --dry-run` in another — new lines stream; Ctrl+C exits.

- [ ] **Step 6: Commit**

```bash
git add src/status.ts src/main.ts tests/status.test.ts
git commit -m "feat: status, log, watch commands"
```

---

### Task 11: scheduler.ts — `on` / `off` (launchd)

Ports the `on`/`off` cases of `reviews.fish`. The plist template moves from `launchd.plist.template` into a TS function (the template file itself is deleted in Task 12). The rendered plist now runs `reviews poll` instead of bash.

**Files:**
- Create: `src/scheduler.ts`, `tests/scheduler.test.ts`
- Modify: `src/main.ts` (register `on`, `off`)

**Interfaces:**
- Consumes: `launchdLabel` (Task 10), `Ctx` (Task 6), `Config.poll_interval_minutes` (Task 2).
- Produces:
  - `renderPlist(o: { label: string; programArgs: string[]; interval: number; stateDir: string; home: string }): string` — pure
  - `pollProgramArgs(): string[]` — `[process.execPath, "poll"]` when compiled; `["bun's path", Bun.main, "poll"]` in dev (detected by `process.execPath` basename being `bun`)
  - `onCommand(ctx: Ctx): Promise<number>`, `offCommand(): Promise<number>`

- [ ] **Step 1: Write the failing tests**

`tests/scheduler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { renderPlist } from "../src/scheduler";

const plist = renderPlist({
  label: "com.me.auto-review",
  programArgs: ["/usr/local/bin/reviews", "poll"],
  interval: 900,
  stateDir: "/home/me/.local/state/auto-review",
  home: "/home/me",
});

test("renderPlist substitutes every field", () => {
  expect(plist).toContain("<string>com.me.auto-review</string>");
  expect(plist).toContain("<string>/usr/local/bin/reviews</string>");
  expect(plist).toContain("<string>poll</string>");
  expect(plist).toContain("<integer>900</integer>");
  expect(plist).toContain("/home/me/.local/state/auto-review/launchd.log");
  expect(plist).toContain("/home/me/.local/bin");
});

test.if(process.platform === "darwin")("rendered plist passes plutil -lint", () => {
  const p = Bun.spawnSync(["plutil", "-lint", "-"], { stdin: Buffer.from(plist) });
  expect(p.exitCode).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL — `src/scheduler.ts` missing.

- [ ] **Step 3: Write `src/scheduler.ts`**

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Ctx } from "./reviewer";
import { launchdLabel } from "./status";

export function renderPlist(o: {
  label: string;
  programArgs: string[];
  interval: number;
  stateDir: string;
  home: string;
}): string {
  const args = o.programArgs.map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${o.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key><integer>${o.interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${o.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${o.stateDir}/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${o.stateDir}/launchd.log</string>
</dict>
</plist>
`;
}

export function pollProgramArgs(): string[] {
  // dev: `bun src/main.ts` → execPath is the bun binary; compiled: it's `reviews`
  if (basename(process.execPath) === "bun") return [process.execPath, Bun.main, "poll"];
  return [process.execPath, "poll"];
}

const plistPath = (home: string) =>
  join(home, "Library", "LaunchAgents", `${launchdLabel()}.plist`);

export async function onCommand(ctx: Ctx): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("reviews on: only launchd (macOS) is supported for now");
    return 1;
  }
  const home = process.env.HOME!;
  const minutes = ctx.cfg.poll_interval_minutes ?? 15;
  const label = launchdLabel();
  const target = plistPath(home);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(ctx.paths.stateDir, { recursive: true });
  // machine-specific absolute paths — lives only in ~/Library/LaunchAgents
  writeFileSync(
    target,
    renderPlist({
      label,
      programArgs: pollProgramArgs(),
      interval: minutes * 60,
      stateDir: ctx.paths.stateDir,
      home,
    }),
  );
  if (Bun.spawnSync(["plutil", "-lint", target]).exitCode !== 0) {
    console.error("plist generation failed");
    rmSync(target, { force: true });
    return 1;
  }
  const uid = process.getuid!();
  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${label}`], { stderr: "ignore" });
  const boot = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, target], { stderr: "pipe" });
  if (boot.exitCode !== 0) {
    console.error(boot.stderr.toString());
    return boot.exitCode ?? 1;
  }
  console.log(`poller enabled as ${label} — polls every ${minutes} min (RunAtLoad fired one now)`);
  return 0;
}

export async function offCommand(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("reviews off: only launchd (macOS) is supported for now");
    return 1;
  }
  const home = process.env.HOME!;
  const label = launchdLabel();
  const uid = process.getuid!();
  const out = Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${label}`], { stderr: "ignore" });
  console.log(
    out.exitCode === 0
      ? "poller disabled — 'reviews on' re-enables, manual runs still work"
      : "poller was not loaded",
  );
  rmSync(plistPath(home), { force: true });
  return 0;
}
```

- [ ] **Step 4: Register the commands in `src/main.ts`**

```ts
import { offCommand, onCommand } from "./scheduler";

commands["on"] = () => withCtx((ctx) => onCommand(ctx));
commands["off"] = async () => offCommand();
```

(`off` deliberately skips `withCtx` — it must work even with a broken config, matching fish.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/scheduler.test.ts`, then `bun test`.
Expected: all pass.

- [ ] **Step 6: Manual launchd round-trip (does not disturb the old poller yet)**

Run: `bun src/main.ts on && bun src/main.ts status && bun src/main.ts off`
Expected: `on` loads the job (RunAtLoad fires one poll — with your real config this reviews real PRs; run it at a quiet moment or with everything already in state), `status` shows `poller: ON`, `off` unloads. Note: this replaces the old bash launchd job (same label) — that is intended; `reviews on`/`off` from fish would re-render it back until Task 12 flips the frontend.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts src/main.ts tests/scheduler.test.ts
git commit -m "feat: launchd on/off with embedded plist template"
```

---

### Task 12: Install, completions, README, migration, deletions

The cut-over: install builds and ships the binary, fish keeps only completions, the bash/fish implementation and its test suite are removed.

**Files:**
- Modify: `install.sh` (rewrite), `fish/reviews-completions.fish` (rewrite), `README.md` (rewrite), `.gitignore` (no change needed — `dist/` added in Task 1)
- Delete: `bin/auto-review`, `fish/reviews.fish`, `tests/tests.sh`, `launchd.plist.template`

- [ ] **Step 1: Rewrite `install.sh`**

```bash
#!/usr/bin/env bash
# Idempotent setup: checks deps, runs tests, builds the binary into
# ~/.local/bin, seeds config, links fish completions.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for dep in bun gh git; do
  command -v "$dep" >/dev/null || { echo "missing dependency: $dep" >&2; exit 1; }
done
command -v claude >/dev/null || echo "warning: claude CLI not found on PATH (needed at runtime)" >&2

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/auto-review"
mkdir -p "$CONFIG_DIR" "$HOME/.local/bin" "$HOME/.config/fish/completions"

(cd "$HERE" && bun install && bun test && bun run build)
install -m 755 "$HERE/dist/reviews" "$HOME/.local/bin/reviews"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$HERE/config.example.json" "$CONFIG_DIR/config.json"
  echo "seeded $CONFIG_DIR/config.json — edit it before enabling the poller"
fi

# the old fish *function* would shadow the binary — remove its symlink
rm -f "$HOME/.config/fish/functions/reviews.fish"
ln -sf "$HERE/fish/reviews-completions.fish" "$HOME/.config/fish/completions/reviews.fish"

echo "install complete — make sure ~/.local/bin is on PATH,"
echo "edit $CONFIG_DIR/config.json, then 'reviews on'"
```

- [ ] **Step 2: Rewrite `fish/reviews-completions.fish`**

```fish
# Tab completions for the reviews binary.
# Symlinked to ~/.config/fish/completions/reviews.fish (fish autoloads it there).
complete -c reviews -f
complete -c reviews -n __fish_use_subcommand -a poll -d 'one poll cycle (--dry-run to preview)'
complete -c reviews -n __fish_use_subcommand -a sync -d 'refresh entries from GitHub'
complete -c reviews -n __fish_use_subcommand -a review -d 'force-review a PR (key or URL)'
complete -c reviews -n __fish_use_subcommand -a retry -d 're-run a failed review'
complete -c reviews -n __fish_use_subcommand -a dismiss -d 'mark done + remove worktree'
complete -c reviews -n __fish_use_subcommand -a status -d 'poller state, live poll, state counts'
complete -c reviews -n __fish_use_subcommand -a log -d 'last N log lines (default 20)'
complete -c reviews -n __fish_use_subcommand -a watch -d 'follow the log live'
complete -c reviews -n __fish_use_subcommand -a on -d 'enable the launchd poller'
complete -c reviews -n __fish_use_subcommand -a off -d 'disable the launchd poller'
complete -c reviews -n __fish_use_subcommand -a help -d 'show usage'
```

- [ ] **Step 3: Run the installer and do the side-by-side parity check**

Run: `./install.sh`
Expected: tests pass, binary lands in `~/.local/bin/reviews`, completions linked, old function symlink gone. Then, with your real config (all read-only):

```bash
reviews poll --dry-run          # same 'would review' list as bash bin/auto-review --dry-run
reviews status                  # same picture as the old 'reviews status'
reviews                         # same list as the old fish 'reviews'; q to quit
reviews sync                    # verdicts/flags match GitHub, log shows 'sync complete'
```

Then flip the poller to the binary: `reviews on` (renders the plist pointing at `~/.local/bin/reviews poll`) and confirm the next poll logs normally: `reviews watch`.

- [ ] **Step 4: Commit the install/completions cut-over**

```bash
git add install.sh fish/reviews-completions.fish
git commit -m "feat: install builds the reviews binary; completions for the new CLI"
```

- [ ] **Step 5: Rewrite `README.md`**

Keep the existing structure (What it is / Requirements / Setup / Day to day / How it works) with these content changes:

- Requirements: macOS (launchd + osascript), `bun`, `gh` (authenticated), the `claude` CLI, a local clone of every repo you review. **Drop `jq` and `fish`** (fish only needed for completions).
- Setup: `./install.sh` builds and installs the `reviews` binary; step 3 becomes `reviews poll --dry-run`; the state-seeding tip stays (jq example may stay — it's a user-side convenience, not a dependency).
- Day to day: replace `bash bin/auto-review --review …` with `reviews review …`; add `reviews dismiss`; everything else keeps its name.
- How it works: same lifecycle paragraph; replace `bin/auto-review` references with `reviews poll`; replace `tests/tests.sh` with `bun test` ("fully mocked — no network, no tokens").
- Add a short Development section: `bun test`, `bun run dev`, `bun run build`.

- [ ] **Step 6: Commit the README**

```bash
git add README.md
git commit -m "docs: README for the reviews binary"
```

- [ ] **Step 7: Delete the old implementation**

Only after Step 3's parity check succeeded:

```bash
git rm bin/auto-review fish/reviews.fish tests/tests.sh launchd.plist.template
git commit -m "chore: remove bash/fish implementation, superseded by the reviews binary"
```

- [ ] **Step 8: Final verification**

Run: `bun test && bun run build && ~/.local/bin/reviews help`
Expected: full suite green, binary rebuilds, help prints. `reviews status` shows the poller ON and polling on schedule.

---

## Deferred (explicitly out of scope, per spec)

- Linux support: systemd user timer in `scheduler.ts`, `notify-send` in `notify.ts` — the only two files that change.
- Homebrew: GitHub Actions release workflow cross-compiling `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` / `bun-linux-arm64` + a personal tap formula.
