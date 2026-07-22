import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log";
import { pidAlive } from "./proc";

// The live pid holding the lock, or null (no lock, unreadable pid file, or
// a dead holder — all treated as "nobody").
export function lockHolderPid(lockDir: string): number | null {
  let pid = NaN;
  try {
    pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
  } catch {
    return null;
  }
  return Number.isFinite(pid) && pidAlive(pid) ? pid : null;
}

export function acquireLock(lockDir: string, log: Logger): (() => void) | null {
  const tryMkdir = (): boolean => {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryMkdir()) {
    const pid = lockHolderPid(lockDir);
    if (pid !== null) {
      log(`lock held by pid ${pid}, skipping run`);
      return null;
    }
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  const release = () => rmSync(lockDir, { recursive: true, force: true });
  process.on("exit", release);
  return release;
}
