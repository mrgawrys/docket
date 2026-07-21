import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log";
import { pidAlive } from "./proc";

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
    let pid = NaN;
    try {
      pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
    } catch {
      // unreadable pid file → treat as stale
    }
    if (Number.isFinite(pid) && pidAlive(pid)) {
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
