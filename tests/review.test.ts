import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { makeSandbox } from "./harness";

test("review + retry command family", async () => {
  const sb = makeSandbox();

  // scenario 7: force-review with a note — starts in background, lands ready
  let r = sb.run(["review", "testorg/demo#42", "author pushed changes, focus on the delta"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("background");
  let e = await sb.waitEntry("testorg/demo#42", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234");
  expect(e.title).toBe("Manual PR");
  expect(sb.promptCapture()).toContain("worktree for PR #42 at .worktrees/pr-42");
  expect(sb.promptCapture()).toContain("/code-review 42");
  expect(sb.promptCapture()).toContain("focus on the delta");

  // scenario 8: URL input normalizes; garbage is rejected
  r = sb.run(["review", "https://github.com/testorg/demo/pull/43"]);
  expect(r.code).toBe(0);
  await sb.waitEntry("testorg/demo#43", (x) => x.status === "ready");
  expect(Object.keys(sb.state()).some((k) => k.startsWith("http"))).toBe(false);
  r = sb.run(["review", "total garbage"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("cannot parse");

  // scenario 4 via review: claude failure -> failed + error recorded
  r = sb.run(["review", "testorg/demo#50"], { CLAUDE_FAIL: "1" });
  expect(r.code).toBe(0);
  e = await sb.waitEntry("testorg/demo#50", (x) => x.status === "failed");
  expect(e.error).toBeTruthy();
  expect(readFileSync(sb.logPath, "utf8")).toContain("reviews doctor");

  // scenario 5: retry flips failed -> ready; unknown key exits non-zero
  r = sb.run(["retry", "testorg/demo#50"]);
  expect(r.code).toBe(0);
  e = await sb.waitEntry("testorg/demo#50", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234");
  expect(sb.run(["retry", "nope/nope#1"]).code).not.toBe(0);
});

test("scenario 9: missing config errors, pointing at config.example.json", () => {
  const sb = makeSandbox();
  const r = sb.run(["review", "testorg/demo#1"], { AUTO_REVIEW_CONFIG_DIR: sb.tmp + "/nonexistent" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("config.example.json");
});

test("gh_account: pinned account's token reaches gh and claude as GH_TOKEN", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    gh_account: "workuser",
  });
  expect(sb.run(["review", "testorg/demo#47"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#47", (x) => x.status === "ready");
  expect(sb.ghTokenCapture()).toBe("tok-workuser");
});

test("gh_account: unresolvable account fails fast with a gh auth hint", () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    gh_account: "ghost",
  });
  const r = sb.run(["review", "testorg/demo#48"], { GH_AUTH_TOKEN_FAIL: "1" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("ghost");
  expect(r.err).toContain("gh auth");
});

test("scenario 10: claude_config_dir reaches claude as CLAUDE_CONFIG_DIR", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: sb.tmp + "/claude-home",
  });
  expect(sb.run(["review", "testorg/demo#44"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#44", (x) => x.status === "ready");
  expect(sb.cfgdirCapture()).toBe(sb.tmp + "/claude-home");
});

test("scenario 11: claude_bin from config used when CLAUDE_BIN unset", async () => {
  const sb = makeSandbox();
  const shim2 = sb.env.CLAUDE_BIN + "2";
  Bun.spawnSync(["cp", sb.env.CLAUDE_BIN!, shim2]);
  sb.writeConfig({ orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo }, claude_bin: shim2 });
  const before = sb.claudeCalls();
  expect(sb.run(["review", "testorg/demo#45"], { CLAUDE_BIN: undefined }).code).toBe(0);
  await sb.waitEntry("testorg/demo#45", (x) => x.status === "ready");
  expect(sb.claudeCalls()).toBe(before + 1); // the copied shim appends to the same CLAUDE_CALLS file
});

test("skipped: unmapped repo -> status skipped, no local_path (scenario 12 core)", () => {
  const sb = makeSandbox();
  sb.writeConfig({ orgs: ["testorg"], repos: {} });
  expect(sb.run(["review", "testorg/demo#46"]).code).toBe(0);
  const e = sb.state()["testorg/demo#46"];
  expect(e.status).toBe("skipped");
  expect("local_path" in e).toBe(false);
});

test("review: a live runner for the same key is not double-started", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#42": {
      status: "reviewing", title: "Live", url: "u", pid: process.pid,
      updated_at: "2026-01-01T00:00:00Z", local_path: sb.demoRepo,
    },
  });
  const before = sb.claudeCalls();
  expect(sb.run(["review", "testorg/demo#42"]).code).toBe(0);
  expect(sb.claudeCalls()).toBe(before);
  expect(sb.state()["testorg/demo#42"].pid).toBe(process.pid);
});

test("SIGTERM interrupts an in-flight exec runner promptly instead of waiting it out", async () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#60": {
      status: "reviewing", title: "Slow", url: "u", local_path: sb.demoRepo,
      updated_at: new Date().toISOString(),
    },
  });
  const proc = sb.runAsync(["exec", "testorg/demo#60"], { CLAUDE_SLEEP: "10" });

  // the claude shim appends to CLAUDE_CALLS as its first act — once that
  // happened, the runner is inside the slow claude run
  const deadline = Date.now() + 5000;
  while (sb.claudeCalls() === 0 && Date.now() < deadline) await Bun.sleep(25);
  expect(sb.claudeCalls()).toBe(1);

  const start = Date.now();
  proc.kill("SIGTERM");
  const code = await proc.exited;
  const elapsed = Date.now() - start;

  expect(code).toBe(130);
  expect(sb.state()["testorg/demo#60"].status).toBe("canceled");
  expect(sb.state()["testorg/demo#60"].error).toBe("run interrupted");
  // proves the handler fired promptly rather than waiting out the 10s shim sleep
  expect(elapsed).toBeLessThan(8000);
});
