import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildResume, killEntry } from "../src/list";
import { makeSandbox } from "./harness";

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
  const r = buildResume(
    { status: "reviewing", updated_at: "t" },
    { orgs: [], repos: {} },
  );
  expect(r).toHaveProperty("error");
  expect((r as { error: string }).error).toContain("w watches");
  expect((r as { error: string }).error).toContain("K kills");
});
