import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./log";
import { pidAlive } from "./proc";

export type Verdict = "approved" | "changes-requested" | "commented";
export type Status =
  | "reviewing" | "ready" | "failed" | "canceled" | "skipped" | "done" | Verdict;

export interface Entry {
  status: Status;
  title?: string;
  url?: string;
  local_path?: string;
  session_id?: string;
  pid?: number;
  error?: string;
  flags?: string[];
  done_reason?: "merged" | "closed";
  my_review_at?: string;
  note?: string;
  updated_at: string;
}

export type State = Record<string, Entry>;

export function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function ensureState(statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  // size check mirrors the bash original's self-heal for a truncated/empty state.json
  if (!existsSync(statePath) || statSync(statePath).size === 0) writeFileSync(statePath, "{}\n");
}

export function loadState(statePath: string): State {
  ensureState(statePath);
  return JSON.parse(readFileSync(statePath, "utf8")) as State;
}

export function saveState(statePath: string, s: State): void {
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, statePath);
}

// Parallel background runners update state concurrently; a plain
// read-modify-write would lose whichever update lands first.
function withStateLock<T>(statePath: string, fn: () => T): T {
  const lockDir = `${statePath}.lock`;
  let deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) {
        // holder died mid-write; the critical section is milliseconds
        rmSync(lockDir, { recursive: true, force: true });
        deadline = Date.now() + 5000;
        continue;
      }
      Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function updateEntry(
  statePath: string,
  key: string,
  fn: (e: Entry | undefined) => Entry,
): void {
  withStateLock(statePath, () => {
    const s = loadState(statePath);
    s[key] = fn(s[key]);
    saveState(statePath, s);
  });
}

export function setStatus(statePath: string, key: string, status: Status, error?: string): void {
  updateEntry(statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status,
    updated_at: timestamp(),
    ...(error !== undefined ? { error } : {}),
  }));
}

export function markDone(statePath: string, key: string, reason: "merged" | "closed"): void {
  updateEntry(statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status: "done",
    done_reason: reason,
    updated_at: timestamp(),
  }));
}

export function markReviewed(
  statePath: string,
  key: string,
  verdict: Verdict,
  reviewedAt: string,
  flags: string[],
): void {
  updateEntry(statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status: verdict,
    my_review_at: reviewedAt,
    flags,
    updated_at: timestamp(),
  }));
}

export function pendingEntries(s: State): [string, Entry][] {
  return Object.entries(s)
    .filter(([, e]) => e.status !== "done")
    .sort(([, a], [, b]) => a.updated_at.localeCompare(b.updated_at));
}

export function normalizeKey(input: string): string {
  let key = input;
  const url = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) key = `${url[1]}/${url[2]}#${url[3]}`;
  if (!/^[^/#\s]+\/[^/#\s]+#\d+$/.test(key)) {
    throw new Error(`cannot parse '${input}' — expected ORG/REPO#NUM or a GitHub PR URL`);
  }
  return key;
}

export function splitKey(key: string): { repo: string; number: string } {
  const i = key.lastIndexOf("#");
  return { repo: key.slice(0, i), number: key.slice(i + 1) };
}

export function reconcileOrphans(statePath: string, log: Logger): void {
  const s = loadState(statePath);
  for (const [key, e] of Object.entries(s)) {
    if (e.status !== "reviewing") continue;
    if (e.pid !== undefined && pidAlive(e.pid)) continue; // live background runner
    // a just-spawned runner records its pid within moments — give it a grace period
    if (e.pid === undefined && Date.now() - Date.parse(e.updated_at) < 2 * 60_000) continue;
    setStatus(statePath, key, "failed", "previous run died mid-review");
    log(`ORPHAN ${key}: previous run died mid-review, marked failed — retry with: reviews retry ${key}`);
  }
}
