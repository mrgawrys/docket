import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { claudeBin, notifyEnabled, type Config, type Paths } from "./config";
import type { GhCtx } from "./github";
import type { Logger } from "./log";
import { notify } from "./notify";
import { loadState, splitKey, timestamp, updateEntry } from "./state";

export const ALLOWED_TOOLS =
  "Read,Grep,Glob,Task,Agent,TodoWrite,Skill(code-review),Skill(code-review:code-review),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),Bash(gh pr list:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git fetch:*),Bash(git worktree:*),Bash(git checkout:*),Bash(git branch:*),Bash(cd:*),Bash(echo:*)";

export function reviewPrompt(number: string, note?: string): string {
  let p =
    `Create a git worktree for PR #${number} at .worktrees/pr-${number} ` +
    `(fetch the PR branch first). Do ALL branch checkouts and code inspection ` +
    `inside that worktree — never modify the main working copy. Then review ` +
    `the PR by running /code-review ${number}. Keep the worktree in place ` +
    `afterwards so follow-up questions can use it.`;
  if (note) p += `\n\nAdditional context from the reviewer: ${note}`;
  return p;
}

export interface Counters {
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

export function removeWorktree(ctx: Ctx, key: string, logPrefix: string): void {
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

export async function reviewPr(
  ctx: Ctx,
  key: string,
  repo: string,
  number: string,
  title: string,
  url: string,
  note?: string,
): Promise<void> {
  const { statePath } = ctx.paths;
  const localPath = ctx.cfg.repos[repo];
  const enabled = notifyEnabled(ctx.cfg);

  if (!localPath || !existsSync(localPath)) {
    ctx.log(`SKIP ${key}: no local clone mapped`);
    updateEntry(statePath, key, () => ({
      status: "skipped", title, url, updated_at: timestamp(),
    }));
    await notify(enabled, "auto-review: no local clone", key);
    ctx.counters.skipped++;
    return;
  }

  updateEntry(statePath, key, () => ({
    status: "reviewing", title, url, local_path: localPath, updated_at: timestamp(),
  }));
  ctx.current.key = key;
  ctx.log(`REVIEW ${key} in ${localPath} — headless /code-review running, this takes a few minutes`);

  const env: Record<string, string | undefined> = { ...process.env };
  if (ctx.cfg.claude_config_dir) env.CLAUDE_CONFIG_DIR = ctx.cfg.claude_config_dir;
  const proc = Bun.spawn(
    [
      claudeBin(ctx.cfg), "-p", reviewPrompt(number, note),
      "--output-format", "json", "--permission-mode", "dontAsk",
      "--allowedTools", ALLOWED_TOOLS,
    ],
    { cwd: localPath, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
  );
  // Exposed so a SIGINT/SIGTERM handler can kill the child promptly — spawnSync
  // would otherwise block the JS thread until claude exits on its own.
  ctx.current.child = proc;
  const exitCode = await proc.exited;
  ctx.current.child = undefined;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  appendFileSync(ctx.paths.logPath, stderr);

  let sessionId = "";
  if (exitCode === 0) {
    try {
      sessionId = JSON.parse(stdout).session_id ?? "";
    } catch {
      // non-JSON output → treated as failure below
    }
  }

  if (sessionId) {
    updateEntry(statePath, key, () => ({
      status: "ready", session_id: sessionId, title, url,
      local_path: localPath, updated_at: timestamp(),
    }));
    ctx.log(`READY ${key} session=${sessionId} — run \`reviews\` to open it`);
    await notify(enabled, `Review ready: ${key}`, title);
    ctx.counters.reviewed++;
  } else {
    updateEntry(statePath, key, () => ({
      status: "failed", title, url, local_path: localPath,
      error: "claude run failed, see auto-review.log", updated_at: timestamp(),
    }));
    ctx.log(`FAILED ${key} — retry with: reviews retry ${key}`);
    await notify(enabled, `Review FAILED: ${key}`, title);
    ctx.counters.failed++;
  }
  ctx.current.key = "";
}
