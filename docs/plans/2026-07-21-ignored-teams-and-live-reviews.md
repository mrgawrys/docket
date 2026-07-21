# Ignored Teams Filter + Live Review Watch/Kill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip PRs that only reach the review queue via an ignored GitHub team, and make running reviews watchable and killable from `reviews`.

**Architecture:** Feature 1 adds two `gh` helpers (`reviewRequesters`, `myTeams`), a pure decision function `skipVia`, and wires them into `pollCycle` behind a new optional `ignored_teams` config key — skipped PRs get **no state entry** so a later direct request resurfaces them. Feature 2 switches the detached runner from buffered `--output-format json` to `stream-json`, teeing stdout line-by-line into a per-PR run log under the state dir; the interactive list gains `w#` (watch, pretty-rendered follow) and `k#` (SIGTERM the runner, whose existing signal handler marks the entry `canceled`).

**Tech Stack:** Bun + TypeScript, `bun test` with the shim-based sandbox in `tests/harness.ts`. No new dependencies.

**Spec:** `docs/specs/2026-07-21-ignored-teams-and-live-reviews-design.md`

## Global Constraints

- No new dependencies; Bun built-ins and `node:` modules only.
- Placeholder names only in anything committed (`your-github-org/some-team`) — the user's real org/team names must never appear in code, examples, tests, or docs.
- Fail open: any failed GitHub call in the team filter means the PR **is** reviewed. Never silently drop a PR.
- All background/poller diagnostics go through `ctx.log(...)` (they land in `auto-review.log`); user-facing CLI output uses `console.log`/`console.error`.
- Test style: pure functions get direct unit tests; CLI behavior goes through `makeSandbox()` + shims. Detached runners finish after the CLI returns — use `sb.waitEntry`.
- Run `bun test` after every task; commit after every green task.

## File Map

| File | Change |
|---|---|
| `src/github.ts` | add `ReviewRequesters`, `reviewRequesters()`, `myTeams()` |
| `src/poll.ts` | add `skipVia()`; wire filter into `pollCycle` |
| `src/config.ts` | `ignored_teams?: string[]` on `Config`; add `runLogPath()` |
| `src/reviewer.ts` | stream-json runner writing the run log; `removeWorktree` → `cleanupEntry` (also deletes run log) |
| `src/runlog.ts` | **new** — `renderRunEvent()`, `followRunLog()` |
| `src/list.ts` | `w#`/`k#` in `parseChoice`; `killEntry()`; wire both into `interactiveList`; `buildResume` message |
| `src/status.ts` | `watchCommand(ctx, rawKey?)` — follow one PR's run log |
| `src/main.ts` | pass arg to `watch`; USAGE text |
| `src/sync.ts` | rename callsite `removeWorktree` → `cleanupEntry` |
| `tests/harness.ts` | gh shim: `user/teams` + `reviewRequests` branches; claude shim: stream events |
| `tests/{github,poll,review,list,status}.test.ts`, `tests/runlog.test.ts` | per-task tests |
| `config.example.json`, `README.md` | document both features |

---

### Task 1: `reviewRequesters` + `myTeams` gh helpers

**Files:**
- Modify: `src/github.ts`
- Modify: `tests/harness.ts` (gh shim)
- Test: `tests/github.test.ts`

**Interfaces:**
- Consumes: existing `gh()` (private) and `prView()` in `src/github.ts`.
- Produces:
  - `interface ReviewRequesters { users: string[]; teams: string[] }` — `teams` are org-qualified slugs exactly as `gh` returns them (e.g. `acme/some-team`).
  - `reviewRequesters(ctx: GhCtx, repo: string, number: string): ReviewRequesters | null` — null on any gh/parse failure.
  - `myTeams(ctx: GhCtx): string[] | null` — org-qualified slugs of the authenticated user's teams; null on failure.

- [ ] **Step 1: Extend the gh shim in `tests/harness.ts`**

Inside the `GH_SHIM` template literal, add a `user/teams` branch directly after the existing `api user` branch (note `\${` escaping — this is a TS template literal):

```bash
if [ "$1" = api ] && [ "$2" = user/teams ]; then
  [ "\${GH_TEAMS_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
  [ -n "\${GH_TEAMS_CALLS:-}" ] && echo t >>"\$GH_TEAMS_CALLS"
  printf '%s\n' "\${GH_USER_TEAMS:-}"
  exit 0
fi
```

And inside the existing `pr view` branch's `for a in "$@"` loop, add a second field match **after** the `*state*latestReviews*` block (the sync fields string contains `reviewRequests`, so exact match is required here):

