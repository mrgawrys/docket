import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeBin, claudeEnv, runLogPath, type Config, type Paths } from "./config";
import type { GhCtx } from "./github";
import type { Logger } from "./log";
import { notify } from "./notify";
import { selfArgs } from "./proc";
import { parseRunEvent, tailLines } from "./runlog";
import {
  isLiveReview, loadState, patchEntry, setStatus, splitKey, timestamp, updateEntry, type Entry,
} from "./state";

// Everything the /code-review skill's agents run, read-only. Deliberately
// absent: `gh pr comment` and broad `gh api` — the headless run must never
// post to GitHub; the user opens the ready session and posts themselves.
export const ALLOWED_TOOLS =
  "Read,Grep,Glob,Task,Agent,TodoWrite,Skill(code-review),Skill(code-review:code-review),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),Bash(gh pr list:*),Bash(gh api user:*),Bash(gh search:*),Bash(gh issue view:*),Bash(gh issue list:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git blame:*),Bash(git fetch:*),Bash(git worktree:*),Bash(git checkout:*),Bash(git branch:*),Bash(cd:*),Bash(echo:*)";

// Where a PR's worktree lives, relative to the clone — the prompt tells claude
// to create it here and cleanupEntry removes it; one definition keeps them in sync.
export const prWorktree = (number: string): string => `.worktrees/pr-${number}`;

export function reviewPrompt(number: string, note?: string): string {
  let p =
    `Create a git worktree for PR #${number} at ${prWorktree(number)} ` +
    `(fetch the PR branch first). Do ALL branch checkouts and code inspection ` +
    `inside that worktree — never modify the main working copy. Then review ` +
    `the PR by running /code-review ${number}. Keep the worktree in place ` +
    `afterwards so follow-up questions can use it.`;
  if (note) p += `\n\nAdditional context from the reviewer: ${note}`;
  return p;
}

export interface Counters {
  started: number;
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
  current: { key: string; child?: { kill(sig?: number | string): void } };
}

// Retire an entry's on-disk artifacts: its run log and its PR worktree.
export function cleanupEntry(ctx: Ctx, key: string, logPrefix: string): void {
  rmSync(runLogPath(ctx.paths, key), { force: true });
  const { number } = splitKey(key);
  const path = loadState(ctx.paths.statePath)[key]?.local_path;
  const wt = prWorktree(number);
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

// Mark the PR as reviewing and hand it to a detached `reviews exec` runner.
// Detached = own process group: ctrl+c on the caller and launchd's cleanup of
// an exiting poll can't kill an in-flight review, and N runners go in parallel.
export type StartResult = "started" | "skipped" | "already-running" | "spawn-failed";

// The one no-local-clone skip policy, shared by spawner and runner.
async function skipNoClone(ctx: Ctx, key: string, extra: Partial<Entry>): Promise<void> {
  ctx.log(`SKIP ${key}: no local clone mapped`);
  patchEntry(ctx.paths.statePath, key, { status: "skipped", ...extra });
  await notify(ctx.cfg, "auto-review: no local clone", key);
  ctx.counters.skipped++;
}

export async function startReview(
  ctx: Ctx,
  key: string,
  repo: string,
  title: string,
  url: string,
  note?: string,
): Promise<StartResult> {
  const { statePath } = ctx.paths;
  const localPath = ctx.cfg.repos[repo];

  if (!localPath || !existsSync(localPath)) {
    await skipNoClone(ctx, key, { title, url });
    return "skipped";
  }

  const existing = loadState(statePath)[key];
  if (existing && isLiveReview(existing)) {
    ctx.log(`SKIP ${key}: already being reviewed (pid ${existing.pid})`);
    return "already-running";
  }

  updateEntry(statePath, key, () => ({
    status: "reviewing", title, url, local_path: localPath,
    ...(note !== undefined ? { note } : {}), updated_at: timestamp(),
  }));

  const argv = selfArgs("exec", key);
  const fd = openSync(ctx.paths.logPath, "a");
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true, stdio: ["ignore", fd, fd],
    env: process.env as Record<string, string>,
  });
  child.unref();
  closeSync(fd);

  if (child.pid === undefined) {
    setStatus(statePath, key, "failed", "could not spawn review runner");
    ctx.counters.failed++;
    return "spawn-failed";
  }
  const pid = child.pid;
  // guard: with a fast review the runner may already have written its result
  updateEntry(statePath, key, (e) =>
    e && e.status === "reviewing" ? { ...e, pid } : e!,
  );
  ctx.log(`STARTED ${key} — background /code-review runner pid ${pid}`);
  ctx.counters.started++;
  return "started";
}

