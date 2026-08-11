import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_TOOLS, type Config } from "../src/config";
import { reviewPrompt } from "../src/reviewer";
import { makeSandbox } from "./harness";

const bareCfg = (review_prompt?: string): Config => ({
  orgs: [],
  repos: {},
  ...(review_prompt === undefined ? {} : { review_prompt }),
});

test("reviewPrompt: default runs /code-review with the number substituted", () => {
  const p = reviewPrompt("42", "org/repo", bareCfg());
  expect(p).toContain("worktree to review PR #42");
  expect(p).toContain("never modify the main working copy");
  expect(p).toContain("Review the PR by running /code-review 42.");
  expect(p).toContain("Keep the worktree in place afterwards");
  expect(p).not.toContain("{number}");
});

test("reviewPrompt: does not dictate a worktree path — the agent's conventions decide", () => {
  const p = reviewPrompt("42", "org/repo", bareCfg());
  expect(p).not.toContain(".worktrees/pr-42");
});

test("reviewPrompt: worktree preamble and suffix are fixed even with a custom prompt", () => {
  const p = reviewPrompt(
    "7",
    "org/repo",
    bareCfg("Just eyeball it, no tools."),
  );
  expect(p).toContain("worktree to review PR #7");
  expect(p).toContain("never modify the main working copy");
  expect(p).toContain("Just eyeball it, no tools.");
  expect(p).toContain("Keep the worktree in place afterwards");
});

test("reviewPrompt: substitutes {number} and {repo} tokens", () => {
  const p = reviewPrompt(
    "99",
    "Recruitee/api",
    bareCfg("Review PR {number} in {repo}."),
  );
  expect(p).toContain("Review PR 99 in Recruitee/api.");
});

test("reviewPrompt: a custom prompt with no token is used verbatim", () => {
  const p = reviewPrompt("5", "org/repo", bareCfg("Review this PR carefully."));
  expect(p).toContain("Review this PR carefully.");
});

test("reviewPrompt: an empty review_prompt falls back to the default body", () => {
  const p = reviewPrompt("8", "org/repo", bareCfg("  "));
  expect(p).toContain("Review the PR by running /code-review 8.");
});

test("reviewPrompt: a reviewer note is appended after everything", () => {
  const p = reviewPrompt("3", "org/repo", bareCfg(), "focus on the migration");
  expect(p).toContain(
    "Additional context from the reviewer: focus on the migration",
  );
  expect(p.trimEnd().endsWith("focus on the migration")).toBe(true);
});

test("reviewPrompt: the summary block is demanded even of a custom prompt", () => {
  const p = reviewPrompt("7", "org/repo", bareCfg("Just eyeball it."));
  expect(p).toContain("triage summary");
  expect(p).toContain('"headline"');
  expect(p).toContain('"risk"');
});

test("a finished review records its triage summary on the entry", async () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  const r = sb.run(["review", "testorg/demo#7"], {
    CLAUDE_RESULT:
      "# Code review\n\nOne real defect.\n\n```json\n" +
      '{"headline": "choice questions render as Text", "issues": 1, "risk": "low"}\n' +
      "```",
  });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(e.summary).toEqual({
    headline: "choice questions render as Text",
    issues: 1,
    risk: "low",
  });
});

test("a review that ignores the summary instruction still lands as ready", async () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  expect(
    sb.run(["review", "testorg/demo#7"], { CLAUDE_RESULT: "no block here" })
      .code,
  ).toBe(0);
  const e = await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(e.summary).toBeUndefined();
});

test("a finished review with a denial records the grouped denial on the entry", async () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  const r = sb.run(["review", "testorg/demo#7"], { CLAUDE_EMIT_DENIAL: "1" });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(e.denials).toEqual([
    expect.objectContaining({ suggestion: "Bash(rg:*)", count: 1 }),
  ]);
});

test("a clean review leaves the denials field absent", async () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  expect(sb.run(["review", "testorg/demo#7"]).code).toBe(0);
  const e = await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(e.denials).toBeUndefined();
});

test("runner records the worktree the agent created, wherever it put it", async () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  const agentWt = join(sb.tmp, "agent-chosen", "recruitee-pr-7");
  const r = sb.run(["review", "testorg/demo#7"], {
    CLAUDE_MAKE_WORKTREE: agentWt,
  });
  expect(r.code).toBe(0);
  // the runner writes the status first and patches the discovered worktrees on
  // afterwards, so waiting on "ready" alone races the second write
  const e = await sb.waitEntry(
    "testorg/demo#7",
    (x) => x.status === "ready" && x.worktrees,
  );
  // git reports the canonical (symlink-resolved) path — compare on realpath
  expect(e.worktrees).toEqual([realpathSync(agentWt)]);
  // and it is removable on dismiss even though we never dictated the path
  expect(existsSync(agentWt)).toBe(true);
  expect(sb.run(["dismiss", "testorg/demo#7"]).code).toBe(0);
  expect(existsSync(agentWt)).toBe(false);
});