```bash
    if [ "$a" = reviewRequests ]; then
      [ "\${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      json="\${GH_REVIEW_REQUESTS_JSON:-}"
      [ -n "$json" ] || json='{"reviewRequests":[]}'
      echo "$json"
      exit 0
    fi
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/github.test.ts` (also add `GH_REVIEW_REQUESTS_JSON`, `GH_USER_TEAMS`, `GH_TEAMS_FAIL` to the `afterEach` deletes):

```ts
test("reviewRequesters splits users and teams; null on gh failure", () => {
  process.env.GH_REVIEW_REQUESTS_JSON = JSON.stringify({
    reviewRequests: [
      { __typename: "User", login: "alice" },
      { __typename: "Team", name: "Some Team", slug: "acme/some-team" },
      { __typename: "Team", name: "Other", slug: "acme/other-team" },
    ],
  });
  expect(reviewRequesters(ctx, "testorg/demo", "7")).toEqual({
    users: ["alice"],
    teams: ["acme/some-team", "acme/other-team"],
  });
  process.env.GH_PR_VIEW_FAIL = "1";
  expect(reviewRequesters(ctx, "testorg/demo", "7")).toBeNull();
});

test("myTeams parses org/slug lines; empty when none; null on failure", () => {
  process.env.GH_USER_TEAMS = "acme/some-team\nacme/dev";
  expect(myTeams(ctx)).toEqual(["acme/some-team", "acme/dev"]);
  delete process.env.GH_USER_TEAMS;
  expect(myTeams(ctx)).toEqual([]);
  process.env.GH_TEAMS_FAIL = "1";
  expect(myTeams(ctx)).toBeNull();
});
```

Update the import line to include the new names:
`import { ghUser, myTeams, prView, reviewRequesters, searchReviewRequests, type GhCtx } from "../src/github";`

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/github.test.ts`
Expected: FAIL — `reviewRequesters`/`myTeams` not exported.

- [ ] **Step 4: Implement in `src/github.ts`**

```ts
export interface ReviewRequesters {
  users: string[];
  teams: string[]; // org-qualified slugs, e.g. "acme/some-team"
}

export function reviewRequesters(
  ctx: GhCtx,
  repo: string,
  number: string,
): ReviewRequesters | null {
  const info = prView<{
    reviewRequests?: Array<{ login?: string; slug?: string }>;
  }>(ctx, repo, number, "reviewRequests");
  if (!info?.reviewRequests) return null;
  const users: string[] = [];
  const teams: string[] = [];
  for (const r of info.reviewRequests) {
    if (r.login) users.push(r.login);
    else if (r.slug) teams.push(r.slug);
  }
  return { users, teams };
}

export function myTeams(ctx: GhCtx): string[] | null {
  const out = gh(ctx, [
    "api", "user/teams", "--paginate",
    "--jq", '.[] | .organization.login + "/" + .slug',
  ]);
  if (out === null) return null;
  return out.split("\n").filter(Boolean);
}
```

(`--jq` emits one `org/slug` line per team across all pages — avoids `--paginate`'s concatenated-arrays output.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/github.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
git add src/github.ts tests/harness.ts tests/github.test.ts
git commit -m "feat: gh helpers for review requesters and own team memberships"
```

---

### Task 2: `skipVia` decision function

**Files:**
- Modify: `src/poll.ts`
- Test: `tests/poll.test.ts`

**Interfaces:**
- Consumes: `ReviewRequesters` type from Task 1.
- Produces: `skipVia(login: string | null, requested: ReviewRequesters | null, memberOf: string[] | null, ignored: string[]): string[] | null` — the ignored teams responsible for the request if the PR should be skipped, else `null` (= review it).

- [ ] **Step 1: Write the failing tests**

Append to `tests/poll.test.ts` (add `import { skipVia } from "../src/poll";`):

```ts
test("skipVia: skips only when every requested team I belong to is ignored", () => {
  const ignored = ["acme/ignored-team"];
  const member = ["acme/ignored-team", "acme/dev"];
  // requested solely via an ignored team I'm in -> skip, naming the team
  expect(
    skipVia("me", { users: [], teams: ["acme/ignored-team", "acme/other"] }, member, ignored),
  ).toEqual(["acme/ignored-team"]);
  // directly requested -> always review, even if ignored teams also match
  expect(
    skipVia("me", { users: ["me"], teams: ["acme/ignored-team"] }, member, ignored),
  ).toBeNull();
  // also in a requested team that is NOT ignored -> review
  expect(
    skipVia("me", { users: [], teams: ["acme/ignored-team", "acme/dev"] }, member, ignored),
  ).toBeNull();
  // no membership overlap with requested teams -> fail open, review
  expect(skipVia("me", { users: [], teams: ["acme/other"] }, member, ignored)).toBeNull();
  // missing data (failed API calls) -> fail open, review
  expect(skipVia("me", null, member, ignored)).toBeNull();
  expect(skipVia("me", { users: [], teams: ["acme/ignored-team"] }, null, ignored)).toBeNull();
  expect(skipVia(null, { users: [], teams: ["acme/ignored-team"] }, member, ignored)).toEqual([
    "acme/ignored-team",
  ]); // unknown login can't match a direct request, teams still decide
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/poll.test.ts`
Expected: FAIL — `skipVia` not exported.

