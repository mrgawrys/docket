import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config";
import type { DenialGroup } from "../src/denials";
import {
  buildFreshChat,
  buildHandoff,
  buildResume,
  killEntry,
  parsePrInput,
} from "../src/list";
import { makeSandbox } from "./harness";

const denialGroup = (over: Partial<DenialGroup> = {}): DenialGroup => ({
  tool: "Bash",
  suggestion: "Bash(rg:*)",
  count: 2,
  examples: ["rg --files"],
  writeShaped: false,
  alreadyAllowed: false,
  ...over,
});

test("buildResume guards and command construction", () => {
  const cfg = {
    orgs: [],
    repos: {},
    claude_bin: "/x/claude",
    claude_config_dir: "/x/home",
  };
  expect(
    buildResume({ status: "reviewing", updated_at: "t" }, cfg),
  ).toHaveProperty("error");
  expect(
    buildResume({ status: "failed", updated_at: "t" }, cfg),
  ).toHaveProperty("error");
  const repo = mkdtempSync(join(tmpdir(), "docket-resume-"));
  const r = buildResume(
    { status: "ready", session_id: "s1", local_path: repo, updated_at: "t" },
    cfg,
  );
  expect(r).toEqual({
    argv: ["/x/claude", "--resume", "s1"],
    cwd: repo,
    env: { CLAUDE_CONFIG_DIR: "/x/home" },
  });
  // a session outlives its directory: resuming into one that is gone would
  // spawn claude in a nonexistent cwd, so the key goes unavailable instead
  expect(
    buildResume(
      {
        status: "ready",
        session_id: "s1",
        local_path: join(repo, "gone"),
        updated_at: "t",
      },
      cfg,
    ),
  ).toHaveProperty("error");
});

test("bare docket without a terminal prints the queue instead of crashing", () => {
  // a script, a cron wrapper, `docket < /dev/null`: Ink cannot take raw mode
  // there, and the menu this replaced treated a closed stdin as quit
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#7": { status: "ready", title: "Demo PR", updated_at: "t" },
    "testorg/demo#8": { status: "done", title: "Gone", updated_at: "t" },
  });
  const r = sb.run([]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("testorg/demo#7");
  expect(r.out).not.toContain("testorg/demo#8"); // done is not pending
});

