import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  claudeBin,
  claudeEnv,
  effectiveAllowedTools,
  effectiveReviewPrompt,
  ghBin,
  runLogPath,
  type Config,
  type Paths,
} from "./config";
import type { GhCtx } from "./github";
import type { Logger } from "./log";
import { notify } from "./notify";
import { selfArgs } from "./proc";
import { parseRunEvent, tailLines } from "./runlog";
import {
  isLiveReview,
  loadState,
  patchEntry,
  setStatus,
  splitKey,
  timestamp,
  updateEntry,
  type Entry,
} from "./state";
import {
  parseWorktrees,
  pickReviewWorktrees,
  type WorktreeInfo,
} from "./worktree";

// Fixed worktree hygiene wraps a configurable task body. The preamble (work in
// an isolated worktree, never touch the main copy) and the suffix (keep it
// afterwards) are NOT configurable; only the middle is. We deliberately do not
// dictate the worktree's path — the agent follows its own conventions — and
// discover where it landed afterwards (see recordWorktrees).
export function reviewPrompt(
  number: string,
  repo: string,
  cfg: Config,
  note?: string,
): string {
  const body = effectiveReviewPrompt(cfg)
    .replaceAll("{number}", number)
    .replaceAll("{repo}", repo);
  let p =
    `Create a git worktree to review PR #${number} (fetch the PR branch ` +
    `first), following your usual worktree conventions. Do ALL branch ` +
    `checkouts and code inspection inside that worktree — never modify the ` +
    `main working copy.\n\n` +
    `${body}\n\n` +
    `Keep the worktree in place afterwards so follow-up questions can use it.`;
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

// The PR's head commit, used to pin which freshly-created worktree is the
// review's. Best-effort: on any gh failure we return undefined and record every
// newly-appeared worktree instead (see pickReviewWorktrees).
function prHeadSha(
  ctx: Ctx,
  clone: string,
  number: string,
): string | undefined {
  const p = Bun.spawnSync(
    [ghBin(), "pr", "view", number, "--json", "headRefOid"],
    {
      cwd: clone,
      env: { ...process.env, ...ctx.gh.env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (p.exitCode !== 0) return undefined;
  try {
    const sha = JSON.parse(p.stdout.toString()).headRefOid;
    return typeof sha === "string" && sha ? sha : undefined;
  } catch {
    return undefined;
  }
}

// List a clone's registered worktrees (absolute paths + head/branch), or [].
function listWorktrees(clone: string): WorktreeInfo[] {
  const p = Bun.spawnSync(
    ["git", "-C", clone, "worktree", "list", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return p.exitCode === 0 ? parseWorktrees(p.stdout.toString()) : [];
}

// Legacy/orphan fallback for entries written before we recorded worktree paths:
// match any registered worktree named pr-<number> (the old convention, and the
// native `.claude/worktrees/pr-N` layout).
function legacyWorktrees(clone: string, number: string): string[] {
  return listWorktrees(clone)
    .map((w) => w.path)
    .filter((p) => basename(p) === `pr-${number}`);
}

function removeWorktree(
  ctx: Ctx,
  clone: string,
  wt: string,
  key: string,
  logPrefix: string,
): void {
  if (!existsSync(wt)) return; // already gone; prune will drop the admin record
  const p = Bun.spawnSync(
    ["git", "-C", clone, "worktree", "remove", "--force", wt],
    { stderr: "pipe" },
  );
  appendFileSync(ctx.paths.logPath, p.stderr.toString());
  ctx.log(
    p.exitCode === 0
      ? `${logPrefix} ${key}: removed worktree ${wt}`
      : `${logPrefix} ${key}: could not remove worktree ${wt}`,
  );
}

// Retire an entry's on-disk artifacts: its run log and the worktree(s) the
// review created — by their recorded absolute paths, wherever the agent put
// them, falling back to the pr-<number> convention for legacy entries.
export function cleanupEntry(ctx: Ctx, key: string, logPrefix: string): void {
  rmSync(runLogPath(ctx.paths, key), { force: true });
  const { number } = splitKey(key);
  const entry = loadState(ctx.paths.statePath)[key];
  const clone = entry?.local_path;
  if (!clone || !existsSync(clone)) return;

  const recorded = entry?.worktrees ?? [];
  const targets = recorded.length ? recorded : legacyWorktrees(clone, number);
  for (const wt of targets) removeWorktree(ctx, clone, wt, key, logPrefix);

  Bun.spawnSync(["git", "-C", clone, "worktree", "prune"], { stderr: "pipe" });
}

// Mark the PR as reviewing and hand it to a detached `reviews exec` runner.
// Detached = own process group: ctrl+c on the caller and launchd's cleanup of
// an exiting poll can't kill an in-flight review, and N runners go in parallel.
export type StartResult =
  | "started"
  | "skipped"
  | "already-running"
  | "spawn-failed";

// The one no-local-clone skip policy, shared by spawner and runner.
async function skipNoClone(
  ctx: Ctx,
  key: string,
  extra: Partial<Entry>,
): Promise<void> {
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
    status: "reviewing",
    title,
    url,
    local_path: localPath,
    ...(note !== undefined ? { note } : {}),
    updated_at: timestamp(),
  }));

  const argv = selfArgs("exec", key);
  const fd = openSync(ctx.paths.logPath, "a");
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ["ignore", fd, fd],
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
    status: "reviewing",
    local_path: localPath,
    pid: process.pid,
  });
  ctx.current.key = key;
  ctx.log(
    `REVIEW ${key} in ${localPath} — headless /code-review running, this takes a few minutes`,
  );

  // Snapshot before the agent runs so we can tell which worktree it creates.
  const sha = prHeadSha(ctx, localPath, number);
  const worktreesBefore = listWorktrees(localPath).map((w) => w.path);

  // gh.env carries GH_TOKEN when gh_account is pinned — claude runs gh itself
  const env = { ...ctx.gh.env, ...claudeEnv(ctx.cfg) };
  const runLog = runLogPath(ctx.paths, key);
  mkdirSync(dirname(runLog), { recursive: true });
  const proc = Bun.spawn(
    [
      claudeBin(ctx.cfg),
      "-p",
      reviewPrompt(number, repo, ctx.cfg, entry.note),
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      effectiveAllowedTools(ctx.cfg),
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

  // Discover the worktree the agent made (any location) and record it so
  // cleanupEntry can remove it later. Persisted after the status write below,
  // which rewrites the entry wholesale.
  const worktrees = pickReviewWorktrees(
    worktreesBefore,
    listWorktrees(localPath),
    sha,
  );

  let sessionId = "";
  if (exitCode === 0) {
    // a well-formed run ends with a stream-json result event carrying the session
    const ev = parseRunEvent(tailLines(runLog, 1)[0] ?? "");
    if (ev?.type === "result") sessionId = ev.session_id ?? "";
  }

  const url = entry.url ?? "";
  if (sessionId) {
    updateEntry(statePath, key, () => ({
      status: "ready",
      session_id: sessionId,
      title,
      url,
      local_path: localPath,
      updated_at: timestamp(),
    }));
    ctx.log(`READY ${key} session=${sessionId} — run \`reviews\` to open it`);
    await notify(ctx.cfg, `Review ready: ${key}`, title);
    ctx.counters.reviewed++;
  } else {
    updateEntry(statePath, key, () => ({
      status: "failed",
      title,
      url,
      local_path: localPath,
      error: "claude run failed, see auto-review.log",
      updated_at: timestamp(),
    }));
    ctx.log(
      `FAILED ${key} — retry with: reviews retry ${key}, or check your setup: reviews doctor`,
    );
    await notify(ctx.cfg, `Review FAILED: ${key}`, title);
    ctx.counters.failed++;
  }
  if (worktrees.length) patchEntry(statePath, key, { worktrees });
  ctx.current.key = "";
  return 0;
}