- [ ] **Step 3: Implement in `src/poll.ts`**

```ts
// Should this candidate be skipped as "only requested via ignored teams"?
// Returns the responsible teams, or null to review. Missing data (a failed
// gh call, no membership overlap) fails open: the PR gets reviewed.
export function skipVia(
  login: string | null,
  requested: ReviewRequesters | null,
  memberOf: string[] | null,
  ignored: string[],
): string[] | null {
  if (!requested || !memberOf) return null;
  if (login && requested.users.includes(login)) return null;
  const mine = requested.teams.filter((t) => memberOf.includes(t));
  if (mine.length === 0) return null;
  return mine.every((t) => ignored.includes(t)) ? mine : null;
}
```

Import the type: `import { searchReviewRequests, type ReviewRequesters } from "./github";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/poll.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/poll.ts tests/poll.test.ts
git commit -m "feat: skipVia decides team-only review requests"
```

---

### Task 3: wire `ignored_teams` into the poll cycle

**Files:**
- Modify: `src/config.ts:3-11` (Config interface), `src/poll.ts` (pollCycle), `config.example.json`, `README.md`
- Test: `tests/poll.test.ts`

**Interfaces:**
- Consumes: `skipVia` (Task 2), `reviewRequesters`/`myTeams`/`ghUser` (Task 1), `Config`.
- Produces: config key `ignored_teams?: string[]`. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `tests/poll.test.ts`:

```ts
test("ignored_teams: team-only request is skipped with no state entry; direct request resurfaces it", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    ignored_teams: ["testorg/ignored-team"],
  });
  const teamOnly = JSON.stringify({
    reviewRequests: [{ __typename: "Team", slug: "testorg/ignored-team" }],
  });
  const env = { GH_USER_TEAMS: "testorg/ignored-team", GH_REVIEW_REQUESTS_JSON: teamOnly };

  // dry run announces the skip
  let r = sb.run(["poll", "--dry-run"], env);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would skip (via testorg/ignored-team): testorg/demo#7");
  expect(r.out).not.toContain("would review: testorg/demo#7");

  // real run: no entry written, no claude call, SKIP logged
  r = sb.run(["poll"], env);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#7"]).toBeUndefined();
  expect(sb.claudeCalls()).toBe(0);
  expect(readFileSync(sb.logPath, "utf8")).toContain(
    "SKIP testorg/demo#7: requested only via testorg/ignored-team",
  );

  // later direct request -> reviewed as usual
  const direct = JSON.stringify({
    reviewRequests: [
      { __typename: "User", login: "testuser" },
      { __typename: "Team", slug: "testorg/ignored-team" },
    ],
  });
  r = sb.run(["poll"], { ...env, GH_REVIEW_REQUESTS_JSON: direct });
  expect(r.code).toBe(0);
  await sb.waitEntry("testorg/demo#7", (e) => e.status === "ready");
});

test("ignored_teams: membership in a non-ignored requested team still reviews", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    ignored_teams: ["testorg/ignored-team"],
  });
  const r = sb.run(["poll"], {
    GH_USER_TEAMS: "testorg/ignored-team\ntestorg/other-team",
    GH_REVIEW_REQUESTS_JSON: JSON.stringify({
      reviewRequests: [
        { __typename: "Team", slug: "testorg/ignored-team" },
        { __typename: "Team", slug: "testorg/other-team" },
      ],
    }),
  });
  expect(r.code).toBe(0);
  await sb.waitEntry("testorg/demo#7", (e) => e.status === "ready");
});

test("ignored_teams: failed reviewRequests fetch fails open (PR reviewed)", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    ignored_teams: ["testorg/ignored-team"],
  });
  const r = sb.run(["poll"], {
    GH_USER_TEAMS: "testorg/ignored-team",
    GH_PR_VIEW_FAIL: "1",
  });
  expect(r.code).toBe(0);
  await sb.waitEntry("testorg/demo#7", (e) => e.status === "ready");
});

test("ignored_teams: membership fetched at most once per poll cycle", () => {
  const sb = makeSandbox();
  const calls = join(sb.tmp, "teams-calls");
  writeFileSync(calls, "");
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    ignored_teams: ["testorg/ignored-team"],
  });
  const searchJson = JSON.stringify([
    { number: 7, title: "A", url: "u", isDraft: false,
      repository: { nameWithOwner: "testorg/demo" } },
    { number: 21, title: "B", url: "u", isDraft: false,
      repository: { nameWithOwner: "testorg/demo" } },
  ]);
  const r = sb.run(["poll", "--dry-run"], {
    GH_SEARCH_JSON: searchJson,
    GH_TEAMS_CALLS: calls,
    GH_USER_TEAMS: "testorg/ignored-team",
    GH_REVIEW_REQUESTS_JSON: JSON.stringify({
      reviewRequests: [{ __typename: "Team", slug: "testorg/ignored-team" }],
    }),
  });
  expect(r.code).toBe(0);
  expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
});
```