test("dismiss command marks done and removes the worktree", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeState({
    "testorg/demo#7": {
      status: "ready",
      session_id: "s",
      title: "Demo PR",
      url: "u",
      local_path: sb.demoRepo,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const r = sb.run(["dismiss", "testorg/demo#7"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("dismissed testorg/demo#7");
  expect(sb.state()["testorg/demo#7"].status).toBe("done");
  expect(existsSync(join(sb.demoRepo, ".worktrees", "pr-7"))).toBe(false);
});

test("dismiss removes a recorded worktree wherever the agent put it", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  // a worktree the agent created outside the repo tree, per its own conventions
  const wt = join(sb.tmp, "elsewhere", "recruitee-pr-7");
  Bun.spawnSync(
    ["git", "-C", sb.demoRepo, "worktree", "add", "--quiet", "--detach", wt],
    { env: process.env as Record<string, string> },
  );
  expect(existsSync(wt)).toBe(true);
  sb.writeState({
    "testorg/demo#7": {
      status: "ready",
      local_path: sb.demoRepo,
      worktrees: [wt],
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(sb.run(["dismiss", "testorg/demo#7"]).code).toBe(0);
  expect(existsSync(wt)).toBe(false);
});

test("dismiss command rejects an unknown key instead of fabricating an entry", () => {
  const sb = makeSandbox();
  const r = sb.run(["dismiss", "nope/nope#1"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("unknown key");
  expect(sb.state()).toEqual({});
});

test("dismiss also removes the run log", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  const runLog = join(sb.stateDir, "runs", "testorg-demo-7.jsonl");
  mkdirSync(join(sb.stateDir, "runs"), { recursive: true });
  writeFileSync(runLog, '{"type":"result"}\n');
  sb.writeState({
    "testorg/demo#7": {
      status: "ready",
      session_id: "s",
      title: "Demo PR",
      url: "u",
      local_path: sb.demoRepo,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(sb.run(["dismiss", "testorg/demo#7"]).code).toBe(0);
  expect(existsSync(runLog)).toBe(false);
});

test("killEntry SIGTERMs a live runner, which marks the entry canceled", async () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#62": {
      status: "reviewing",
      title: "Slow",
      url: "u",
      local_path: sb.demoRepo,
      updated_at: new Date().toISOString(),
    },
  });
  const proc = sb.runAsync(["exec", "testorg/demo#62"], { CLAUDE_SLEEP: "10" });
  await sb.waitEntry(
    "testorg/demo#62",
    (e) => e.status === "reviewing" && e.pid !== undefined,
  );

  const ctx = { paths: { statePath: sb.statePath } } as any;
  expect(killEntry(ctx, "testorg/demo#62").code).toBe(0);
  await sb.waitEntry("testorg/demo#62", (e) => e.status === "canceled");
  await proc.exited;
});

test("killEntry refuses when nothing is running for the key", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#7": { status: "ready", session_id: "s", updated_at: "t" },
  });
  const ctx = { paths: { statePath: sb.statePath } } as any;
  // the reason has to come back to the caller: in the TUI, console output
  // lands above the frame where the user never sees it
  expect(killEntry(ctx, "testorg/demo#7")).toEqual({
    code: 1,
    message: "testorg/demo#7: no live review to kill",
  });
  expect(killEntry(ctx, "testorg/demo#99").code).toBe(1);
});

test("buildResume points a reviewing entry at watch/kill", () => {
  const r = buildResume(
    { status: "reviewing", updated_at: "t" },
    { orgs: [], repos: {} },
  );
  expect(r).toHaveProperty("error");
  expect((r as { error: string }).error).toContain("w watches");
  expect((r as { error: string }).error).toContain("K kills");
});

test("buildHandoff is unavailable without a clone to run claude in", () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const r = buildHandoff(
    { status: "ready", updated_at: "t" },
    { orgs: [], repos: {} },
    p,
    "acme/demo#7",
    [denialGroup()],
  );
  expect(r).toHaveProperty("error");
});

test("buildHandoff is unavailable with no denials to hand off", () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const r = buildHandoff(
    { status: "ready", local_path: "/clone", updated_at: "t" },
    { orgs: [], repos: {} },
    p,
    "acme/demo#7",
    [],
  );
  expect(r).toHaveProperty("error");
});

test("buildHandoff launches claude directly, with no --permission-mode flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const cfg = {
    orgs: [],
    repos: {},
    claude_bin: "/x/claude",
    claude_config_dir: "/x/home",
    extra_allowed_tools: ["Bash(gh pr view:*)"],
  };
  const r = buildHandoff(
    { status: "ready", local_path: "/repo", updated_at: "t" },
    cfg,
    p,
    "acme/demo#7",
    [denialGroup({ suggestion: "Bash(rg:*)" })],
  );
  expect(r).not.toHaveProperty("error");
  const ok = r as { argv: string[]; cwd: string; env: Record<string, string> };
  expect(ok.argv[0]).toBe("/x/claude");
  expect(ok.argv).toHaveLength(2); // claude, prompt — no flags at all
  expect(ok.argv.join(" ")).not.toContain("--permission-mode");
  expect(ok.argv[1]).toContain("Bash(rg:*)");
  expect(ok.argv[1]).toContain("not available"); // no run log on disk here
  expect(ok.cwd).toBe("/repo");
  expect(ok.env).toEqual({ CLAUDE_CONFIG_DIR: "/x/home" });
});

test("buildHandoff points at the run log when one exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const key = "acme/demo#7";
  const runsDir = join(p.stateDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const logFile = join(runsDir, "acme-demo-7.jsonl");
  writeFileSync(logFile, '{"type":"result"}\n');
  const r = buildHandoff(
    { status: "ready", local_path: "/repo", updated_at: "t" },
    { orgs: [], repos: {} },
    p,
    key,
    [denialGroup()],
  );
  expect(r).not.toHaveProperty("error");
  expect((r as { argv: string[] }).argv[1]).toContain(logFile);
});

test("the handoff prompt states the flags as they are now, not as the run froze them", () => {
  // a rule applied since the run makes alreadyAllowed a lie, and the prompt's
  // own "current extra_allowed_tools" line would contradict it
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const r = buildHandoff(
    { status: "ready", local_path: "/repo", updated_at: "t" },
    { orgs: [], repos: {}, extra_allowed_tools: ["Bash(rg:*)"] },
    p,
    "acme/demo#7",
    [denialGroup({ suggestion: "Bash(rg:*)", alreadyAllowed: false })],
  );
  expect((r as { argv: string[] }).argv[1]).toContain(
    "already in the allowlist",
  );
});

