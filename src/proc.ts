import { basename } from "node:path";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// argv to re-invoke this CLI with the given subcommand args.
// dev: `bun src/main.ts` → execPath is the bun binary; compiled: it's `reviews`
export function selfArgs(...tail: string[]): string[] {
  if (basename(process.execPath) === "bun")
    return [process.execPath, Bun.main, ...tail];
  return [process.execPath, ...tail];
}
