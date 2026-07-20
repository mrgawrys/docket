import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Verdict = "approved" | "changes-requested" | "commented";
export type Status =
  | "reviewing" | "ready" | "failed" | "canceled" | "skipped" | "done" | Verdict;

export interface Entry {
  status: Status;
  title?: string;
  url?: string;
  local_path?: string;
  session_id?: string;
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
  if (!existsSync(statePath)) writeFileSync(statePath, "{}\n");
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

export function updateEntry(
  statePath: string,
  key: string,
  fn: (e: Entry | undefined) => Entry,
): void {
  const s = loadState(statePath);
  s[key] = fn(s[key]);
  saveState(statePath, s);
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
