import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildResume, killEntry, parseChoice, renderList } from "../src/list";
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
  expect(parseChoice("w1", 5)).toEqual({ action: "watch", index: 0 });
  expect(parseChoice("k2", 5)).toEqual({ action: "kill", index: 1 });
  expect(parseChoice("wx", 5)).toBeNull();
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
      status: "ready", session_id: "s", title: "Demo PR", url: "u",
      local_path: sb.demoRepo, updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(sb.run(["dismiss", "testorg/demo#7"]).code).toBe(0);
  expect(existsSync(runLog)).toBe(false);
});

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