test("a stale already-allowed flag is not carried into the prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const r = buildHandoff(
    { status: "ready", local_path: "/repo", updated_at: "t" },
    { orgs: [], repos: {} },
    p,
    "acme/demo#7",
    [denialGroup({ suggestion: "Bash(rg:*)", alreadyAllowed: true })],
  );
  expect((r as { argv: string[] }).argv[1]).not.toContain(
    "already in the allowlist",
  );
});

test("buildResume for a mine entry resumes in the checkout, not the clone", () => {
  const cfg = { orgs: [], repos: {}, claude_bin: "/x/claude" };
  const clone = mkdtempSync(join(tmpdir(), "docket-clone-"));
  const checkout = mkdtempSync(join(tmpdir(), "docket-checkout-"));
  const e = {
    status: "ready" as const,
    session_id: "s1",
    local_path: clone,
    checkout_path: checkout,
    updated_at: "t",
  };
  expect(buildResume(e, cfg, "mine")).toMatchObject({ cwd: checkout });
  // review kind untouched by the new field
  expect(buildResume(e, cfg)).toMatchObject({ cwd: clone });
  // no checkout yet: no session to resume there
  expect(
    buildResume({ ...e, checkout_path: undefined }, cfg, "mine"),
  ).toHaveProperty("error");
  // deleted by hand: the reason names the checkout, and points at R
  const gone = buildResume(
    { ...e, checkout_path: join(checkout, "gone") },
    cfg,
    "mine",
  );
  expect(gone).toHaveProperty("error");
  expect((gone as { error: string }).error).toContain("R resolves");
});

test("buildFreshChat: bare claude in the checkout; error without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "docket-fresh-"));
  const cfg = { orgs: [], repos: {}, claude_bin: "/x/claude" };
  const r = buildFreshChat(
    { status: "open", checkout_path: dir, updated_at: "t" },
    cfg,
  );
  expect(r).toMatchObject({ argv: ["/x/claude"], cwd: dir, interactive: true });
  expect(
    buildFreshChat({ status: "open", updated_at: "t" }, cfg),
  ).toHaveProperty("error");
  expect(
    buildFreshChat(
      { status: "open", checkout_path: join(dir, "gone"), updated_at: "t" },
      cfg,
    ),
  ).toHaveProperty("error");
});

test("parsePrInput: URL or ORG/REPO#N plus optional note; rejects bad shapes and unmapped repos", () => {
  const cfg = { orgs: [], repos: { "acme/widgets": "/clone" } };
  expect(parsePrInput("acme/widgets#12", cfg)).toEqual({
    key: "acme/widgets#12",
  });
  expect(
    parsePrInput(
      "https://github.com/acme/widgets/pull/12  focus on the tests",
      cfg,
    ),
  ).toEqual({ key: "acme/widgets#12", note: "focus on the tests" });
  expect(parsePrInput("", cfg)).toHaveProperty("error");
  expect(parsePrInput("garbage", cfg)).toMatchObject({
    error: expect.stringContaining("cannot parse"),
  });
  expect(parsePrInput("acme/other#3", cfg)).toMatchObject({
    error: expect.stringContaining("not mapped"),
  });
});

test("printPending prints both sections", () => {
  const sb = makeSandbox();
  sb.writeState({
    "testorg/demo#7": {
      status: "ready",
      title: "Their PR",
      updated_at: "2026-01-01T00:00:00Z",
    },
    "mine:testorg/demo#9": {
      status: "open",
      title: "My PR",
      updated_at: "2026-01-02T00:00:00Z",
    },
  });
  // bare `docket` without a tty prints the queue instead of mounting Ink
  const r = sb.run([]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("queue:");
  expect(r.out).toContain("testorg/demo#7\tready\tTheir PR");
  expect(r.out).toContain("mine:");
  expect(r.out).toContain("mine:testorg/demo#9\topen\tMy PR");
});

test("a group the classifier now calls write-shaped is handed off as one", () => {
  // the entry was written before npx joined the blocklist; the prompt must
  // not tell claude this one is a plain apply
  const dir = mkdtempSync(join(tmpdir(), "docket-handoff-"));
  const p = paths({ DOCKET_CONFIG_DIR: dir, DOCKET_STATE_DIR: dir } as any);
  const r = buildHandoff(
    { status: "ready", local_path: "/repo", updated_at: "t" },
    { orgs: [], repos: {} },
    p,
    "acme/demo#7",
    [denialGroup({ suggestion: "Bash(npx:*)", writeShaped: false })],
  );
  expect((r as { argv: string[] }).argv[1]).toContain("not a one-key apply");
});