// The body of one review — runs inside the detached `reviews exec` process.
export async function execReview(ctx: Ctx, key: string): Promise<number> {
  const { statePath } = ctx.paths;
  const entry = loadState(statePath)[key];
  if (!entry) {
    console.error(`unknown key: ${key} — start it with: reviews review ${key}`);
    return 1;
  }
  if (isLiveReview(entry, process.pid)) {
    ctx.log(`SKIP ${key}: already being reviewed (pid ${entry.pid})`);
    return 0;
  }
  const { repo, number } = splitKey(key);
  const localPath = entry.local_path ?? ctx.cfg.repos[repo];
  const title = entry.title ?? "";

  if (!localPath || !existsSync(localPath)) {
    await skipNoClone(ctx, key, {});
    return 1;
  }

  patchEntry(statePath, key, {
    status: "reviewing", local_path: localPath, pid: process.pid,
  });
  ctx.current.key = key;
  ctx.log(`REVIEW ${key} in ${localPath} — headless /code-review running, this takes a few minutes`);

  // gh.env carries GH_TOKEN when gh_account is pinned — claude runs gh itself
  const env = { ...ctx.gh.env, ...claudeEnv(ctx.cfg) };
  const runLog = runLogPath(ctx.paths, key);
  mkdirSync(dirname(runLog), { recursive: true });
  const proc = Bun.spawn(
    [
      claudeBin(ctx.cfg), "-p", reviewPrompt(number, entry.note),
      "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
      "--allowedTools", ALLOWED_TOOLS,
    ],
    { cwd: localPath, env, stdout: "pipe", stderr: "pipe" },
  );
  // Exposed so a SIGINT/SIGTERM handler can kill the child promptly — spawnSync
  // would otherwise block the JS thread until claude exits on its own.
  ctx.current.child = proc;
  const stderrDone = new Response(proc.stderr).text();
  // tee progress into the run log as it happens — `reviews` watches this file
  const fd = openSync(runLog, "w");
  try {
    for await (const chunk of proc.stdout) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  const exitCode = await proc.exited;
  ctx.current.child = undefined;
  appendFileSync(ctx.paths.logPath, await stderrDone);

  let sessionId = "";
  if (exitCode === 0) {
    // a well-formed run ends with a stream-json result event carrying the session
    const ev = parseRunEvent(tailLines(runLog, 1)[0] ?? "");
    if (ev?.type === "result") sessionId = ev.session_id ?? "";
  }

  const url = entry.url ?? "";
  if (sessionId) {
    updateEntry(statePath, key, () => ({
      status: "ready", session_id: sessionId, title, url,
      local_path: localPath, updated_at: timestamp(),
    }));
    ctx.log(`READY ${key} session=${sessionId} — run \`reviews\` to open it`);
    await notify(ctx.cfg, `Review ready: ${key}`, title);
    ctx.counters.reviewed++;
  } else {
    updateEntry(statePath, key, () => ({
      status: "failed", title, url, local_path: localPath,
      error: "claude run failed, see auto-review.log", updated_at: timestamp(),
    }));
    ctx.log(`FAILED ${key} — retry with: reviews retry ${key}, or check your setup: reviews doctor`);
    await notify(ctx.cfg, `Review FAILED: ${key}`, title);
    ctx.counters.failed++;
  }
  ctx.current.key = "";
  return 0;
}
