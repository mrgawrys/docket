# Claude auth visibility — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it gets built).
> Ask the user which; don't pick for them.

## The problem

A logged-out `claude` fails every review, and docket says nothing useful about
it. Observed on 2026-08-17: `Recruitee/recruitee#20090` failed twice in four
seconds each, and the panel showed

    Failed to authenticate: OAuth session expired and could not be refreshed

as dim text in the slot where a review verdict goes — the `claude` CLI's own
message, passed through unlabelled, with no next step.

Three things made it hard to diagnose:

- **`docket doctor` passes while every review fails.** Its only claude check is
  `claude --version` (`src/doctor.ts:137`), which is credential-blind. The repo
  rule says: if doctor can pass while a fresh install still fails, doctor is
  wrong.
- **The account is invisible.** This machine runs two Claude accounts selected
  by `CLAUDE_CONFIG_DIR` — a fish `--on-variable PWD` hook picks
  `~/.claude-personal` under personal roots and the work account at `~/.claude`
  everywhere else. docket pins `"claude_config_dir": "/Users/gawrys/.claude"`.
  Debugging from the docket checkout (a personal root) probes the *other*
  account, which reports healthy.
- **The poller silently burns the queue.** `src/poll.ts:41` skips any PR that
  already has a state entry (`if (known[key]) continue`). An auth outage writes
  a `failed` entry for every PR that arrives during it, and those PRs are then
  never reviewed again without a manual `docket retry`.

## Scope

Auth failures only. A general classifier for "the runner died before having an
opinion" — rate limits, API outages, missing plugins — was considered and cut.
Other failure modes keep behaving as they do today.

The poller gets a pre-flight check. Manual `docket review` / `docket retry`
do not: the user is at the terminal and sees the failure immediately.

## Design

### `src/auth.ts` — the probe

```ts
export type AuthState =
  | { ok: true }
  | { ok: false; dir: string }   // definitively logged out
  | { unknown: string };         // probe couldn't answer — reason

export function claudeAuth(cfg: Config, run = defaultRun): AuthState;
```

Spawns `[claudeBin(cfg), "auth", "status"]` with `claudeEnv(cfg)` — the same
binary and env `startReview` uses, so the probe cannot drift from what the
review actually runs — parses stdout as JSON and reads `loggedIn`.

`loggedIn: true` → `ok`. `loggedIn: false` → logged out. Anything else (spawn
failure, non-JSON, field absent) → `unknown` with a short reason.

Two deliberate non-behaviours:

- **It does not branch on `authMethod`.** Verified against the real CLI:
  `loggedIn` is already correct for every provider.

  | env | output |
  |---|---|
  | OAuth, logged out | `loggedIn: false, authMethod: "none"` |
  | `ANTHROPIC_API_KEY` | `loggedIn: true, authMethod: "api_key"` |
  | `CLAUDE_CODE_USE_BEDROCK=1` | `loggedIn: true, authMethod: "third_party"` |
  | nonexistent config dir | `loggedIn: false` |

- **It does not read the exit code.** `claude auth status` exits 0 whether or
  not you are logged in, so the `runs([...]).ok` pattern doctor uses for
  `gh auth status` (`src/doctor.ts:118`) would report a logged-out account as
  healthy.

`dir` is `cfg.claude_config_dir || ~/.claude` — the same `||` resolution
`claudeEnv` and doctor's plugin check already use, so messages can name which
account they mean.

### `docket doctor` — the check

Placed immediately after the existing `claude: … runs` check, and only when
that one passed:

```ts
const auth = claudeAuth(cfg);
if ("unknown" in auth) {
  fail(`claude auth: could not determine (${auth.unknown})`,
       "upgrade Claude Code — 'claude auth status' is how docket checks this");
} else if (!auth.ok) {
  fail(`claude auth: not logged in (${auth.dir})`,
       `run: CLAUDE_CONFIG_DIR=${auth.dir} claude auth login`);
} else {
  pass(`claude auth: logged in (${auth.dir})`);
}
```

The hint is copy-pasteable and names the config dir, so a two-account machine
gets the command for the account docket actually uses. The `pass` line names
the dir too — a green doctor should say *which* account it is green for.

Accepted trade-off: `unknown` is a ✗, so a `claude` too old for `auth status`
shows a failing check clearable only by upgrading. Doctor has pass/fail only,
and a third severity level is more machinery than this case earns.

### `pollCycle` — the pre-flight

After `reconcile(ctx)` (syncing known PRs is harmless without auth) and before
the search loop:

```ts
const auth = claudeAuth(ctx.cfg);
if ("unknown" in auth) {
  ctx.log(`auth check inconclusive (${auth.unknown}) — polling anyway`);
} else if (!auth.ok) {
  ctx.log(`poll aborted: claude is not logged in (${auth.dir}) — run: docket doctor`);
  await notify(ctx.cfg, "docket: claude is not logged in", "run docket doctor");
  return;
}
```

Fails open: `unknown` logs and carries on, so a broken probe is never worse
than today's behaviour. A definite logout returns before any `startReview`, so
no state entries are written and every waiting PR resurfaces on the next cycle
once auth is restored.

The notification is not optional decoration — a 15-minute background poller
failing silently is how the original incident went unnoticed.

### `src/list.ts` — the message

```ts
-    return { error: `no session (${entry.status}) — r (re)runs the review` };
+    return {
+      error: `no session (${entry.status}) — r retries, docket doctor checks your setup`,
+    };
```

This is the line the panel already showed; it now points somewhere. The
`no session (failed)` prefix that `tests/tui.test.tsx:142` asserts on survives.

`Entry.error` stays as it is — written at `src/reviewer.ts:386`, read by
nothing. Reviving it means classifying failures, which is out of scope.

## Testing

Seams the tests exercise:

- **`claudeAuth(cfg, run)`** — the injected runner, matching how
  `resolveOpeners` takes `resolve`. Cases: logged in, logged out, non-JSON
  output, spawn failure, `loggedIn` absent. Plus a pass-through case asserting
  `claude_bin`, `claude_config_dir` and `claude_env` all reach the spawned
  command — this is what keeps the probe honest about what the review will run.
- **`doctorCommand`** (`tests/doctor.test.ts`, existing sandbox pattern) — the
  logged-out case produces the ✗ line, and the hint contains the config dir.
- **`pollCycle`** (`tests/poll.test.ts`) — logged out means zero state entries
  written, zero review runs, abort logged. This is the regression test for the
  burn-the-queue bug.

**Harness change, required.** The `claude` shim in `tests/harness.ts` falls
through to the review path for any argv other than `--version`, so a bare
`auth status` would log a call and inflate `sb.claudeCalls()`. It needs an
early branch mirroring the `gh` shim's `auth status` branch, with a
`CLAUDE_LOGGED_OUT` knob, returning the JSON and exiting *without* recording a
call.

No TUI component test for the `list.ts` string — a one-line message is exactly
what the repo's thin-TUI-tests rule excludes.

## Docs

Required by the rule that doctor and README move together:

- **README** line 33, the bullet listing the `claude` CLI — say it must be
  logged in, and that the account is per `claude_config_dir`.
- **`docs/configuration.md`**, under `claude_config_dir` — a sentence that auth
  lives per config dir, so pointing docket at a second dir means logging in
  there too.
