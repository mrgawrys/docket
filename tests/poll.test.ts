import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipVia } from "../src/poll";
import { makeSandbox } from "./harness";

const lastLogLine = (sb: ReturnType<typeof makeSandbox>) =>
  readFileSync(sb.logPath, "utf8").trimEnd().split("\n").at(-1)!;

test("poll: dry-run, real run, dedup (scenarios 1-3)", async () => {
  const sb = makeSandbox();

  // scenario 1: dry run lists non-draft only, writes no entries, no claude
  let r = sb.run(["poll", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would review: testorg/demo#7");
  expect(r.out).not.toContain("#8");
  expect(Object.keys(sb.state())).toHaveLength(0);
  expect(sb.claudeCalls()).toBe(0);

  // scenario 2: real run starts a background runner -> ready entry appears
  r = sb.run(["poll"]);
  expect(r.code).toBe(0);
  expect(readFileSync(sb.logPath, "utf8")).toContain(
    "poll complete: 1 started",
  );
  const e = await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234");
  expect(e.local_path).toBe(sb.demoRepo);
  expect(sb.statusAtCall()).toBe("reviewing"); // entry was 'reviewing' while claude ran
  expect(sb.promptCapture()).toContain("worktree to review PR #7");
  expect(sb.promptCapture()).toContain("/code-review 7");

  // scenario 3: second run must not re-review a known PR
  r = sb.run(["poll"]);
  expect(r.code).toBe(0);
  expect(sb.claudeCalls()).toBe(1);
  expect(lastLogLine(sb)).toContain("poll complete: nothing new");
});

test("poll: reviews run in parallel and survive the poll process exiting", async () => {
  const sb = makeSandbox();
  const searchJson = JSON.stringify([
    {
      number: 7,
      title: "PR A",
      url: "https://example.test/pr/7",
      isDraft: false,
      repository: { nameWithOwner: "testorg/demo" },
    },
    {
      number: 21,
      title: "PR B",
      url: "https://example.test/pr/21",
      isDraft: false,
      repository: { nameWithOwner: "testorg/demo" },
    },
  ]);

  const t0 = Date.now();
  const r = sb.run(["poll"], { GH_SEARCH_JSON: searchJson, CLAUDE_SLEEP: "2" });
  expect(r.code).toBe(0);

  // poll exited while both reviews were still running (detached runners)
  expect(sb.state()["testorg/demo#7"].status).toBe("reviewing");
  expect(sb.state()["testorg/demo#21"].status).toBe("reviewing");

  await sb.waitEntry("testorg/demo#7", (e) => e.status === "ready");
  await sb.waitEntry("testorg/demo#21", (e) => e.status === "ready");
  // two 2s reviews done this fast means they overlapped, not queued
  expect(Date.now() - t0).toBeLessThan(4800);
  expect(sb.claudeCalls()).toBe(2);
});

test("poll: orphaned reviewing entry (dead pid) becomes failed (scenario 6)", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#9": {
      status: "reviewing",
      title: "Orphan",
      url: "u",
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(sb.run(["poll"]).code).toBe(0);
  const e = sb.state()["testorg/demo#9"];
  expect(e.status).toBe("failed");
  expect(e.error).toBeTruthy();
});

test("poll: reviewing entry with a live runner pid is left alone", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#7": {
      status: "reviewing",
      title: "Live",
      url: "u",
      pid: process.pid,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const before = sb.claudeCalls();
  expect(sb.run(["poll"]).code).toBe(0);
  expect(sb.state()["testorg/demo#7"].status).toBe("reviewing");
  expect(sb.claudeCalls()).toBe(before); // known key — not re-reviewed either
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
      status: "ready",
      session_id: "sess-1234",
      title: "Demo PR",
      url: "u",
      local_path: sb.demoRepo,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const before = sb.claudeCalls();
  const r = sb.run(["poll"], {
    GH_PR_STATUS_JSON: JSON.stringify({ state: "MERGED" }),
  });
  expect(r.code).toBe(0);
  const e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("done");
  expect(e.done_reason).toBe("merged");
  expect(existsSync(join(sb.demoRepo, ".worktrees", "pr-7"))).toBe(false);
  expect(sb.claudeCalls()).toBe(before);
  expect(lastLogLine(sb)).toContain("1 synced");
});

test("poll: claude logged out → abort before any review, no state entries", () => {
  const sb = makeSandbox();
  const r = sb.run(["poll"], { CLAUDE_LOGGED_OUT: "1" });
  expect(r.code).toBe(0);
  // no entry means the PR is still waiting once auth is back, not burned
  expect(Object.keys(sb.state())).toHaveLength(0);
  expect(sb.claudeCalls()).toBe(0);
  expect(lastLogLine(sb)).toContain("poll aborted: claude is not logged in");
});

test("skipVia: skips only when every requested team I belong to is ignored", () => {
  const ignored = ["acme/ignored-team"];
  const member = ["acme/ignored-team", "acme/dev"];
  // requested solely via an ignored team I'm in -> skip, naming the team
  expect(
    skipVia(
      "me",
      { users: [], teams: ["acme/ignored-team", "acme/other"] },
      member,
      ignored,
    ),
  ).toEqual(["acme/ignored-team"]);
  // directly requested -> always review, even if ignored teams also match
  expect(
    skipVia(
      "me",
      { users: ["me"], teams: ["acme/ignored-team"] },
      member,
      ignored,
    ),
  ).toBeNull();
  // also in a requested team that is NOT ignored -> review
  expect(
    skipVia(
      "me",
      { users: [], teams: ["acme/ignored-team", "acme/dev"] },
      member,
      ignored,
    ),
  ).toBeNull();
  // no membership overlap with requested teams -> fail open, review
  expect(
    skipVia("me", { users: [], teams: ["acme/other"] }, member, ignored),
  ).toBeNull();
  // missing data (failed API calls) -> fail open, review
  expect(skipVia("me", null, member, ignored)).toBeNull();
  expect(
    skipVia("me", { users: [], teams: ["acme/ignored-team"] }, null, ignored),
  ).toBeNull();
  expect(
    skipVia(null, { users: [], teams: ["acme/ignored-team"] }, member, ignored),
  ).toBeNull(); // unknown login -> fail open
});

test("ignored_teams: team-only request is skipped with no state entry; direct request resurfaces it", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    ignored_teams: ["testorg/ignored-team"],
  });
  const teamOnly = JSON.stringify({
    reviewRequests: [{ __typename: "Team", slug: "testorg/ignored-team" }],
  });
  const env = {
    GH_USER_TEAMS: "testorg/ignored-team",
    GH_REVIEW_REQUESTS_JSON: teamOnly,
  };

  // dry run announces the skip
  let r = sb.run(["poll", "--dry-run"], env);
  expect(r.code).toBe(0);
  expect(r.out).toContain(
    "would skip (via testorg/ignored-team): testorg/demo#7",
  );
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
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
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
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
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
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    ignored_teams: ["testorg/ignored-team"],
  });
  const searchJson = JSON.stringify([
    {
      number: 7,
      title: "A",
      url: "u",
      isDraft: false,
      repository: { nameWithOwner: "testorg/demo" },
    },
    {
      number: 21,
      title: "B",
      url: "u",
      isDraft: false,
      repository: { nameWithOwner: "testorg/demo" },
    },
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
  expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toHaveLength(
    1,
  );
});
