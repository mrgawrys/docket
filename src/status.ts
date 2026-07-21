import { existsSync, readFileSync, statSync, watchFile } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { runLogPath } from "./config";
import { liveRunners } from "./list";
import type { Ctx } from "./reviewer";
import { followRunLog } from "./runlog";
import { loadState, normalizeKey, type State } from "./state";

export const launchdLabel = (): string => `com.${userInfo().username}.auto-review`;

export function stateCounts(s: State): string {
  const entries = Object.values(s);
  if (entries.length === 0) return "empty";
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
}

function launchdLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  const p = Bun.spawnSync(
    ["launchctl", "print", `gui/${process.getuid!()}/${launchdLabel()}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  return p.exitCode === 0;
}

function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).slice(-n);
}

export async function statusCommand(ctx: Ctx): Promise<number> {
  console.log(
    launchdLoaded()
      ? "poller:  ON (launchd) — 'reviews off' to disable"
      : "poller:  OFF — 'reviews on' to enable, or run 'reviews poll' manually",
  );
  try {
    const pid = Number(readFileSync(join(ctx.paths.lockDir, "pid"), "utf8").trim());
    process.kill(pid, 0);
    console.log(`poll:    running right now (pid ${pid})`);
  } catch {
    // no live poll
  }
  const s = loadState(ctx.paths.statePath);
  const running = liveRunners(s);
  if (running.length) console.log(`running: ${running.join(", ")}`);
  console.log(`state:   ${stateCounts(s)}`);
  console.log(`log:     last lines of ${ctx.paths.logPath}`);
  for (const line of tailLines(ctx.paths.logPath, 3)) console.log(`         ${line}`);
  return 0;
}

export async function logCommand(ctx: Ctx, n: number): Promise<number> {
  for (const line of tailLines(ctx.paths.logPath, n)) console.log(line);
  return 0;
}

export async function watchCommand(ctx: Ctx, rawKey?: string): Promise<number> {
  if (rawKey !== undefined) {
    let key: string;
    try {
      key = normalizeKey(rawKey);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    return followRunLog(runLogPath(ctx.paths, key));
  }
  const path = ctx.paths.logPath;
  for (const line of tailLines(path, 10)) console.log(line);
  let offset = existsSync(path) ? statSync(path).size : 0;
  watchFile(path, { interval: 500 }, () => {
    if (!existsSync(path)) return; // fires even for a missing file (fresh install, log deleted mid-watch)
    const size = statSync(path).size;
    if (size < offset) offset = 0; // log rotated/truncated
    if (size > offset) {
      const fd = readFileSync(path, "utf8");
      process.stdout.write(fd.slice(offset));
      offset = size;
    }
  });
  return new Promise(() => {}); // runs until Ctrl+C
}
