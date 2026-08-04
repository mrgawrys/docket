import { claudeBin, claudeEnv, type Config } from "./config";
import { cleanupEntry, type Ctx } from "./reviewer";
import { isLiveReview, loadState, setStatus, type Entry } from "./state";

export function buildResume(
  entry: Entry,
  cfg: Config,
):
  | { argv: string[]; cwd: string; env: Record<string, string> }
  | { error: string } {
  if (entry.status === "reviewing") {
    return { error: "still being reviewed — w watches it live, K kills it" };
  }
  if (!entry.session_id || !entry.local_path) {
    return { error: `no session (${entry.status}) — r (re)runs the review` };
  }
  return {
    // claude stores sessions under a slug of the directory it ran in, so a
    // resume must run in the clone the review ran in, never in the worktree
    argv: [claudeBin(cfg), "--resume", entry.session_id],
    cwd: entry.local_path,
    env: claudeEnv(cfg),
  };
}

export function dismissKey(ctx: Ctx, key: string): void {
  setStatus(ctx.paths.statePath, key, "done");
  cleanupEntry(ctx, key, "DISMISS");
  console.log(`dismissed ${key}`);
}

export function killEntry(ctx: Ctx, key: string): number {
  const e = loadState(ctx.paths.statePath)[key];
  if (!e || !isLiveReview(e)) {
    console.error(`${key}: no live review to kill`);
    return 1;
  }
  try {
    process.kill(e.pid!, "SIGTERM"); // the runner's handler marks the entry canceled
  } catch {
    console.error(`${key}: runner already exited`); // reconcileOrphans will settle the entry
    return 1;
  }
  console.log(`${key}: killed — it will show as canceled; r re-runs it`);
  return 0;
}
