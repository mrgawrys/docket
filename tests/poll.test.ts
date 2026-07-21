import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  expect(readFileSync(sb.logPath, "utf8")).toContain("poll complete: 1 started");
  const e = await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234");
  expect(e.local_path).toBe(sb.demoRepo);
  expect(sb.statusAtCall()).toBe("reviewing"); // entry was 'reviewing' while claude ran
  expect(sb.promptCapture()).toContain("worktree for PR #7 at .worktrees/pr-7");
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
    { number: 7, title: "PR A", url: "https://example.test/pr/7", isDraft: false,
      repository: { nameWithOwner: "testorg/demo" } },
    { number: 21, title: "PR B", url: "https://example.test/pr/21", isDraft: false,
      repository: { nameWithOwner: "testorg/demo" } },
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
    "testorg/demo#9": { status: "reviewing", title: "Orphan", url: "u", updated_at: "2026-01-01T00:00:00Z" },
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
      status: "reviewing", title: "Live", url: "u", pid: process.pid,
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