Add `writeFileSync` and `join` to the imports at the top of `tests/poll.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/poll.test.ts`
Expected: the four new tests FAIL (PR #7 is reviewed / no skip output).

- [ ] **Step 3: Implement**

`src/config.ts` — add to the `Config` interface after `gh_account?`:

```ts
  ignored_teams?: string[];
```

`src/poll.ts` — full new `pollCycle` (imports: `import { ghUser, myTeams, reviewRequesters, searchReviewRequests, type ReviewRequesters } from "./github";`):

```ts
export async function pollCycle(ctx: Ctx, dry: boolean): Promise<void> {
  if (!dry) reconcile(ctx);
  ctx.log(`polling ${ctx.cfg.orgs.join(", ")} for review requests`);

  const ignored = ctx.cfg.ignored_teams ?? [];
  // membership is stable within a cycle — fetch it at most once, lazily
  let me: { login: string | null; teams: string[] | null } | null = null;

  for (const org of ctx.cfg.orgs) {
    for (const c of searchReviewRequests(ctx.gh, org)) {
      const key = `${c.repo}#${c.number}`;
      if (loadState(ctx.paths.statePath)[key]) continue; // known PR — never re-review
      if (ignored.length > 0) {
        me ??= { login: ghUser(ctx.gh), teams: myTeams(ctx.gh) };
        const req = reviewRequesters(ctx.gh, c.repo, String(c.number));
        const via = skipVia(me.login, req, me.teams, ignored);
        if (via) {
          // no state entry: a later direct request must resurface this PR
          if (dry) console.log(`would skip (via ${via.join(", ")}): ${key}`);
          else ctx.log(`SKIP ${key}: requested only via ${via.join(", ")}`);
          continue;
        }
      }
      if (dry) {
        console.log(`would review: ${key} — ${c.title}`);
      } else {
        await startReview(ctx, key, c.repo, c.title, c.url);
      }
    }
  }

  const { started, failed, skipped, synced } = ctx.counters;
  if (dry) {
    ctx.log("poll complete (dry run)");
  } else if (started + failed + skipped + synced === 0) {
    ctx.log("poll complete: nothing new");
  } else {
    ctx.log(`poll complete: ${started} started, ${failed} failed, ${skipped} skipped, ${synced} synced`);
  }
}
```

`config.example.json` — add after `"gh_account": ""`:

```json
  "ignored_teams": [],
```

`README.md` — add a bullet to the config list in Setup:

```markdown
   - `ignored_teams` — org-qualified team slugs (e.g.
     `your-github-org/some-team`). A PR that lands in your queue **only**
     because one of these teams was asked to review (CODEOWNERS or a manual
     team request) is skipped — nothing is recorded, so if someone later
     requests *you* directly the PR is picked up normally. A PR where you
     are requested personally, or via any team not listed here, is always
     reviewed. Empty = review everything.
```

And in "How it works", extend the first sentence:

```markdown
Each poll runs `gh search prs --review-requested=@me` per org, skips drafts,
already-known PRs, and PRs whose only route to you is a team in
`ignored_teams`, then hands each new PR to its own detached background
runner ...
```

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS (existing poll tests unaffected: with no `ignored_teams` the filter never runs).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/poll.ts config.example.json README.md tests/poll.test.ts
git commit -m "feat: ignored_teams config skips team-only review requests"
```

---

### Task 4: streaming runner — per-PR run log

**Files:**
- Modify: `src/config.ts`, `src/reviewer.ts:158-210` (execReview claude section)
- Modify: `tests/harness.ts` (claude shim)
- Test: `tests/review.test.ts`

**Interfaces:**
- Consumes: `Paths` from `src/config.ts`.
- Produces: `runLogPath(p: Paths, key: string): string` in `src/config.ts` — `<stateDir>/runs/<key with / and # replaced by ->.jsonl` (e.g. `testorg/demo#7` → `<stateDir>/runs/testorg-demo-7.jsonl`). The runner truncates it at start and appends claude's stream-json stdout as it arrives; the last line on success is the `{"type":"result",...,"session_id":...}` event.

- [ ] **Step 1: Make the claude shim emit stream events**

