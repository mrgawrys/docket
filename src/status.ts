import { runLogPath } from "./config";
import { lockHolderPid } from "./lock";
import type { Ctx } from "./reviewer";
import { followFile, followRunLog, tailLines } from "./runlog";
import { launchdLoaded } from "./scheduler";
import { liveRunners, loadState, type State } from "./state";

export function stateCounts(s: State): string {
  const entries = Object.values(s);
  if (entries.length === 0) return "empty";
  const counts = new Map<string, number>();
  for (const e of entries)
    counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}

export async function statusCommand(ctx: Ctx): Promise<number> {
  console.log(
    launchdLoaded()
      ? "poller:  ON (launchd) — 'reviews off' to disable"
      : "poller:  OFF — 'reviews on' to enable, or run 'reviews poll' manually",
  );
  const pollPid = lockHolderPid(ctx.paths.lockDir);
  if (pollPid !== null)
    console.log(`poll:    running right now (pid ${pollPid})`);
  const s = loadState(ctx.paths.statePath);
  const running = liveRunners(s);
  if (running.length) console.log(`running: ${running.join(", ")}`);
  console.log(`state:   ${stateCounts(s)}`);
  console.log(`log:     last lines of ${ctx.paths.logPath}`);
  for (const line of tailLines(ctx.paths.logPath, 3))
    console.log(`         ${line}`);
  return 0;
}

export async function logCommand(ctx: Ctx, n: number): Promise<number> {
  for (const line of tailLines(ctx.paths.logPath, n)) console.log(line);
  return 0;
}

// `key` arrives already normalized — main.ts owns argument parsing.
export async function watchCommand(ctx: Ctx, key?: string): Promise<number> {
  if (key !== undefined) return followRunLog(runLogPath(ctx.paths, key));
  const path = ctx.paths.logPath;
  for (const line of tailLines(path, 10)) console.log(line);
  return followFile(path, (text) => process.stdout.write(text), {
    fromEnd: true,
  });
}