test("review + retry command family", async () => {
  const sb = makeSandbox();

  // scenario 7: force-review with a note — starts in background, lands ready
  let r = sb.run([
    "review",
    "testorg/demo#42",
    "author pushed changes, focus on the delta",
  ]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("background");
  let e = await sb.waitEntry("testorg/demo#42", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234");
  expect(e.title).toBe("Manual PR");
  expect(sb.promptCapture()).toContain("worktree to review PR #42");
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
  expect(readFileSync(sb.logPath, "utf8")).toContain("docket doctor");

  // scenario 5: retry flips failed -> ready; unknown key exits non-zero
  r = sb.run(["retry", "testorg/demo#50"]);
  expect(r.code).toBe(0);
  e = await sb.waitEntry("testorg/demo#50", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234");
  expect(sb.run(["retry", "nope/nope#1"]).code).not.toBe(0);
});

test("extra_allowed_tools land in claude's --allowedTools after the baseline", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    extra_allowed_tools: ["Bash(bun test:*)", "Skill(my-review)"],
  });
  expect(sb.run(["review", "testorg/demo#7"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(sb.allowedCapture()).toBe(
    `${ALLOWED_TOOLS},Bash(bun test:*),Skill(my-review)`,
  );
});

test("no extra_allowed_tools → claude gets exactly the baseline allowlist", async () => {
  const sb = makeSandbox();
  expect(sb.run(["review", "testorg/demo#7"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#7", (x) => x.status === "ready");
  expect(sb.allowedCapture()).toBe(ALLOWED_TOOLS);
});

test("scenario 9: missing config seeds a starter one and errors", () => {
  const sb = makeSandbox();
  const dir = sb.tmp + "/nonexistent";
  const r = sb.run(["review", "testorg/demo#1"], {
    DOCKET_CONFIG_DIR: dir,
  });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("fill in");
  expect(existsSync(join(dir, "config.json"))).toBe(true);
});

test("gh_account: pinned account's token reaches gh and claude as GH_TOKEN", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    gh_account: "workuser",
  });
  expect(sb.run(["review", "testorg/demo#47"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#47", (x) => x.status === "ready");
  expect(sb.ghTokenCapture()).toBe("tok-workuser");
});

test("gh_account: unresolvable account fails fast with a gh auth hint", () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
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
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: sb.tmp + "/claude-home",
  });
  expect(sb.run(["review", "testorg/demo#44"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#44", (x) => x.status === "ready");
  expect(sb.cfgdirCapture()).toBe(sb.tmp + "/claude-home");
});

test("scenario 10b: claude_env entries reach the claude invocation", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_env: { CLAUDE_BASH_WATCHDOG_SECONDS: "0" },
  });
  expect(sb.run(["review", "testorg/demo#45"]).code).toBe(0);
  await sb.waitEntry("testorg/demo#45", (x) => x.status === "ready");
  expect(sb.watchdogCapture()).toBe("0");
});

test("scenario 11: claude_bin from config used when CLAUDE_BIN unset", async () => {
  const sb = makeSandbox();
  const shim2 = sb.env.CLAUDE_BIN + "2";
  Bun.spawnSync(["cp", sb.env.CLAUDE_BIN!, shim2]);
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_bin: shim2,
  });
  const before = sb.claudeCalls();
  expect(
    sb.run(["review", "testorg/demo#45"], { CLAUDE_BIN: undefined }).code,
  ).toBe(0);
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
      status: "reviewing",
      title: "Live",
      url: "u",
      pid: process.pid,
      updated_at: "2026-01-01T00:00:00Z",
      local_path: sb.demoRepo,
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
      status: "reviewing",
      title: "Slow",
      url: "u",
      local_path: sb.demoRepo,
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

test("runner streams progress into the run log while claude is still working", async () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#61": {
      status: "reviewing",
      title: "Slow",
      url: "u",
      local_path: sb.demoRepo,
      updated_at: new Date().toISOString(),
    },
  });
  const proc = sb.runAsync(["exec", "testorg/demo#61"], { CLAUDE_SLEEP: "2" });
  const runLog = join(sb.stateDir, "runs", "testorg-demo-61.jsonl");

  // assistant event must land in the run log before the run finishes
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      existsSync(runLog) &&
      readFileSync(runLog, "utf8").includes('"type":"assistant"')
    )
      break;
    await Bun.sleep(25);
  }
  expect(readFileSync(runLog, "utf8")).toContain('"type":"assistant"');
  expect(sb.state()["testorg/demo#61"].status).toBe("reviewing");

  await proc.exited;
  const e = await sb.waitEntry("testorg/demo#61", (x) => x.status === "ready");
  expect(e.session_id).toBe("sess-1234"); // parsed from the run log's result tail
  expect(readFileSync(runLog, "utf8")).toContain('"type":"result"');
});