In `tests/harness.ts` `CLAUDE_SHIM`, insert an assistant event line directly after the `STATUS_AT_CALL` capture line (before the `CLAUDE_FAIL` check), keeping the final result line unchanged:

```bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at the diff"},{"type":"tool_use","name":"Bash","input":{"command":"git fetch origin"}}]}}'
```

With `CLAUDE_SLEEP`, the shim now emits the assistant line, sleeps, then emits the result line — that gap is what proves streaming.

- [ ] **Step 2: Write the failing test**

Append to `tests/review.test.ts` (add `import { existsSync, readFileSync } from "node:fs";` and `import { join } from "node:path";`):

```ts
test("runner streams progress into the run log while claude is still working", async () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#61": {
      status: "reviewing", title: "Slow", url: "u", local_path: sb.demoRepo,
      updated_at: new Date().toISOString(),
    },
  });
  const proc = sb.runAsync(["exec", "testorg/demo#61"], { CLAUDE_SLEEP: "2" });
  const runLog = join(sb.stateDir, "runs", "testorg-demo-61.jsonl");

  // assistant event must land in the run log before the run finishes
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(runLog) && readFileSync(runLog, "utf8").includes('"type":"assistant"')) break;
    await Bun.sleep(25);
  }
  expect(readFileSync(runLog, "utf8")).toContain('"type":"assistant"');
  expect(sb.state()["testorg/demo#61"].status).toBe("reviewing");

  await proc.exited;
  const e = await sb.waitEntry("testorg/demo#61", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234"); // parsed from the run log's result tail
  expect(readFileSync(runLog, "utf8")).toContain('"type":"result"');
});
```

- [ ] **Step 3: Run tests to verify the new one fails**

Run: `bun test tests/review.test.ts`
Expected: new test FAILS (no `runs/` dir). Existing tests still pass — the shim's stdout is buffered today, so `sess-1234` still parses from `--output-format json` handling.

- [ ] **Step 4: Implement**

`src/config.ts`:

```ts
export const runLogPath = (p: Paths, key: string): string =>
  join(p.stateDir, "runs", key.replace(/[/#]/g, "-") + ".jsonl");
```

`src/reviewer.ts` — replace the claude spawn/collect/parse block in `execReview` (from the `const env` line through the `sessionId` parsing) with:

```ts
  // gh.env carries GH_TOKEN when gh_account is pinned — claude runs gh itself
  const env: Record<string, string | undefined> = { ...ctx.gh.env };
  if (ctx.cfg.claude_config_dir) env.CLAUDE_CONFIG_DIR = ctx.cfg.claude_config_dir;
  const runLog = runLogPath(ctx.paths, key);
  mkdirSync(dirname(runLog), { recursive: true });
  writeFileSync(runLog, "");
  const proc = Bun.spawn(
    [
      claudeBin(ctx.cfg), "-p", reviewPrompt(number, entry.note),
      "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
      "--allowedTools", ALLOWED_TOOLS,
    ],
    { cwd: localPath, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
  );
  // Exposed so a SIGINT/SIGTERM handler can kill the child promptly — spawnSync
  // would otherwise block the JS thread until claude exits on its own.
  ctx.current.child = proc;
  const stderrDone = new Response(proc.stderr).text();
  // tee progress into the run log as it happens — `reviews` watches this file
  for await (const chunk of proc.stdout) appendFileSync(runLog, chunk);
  const exitCode = await proc.exited;
  ctx.current.child = undefined;
  appendFileSync(ctx.paths.logPath, await stderrDone);

  let sessionId = "";
  if (exitCode === 0) {
    const last = readFileSync(runLog, "utf8").trimEnd().split("\n").filter(Boolean).at(-1) ?? "";
    try {
      const result = JSON.parse(last) as { type?: string; session_id?: string };
      if (result.type === "result") sessionId = result.session_id ?? "";
    } catch {
      // non-JSON tail → treated as failure below
    }
  }
```

