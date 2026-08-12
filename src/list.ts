import { existsSync } from "node:fs";
import {
  claudeBin,
  claudeEnv,
  effectiveAllowedTools,
  runLogPath,
  type Config,
  type Paths,
} from "./config";
import { isAllowed, isWriteShaped, type DenialGroup } from "./denials";
import { handoffPrompt, type HandoffScope } from "./handoff";
import { cleanupEntry, type Ctx } from "./reviewer";
import {
  isLiveReview,
  loadState,
  pendingEntries,
  setStatus,
  type Entry,
} from "./state";

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

// Shared with the TUI's `unavailable` check, so the reason greyed in the
// legend and the reason a keypress reports are never two different sentences.
export const NO_CLONE_REASON = "no clone — nothing to run claude in";

// The escape hatch for what the denials panel's one-key apply can't settle:
// launches claude directly, in default permission mode, so the user answers
// any permission prompt an edit would trigger — never docket. `cfg` should be
// the freshest one available (`liveCfg` in the TUI), since a just-applied
// suggestion belongs in the prompt.
export function buildHandoff(
  entry: Entry,
  cfg: Config,
  paths: Paths,
  key: string,
  groups: DenialGroup[],
  scope: HandoffScope,
):
  | { argv: string[]; cwd: string; env: Record<string, string> }
  | { error: string } {
  if (!entry.local_path) {
    return { error: NO_CLONE_REASON };
  }
  if (!groups.length) {
    return { error: "nothing selected to hand off" };
  }
  const logPath = runLogPath(paths, key);
  const prompt = handoffPrompt({
    key,
    // Both flags were frozen when the run finished. The prompt states its own
    // "current extra_allowed_tools" a few lines further down, so a stale
    // already-allowed would hand claude two contradictory facts.
    groups: groups.map((g) => ({
      ...g,
      writeShaped: isWriteShaped(g.suggestion) || g.writeShaped,
      alreadyAllowed: isAllowed(g.suggestion, cfg),
    })),
    scope,
    configPath: paths.configPath,
    extraAllowedTools: cfg.extra_allowed_tools ?? [],
    effectiveAllowedTools: effectiveAllowedTools(cfg),
    runLogPath: logPath,
    runLogExists: existsSync(logPath),
  });
  return {
    // no --permission-mode: a default session hits a real prompt on any edit,
    // which is the enforcement half of "research only, change nothing"
    argv: [claudeBin(cfg), prompt],
    cwd: entry.local_path,
    env: claudeEnv(cfg),
  };
}

// Both of these are driven from the TUI, where console output is displaced
// above the frame — so they report by returning, and the caller decides
// whether that lands in a status line or on stdout.
export function dismissKey(ctx: Ctx, key: string): string {
  setStatus(ctx.paths.statePath, key, "done");
  const stuck = cleanupEntry(ctx, key, "DISMISS");
  return stuck.length
    ? `dismissed ${key} — could not remove ${stuck.join(", ")}`
    : `dismissed ${key}`;
}

export function killEntry(
  ctx: Ctx,
  key: string,
): { code: number; message: string } {
  const e = loadState(ctx.paths.statePath)[key];
  if (!e || !isLiveReview(e)) {
    return { code: 1, message: `${key}: no live review to kill` };
  }
  try {
    process.kill(e.pid!, "SIGTERM"); // the runner's handler marks the entry canceled
  } catch {
    // reconcileOrphans will settle the entry
    return { code: 1, message: `${key}: runner already exited` };
  }
  return {
    code: 0,
    message: `${key}: killed — it will show as canceled; r re-runs it`,
  };
}

// Bare `docket` without a terminal: the TUI cannot mount, so print what it
// would have shown.
export function printPending(ctx: Ctx): number {
  const rows = pendingEntries(loadState(ctx.paths.statePath));
  if (!rows.length) console.log("no pending reviews");
  for (const [key, e] of rows) {
    console.log([key, e.status, e.title ?? ""].join("\t").trimEnd());
  }
  return 0;
}