Update imports: `import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";`, `import { dirname, join } from "node:path";`, and add `runLogPath` to the `./config` import.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS. (The shim's single-line result doubles as the stream tail, so every existing ready-entry assertion still holds.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/reviewer.ts tests/harness.ts tests/review.test.ts
git commit -m "feat: runner streams claude output into a per-PR run log"
```

---

### Task 5: run log retires with the entry

**Files:**
- Modify: `src/reviewer.ts:42-56` (`removeWorktree`), `src/list.ts`, `src/sync.ts`
- Test: `tests/list.test.ts`

**Interfaces:**
- Consumes: `runLogPath` (Task 4).
- Produces: `cleanupEntry(ctx: Ctx, key: string, logPrefix: string): void` in `src/reviewer.ts` — the renamed `removeWorktree`, now also deleting the run log. `removeWorktree` no longer exists; callers are `dismissKey` (`src/list.ts`) and `reconcile` (`src/sync.ts`).

- [ ] **Step 1: Write the failing test**

Append to `tests/list.test.ts`:

```ts
test("dismiss also removes the run log", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  const runLog = join(sb.stateDir, "runs", "testorg-demo-7.jsonl");
  mkdirSync(join(sb.stateDir, "runs"), { recursive: true });
  writeFileSync(runLog, '{"type":"result"}\n');
  sb.writeState({
    "testorg/demo#7": {
      status: "ready", session_id: "s", title: "Demo PR", url: "u",
      local_path: sb.demoRepo, updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(sb.run(["dismiss", "testorg/demo#7"]).code).toBe(0);
  expect(existsSync(runLog)).toBe(false);
});
```

Add `mkdirSync, writeFileSync` to the `node:fs` import in the test file.

- [ ] **Step 2: Run tests to verify it fails**

Run: `bun test tests/list.test.ts`
Expected: new test FAILS (run log still exists).

- [ ] **Step 3: Implement**

In `src/reviewer.ts`, rename `removeWorktree` to `cleanupEntry` and delete the run log first — the early return below it must not skip this:

```ts
// Retire an entry's on-disk artifacts: its run log and its PR worktree.
export function cleanupEntry(ctx: Ctx, key: string, logPrefix: string): void {
  rmSync(runLogPath(ctx.paths, key), { force: true });
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
```

Add `rmSync` to the `node:fs` import. Update both callsites: `removeWorktree(` → `cleanupEntry(` and the import names in `src/list.ts` and `src/sync.ts`.

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS (dismiss/sync worktree tests exercise the renamed function).

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts src/list.ts src/sync.ts tests/list.test.ts
git commit -m "feat: dismissing or retiring an entry deletes its run log"
```

---

### Task 6: run log rendering + follow

**Files:**
- Create: `src/runlog.ts`
- Test: `tests/runlog.test.ts` (new)

**Interfaces:**
- Consumes: nothing project-internal.
- Produces:
  - `renderRunEvent(line: string): string | null` — one stream-json line → human line(s), or `null` for noise (unparseable lines, user/tool-result events).
  - `followRunLog(path: string): Promise<number>` — print rendered existing content, then follow the file until Ctrl+C (never resolves; same pattern as `watchCommand`).

- [ ] **Step 1: Write the failing tests**

Create `tests/runlog.test.ts`:

```ts
import { expect, test } from "bun:test";
import { renderRunEvent } from "../src/runlog";

test("renderRunEvent: assistant text and tool calls become readable lines", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Looking at the diff" },
        { type: "tool_use", name: "Bash", input: { command: "git fetch origin" } },
        { type: "tool_use", name: "Read", input: { file_path: "/repo/src/a.ts" } },
      ],
    },
  });
  expect(renderRunEvent(line)).toBe(
    "Looking at the diff\n→ Bash: git fetch origin\n→ Read: /repo/src/a.ts",
  );
});

test("renderRunEvent: long tool input is truncated to one line", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(300) } }] },
  });
  const out = renderRunEvent(line)!;
  expect(out.startsWith("→ Bash: xxx")).toBe(true);
  expect(out.length).toBeLessThan(120);
  expect(out.includes("\n")).toBe(false);
});

test("renderRunEvent: init, result, and noise", () => {
  expect(
    renderRunEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" })),
  ).toBe("session started (s-1)");
  expect(renderRunEvent(JSON.stringify({ type: "result", subtype: "success" }))).toBe(
    "✔ review finished",
  );
  expect(renderRunEvent(JSON.stringify({ type: "result", subtype: "error_during_execution" }))).toBe(
    "✖ review failed (error_during_execution)",
  );
  expect(renderRunEvent(JSON.stringify({ type: "user", message: {} }))).toBeNull();
  expect(renderRunEvent("not json at all")).toBeNull();
  expect(renderRunEvent(JSON.stringify({ type: "assistant", message: { content: [] } }))).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/runlog.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/runlog.ts`**

```ts
import { existsSync, readFileSync, watchFile } from "node:fs";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function toolLine(name: string, input: Record<string, unknown> = {}): string {
  const arg =
    input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.prompt ?? "";
  const s = typeof arg === "string" ? arg.replace(/\s+/g, " ").trim() : JSON.stringify(arg);
  const short = s.length > 100 ? s.slice(0, 100) + "…" : s;
  return short ? `→ ${name}: ${short}` : `→ ${name}`;
}

// One stream-json line -> human-readable line(s); null for noise.
export function renderRunEvent(line: string): string | null {
  let ev: {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: ContentBlock[] };
  };
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === "system" && ev.subtype === "init") {
    return `session started (${ev.session_id ?? "?"})`;
  }
  if (ev.type === "assistant") {
    const parts = (ev.message?.content ?? [])
      .map((b) =>
        b.type === "text" ? (b.text ?? "").trim()
        : b.type === "tool_use" ? toolLine(b.name ?? "?", b.input)
        : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  if (ev.type === "result") {
    return ev.subtype === "success"
      ? "✔ review finished"
      : `✖ review failed (${ev.subtype ?? "error"})`;
  }
  return null;
}

// Print the rendered log so far, then follow it until Ctrl+C.
export function followRunLog(path: string): Promise<number> {
  let seen = 0;
  let carry = ""; // partial line the runner hasn't finished writing yet
  const emit = (text: string) => {
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const l of lines) {
      const rendered = renderRunEvent(l);
      if (rendered !== null) console.log(rendered);
    }
  };
  const read = () => {
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf8");
    if (content.length < seen) {
      seen = 0; // truncated: a retry restarted the run log
      carry = "";
    }
    if (content.length > seen) {
      emit(content.slice(seen));
      seen = content.length;
    }
  };
  if (!existsSync(path)) console.log(`waiting for review output (${path}) …`);
  read();
  watchFile(path, { interval: 500 }, read);
  return new Promise(() => {}); // runs until Ctrl+C
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/runlog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runlog.ts tests/runlog.test.ts
git commit -m "feat: render and follow a review run log"
```

---

### Task 7: `w#` watch, `k#` kill, `reviews watch <pr>`

**Files:**
- Modify: `src/list.ts`, `src/status.ts`, `src/main.ts`, `README.md`
- Test: `tests/list.test.ts`, `tests/status.test.ts`

**Interfaces:**
- Consumes: `followRunLog` (Task 6), `runLogPath` (Task 4), `pidAlive` (`src/proc.ts`), `normalizeKey` (`src/state.ts`).
- Produces:
  - `parseChoice` action union grows to `"resume" | "dismiss" | "retry" | "watch" | "kill"` (`w#`, `k#`).
  - `killEntry(ctx: Ctx, key: string): number` in `src/list.ts` — SIGTERMs a live runner (exit 0) or errors (exit 1). Only `ctx.paths.statePath` is used.
  - `watchCommand(ctx: Ctx, rawKey?: string): Promise<number>` — with a key (`ORG/REPO#N` or PR URL) follows that PR's run log; without, follows the main log as today.

- [ ] **Step 1: Write the failing tests**

In `tests/list.test.ts`, extend the `parseChoice` test:

```ts
  expect(parseChoice("w1", 5)).toEqual({ action: "watch", index: 0 });
  expect(parseChoice("k2", 5)).toEqual({ action: "kill", index: 1 });
  expect(parseChoice("wx", 5)).toBeNull();
```

And append (add `killEntry` to the `../src/list` import):

```ts
test("killEntry SIGTERMs a live runner, which marks the entry canceled", async () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#62": {
      status: "reviewing", title: "Slow", url: "u", local_path: sb.demoRepo,
      updated_at: new Date().toISOString(),
    },
  });
  const proc = sb.runAsync(["exec", "testorg/demo#62"], { CLAUDE_SLEEP: "10" });
  await sb.waitEntry("testorg/demo#62", (e) => e.status === "reviewing" && e.pid !== undefined);

  const ctx = { paths: { statePath: sb.statePath } } as any;
  expect(killEntry(ctx, "testorg/demo#62")).toBe(0);
  await sb.waitEntry("testorg/demo#62", (e) => e.status === "canceled");
  await proc.exited;
});

test("killEntry refuses when nothing is running for the key", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#7": { status: "ready", session_id: "s", updated_at: "t" },
  });
  const ctx = { paths: { statePath: sb.statePath } } as any;
  expect(killEntry(ctx, "testorg/demo#7")).toBe(1);
  expect(killEntry(ctx, "testorg/demo#99")).toBe(1);
});

test("buildResume points a reviewing entry at watch/kill", () => {
  const r = buildResume({ status: "reviewing", updated_at: "t" }, { orgs: [], repos: {} });
  expect(r).toHaveProperty("error");
  expect((r as { error: string }).error).toContain("w#");
  expect((r as { error: string }).error).toContain("k#");
});
```

In `tests/status.test.ts`, append (imports: `mkdirSync`, `writeFileSync` from `node:fs`, `join` from `node:path`, `makeSandbox` from `./harness` — reuse if present):

```ts
test("watch <pr> renders that PR's run log", async () => {
  const sb = makeSandbox();
  mkdirSync(join(sb.stateDir, "runs"), { recursive: true });
  writeFileSync(
    join(sb.stateDir, "runs", "testorg-demo-7.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git fetch origin" } }] },
    }) + "\n" + JSON.stringify({ type: "result", subtype: "success" }) + "\n",
  );
  const proc = sb.runAsync(["watch", "testorg/demo#7"]);
  await Bun.sleep(2000); // follower prints existing content on startup
  proc.kill();
  const out = await new Response(proc.stdout).text();
  expect(out).toContain("→ Bash: git fetch origin");
  expect(out).toContain("✔ review finished");
});

test("watch with a garbage key errors", () => {
  const sb = makeSandbox();
  const r = sb.run(["watch", "total garbage"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("cannot parse");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/list.test.ts tests/status.test.ts`
Expected: FAIL — `w1` parses as resume→null, `killEntry` not exported, watch ignores its argument.

- [ ] **Step 3: Implement**

`src/list.ts` — `parseChoice`:

```ts
export function parseChoice(
  input: string,
  max: number,
): { action: "resume" | "dismiss" | "retry" | "watch" | "kill"; index: number } | "quit" | null {
  const t = input.trim();
  if (t === "" || t === "q") return "quit";
  const action =
    t.startsWith("d") ? "dismiss"
    : t.startsWith("r") ? "retry"
    : t.startsWith("w") ? "watch"
    : t.startsWith("k") ? "kill"
    : "resume";
  const num = action === "resume" ? t : t.slice(1);
  if (!/^\d+$/.test(num)) return null;
  const n = Number(num);
  if (n < 1 || n > max) return null;
  return { action, index: n - 1 };
}
```

`src/list.ts` — `buildResume` reviewing branch:

```ts
  if (entry.status === "reviewing") {
    return { error: "still being reviewed — w# to watch it live, k# to kill it" };
  }
```

`src/list.ts` — add `killEntry` and the new `interactiveList` cases (imports: `killEntry` needs nothing new; add `runLogPath` to the `./config` import, `followRunLog` from `./runlog`, `cleanupEntry` already imported from Task 5):

```ts
export function killEntry(ctx: Ctx, key: string): number {
  const e = loadState(ctx.paths.statePath)[key];
  if (!e || e.status !== "reviewing" || e.pid === undefined || !pidAlive(e.pid)) {
    console.error(`${key}: no live review to kill`);
    return 1;
  }
  process.kill(e.pid, "SIGTERM"); // the runner's handler marks the entry canceled
  console.log(`${key}: killed — it will show as canceled; r# re-runs it`);
  return 0;
}
```

In `interactiveList`, update the prompt and the switch:

```ts
  const answer = await rl.question("resume #  (d# dismiss, r# retry, w# watch, k# kill, q quit): ");
```

```ts
    case "watch":
      console.log(`watching ${key} — Ctrl+C stops watching, the review keeps running`);
      return followRunLog(runLogPath(ctx.paths, key));
    case "kill":
      return killEntry(ctx, key);
```

`src/status.ts` — new signature (imports: `normalizeKey` from `./state`, `runLogPath` from `./config`, `followRunLog` from `./runlog`):

```ts
export async function watchCommand(ctx: Ctx, rawKey?: string): Promise<number> {
  if (rawKey !== undefined) {
    let key: string;
    try {
      key = normalizeKey(rawKey);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    return followRunLog(runLogPath(ctx.paths, key));
  }
  // no key: follow the poller log (existing body unchanged below)
```

`src/main.ts`:

```ts
commands["watch"] = (args) => withCtx((ctx) => watchCommand(ctx, args[0]));
```

USAGE updates:

```
  reviews                    interactive list (resume #, d# dismiss, r# retry,
                             w# watch live, k# kill runner, q quit)
  reviews watch [pr]         follow the log live; with a PR (org/repo#N or
                             URL), follow that running review instead
```

`README.md` — "Day to day" bullets:

```markdown
- `reviews` — interactive list; pick a number to resume the session in the
  right clone, `d#` dismiss (also removes the PR's worktree), `r#` retry,
  `w#` watch a running review live, `k#` kill a running review (marks it
  canceled — no more tokens burned; `r#` starts it over).
- `reviews watch ORG/REPO#N` — follow a running review from anywhere; plain
  `reviews watch` follows the poller log as before.
```

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS. If `tests/main.test.ts` asserts old USAGE or prompt strings, update those assertions to the exact new strings above.

- [ ] **Step 5: Commit**

```bash
git add src/list.ts src/status.ts src/main.ts README.md tests/list.test.ts tests/status.test.ts
git commit -m "feat: watch and kill running reviews from the list and reviews watch <pr>"
```

---

## Final verification

- [ ] `bun test` — full suite green.
- [ ] `bun run build` — binary compiles.
- [ ] `grep -ri` the diff for any real org/team name — must find none (placeholders only).
