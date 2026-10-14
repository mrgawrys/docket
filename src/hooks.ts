import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prView, type GhCtx } from "./github";
import type { Paths } from "./config";
import type { Ctx } from "./reviewer";
import {
  loadState,
  patchEntry,
  splitKey,
  timestamp,
  type Entry,
} from "./state";

export const HOOK_EVENTS = ["opened", "merged"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_MAX_ATTEMPTS = 3;
export const HOOK_TIMEOUT_MS = 60_000;

export interface HookRecord {
  at: string;
  ok: boolean;
  attempts: number;
  // Ran nothing: no hook existed, or the entry predates hooks. Adding a hook
  // later must not replay the event on old PRs.
  none?: boolean;
  did?: string[];
  warn?: string[];
  error?: string;
}

export interface Todo {
  text: string;
  link?: string;
  done?: boolean;
  source: "note" | "hook" | "manual";
}

export interface HookOutput {
  todos: { text: string; link?: string }[];
  did: string[];
  warn: string[];
  log: string[];
}

export interface HookPayload {
  event: HookEvent;
  dry_run: boolean;
  pr: {
    repo: string;
    number: number;
    url: string;
    title: string;
    branch: string;
    base: string;
    draft: boolean;
    labels: string[];
    merged_at: string | null;
    body: string;
    files: string[];
    comments: { author: string; body: string }[];
  };
  notes: string[];
  local_path: string | null;
}

export interface HookRun {
  ok: boolean;
  output: HookOutput;
  error?: string;
}

export const hooksDir = (p: Paths): string => join(p.configDir, "hooks");

export function hookPath(p: Paths, event: HookEvent): string | null {
  const path = join(hooksDir(p), event);
  return existsSync(path) ? path : null;
}

export function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function listHooks(p: Paths): string[] {
  const dir = hooksDir(p);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) =>
    (HOOK_EVENTS as readonly string[]).includes(f),
  );
}

// Unchecked task-list items under an "After merge" heading, up to the next
// heading of the same or higher level.
export function parseAfterMerge(body: string | null | undefined): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const items: string[] = [];
  let level = 0;
  for (const line of lines) {
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const depth = h[1]!.length;
      if (level && depth <= level) break;
      if (!level && /^after merge:?$/i.test(h[2]!.trim())) level = depth;
      continue;
    }
    if (!level) continue;
    const item = line.match(/^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/);
    if (item) items.push(item[1]!);
  }
  return items;
}

export function parseHookOutput(stdout: string): HookOutput {
  const out: HookOutput = { todos: [], did: [], warn: [], log: [] };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      out.log.push(raw);
      continue;
    }
    if (!obj || typeof obj !== "object") {
      out.log.push(raw);
      continue;
    }
    const o = obj as Record<string, unknown>;
    if (typeof o.todo === "string" && o.todo.trim())
      out.todos.push({
        text: o.todo.trim(),
        ...(typeof o.link === "string" && o.link ? { link: o.link } : {}),
      });
    else if (typeof o.did === "string") out.did.push(o.did);
    else if (typeof o.warn === "string") out.warn.push(o.warn);
    else out.log.push(raw);
  }
  return out;
}

export function isDue(entry: Entry, event: HookEvent): boolean {
  const rec = entry.hooks?.[event];
  if (!rec) return true;
  return !rec.ok && rec.attempts < HOOK_MAX_ATTEMPTS;
}

export function openedDue(
  entry: Entry,
  pr: { state: string; isDraft: boolean },
): boolean {
  return pr.state === "OPEN" && !pr.isDraft && isDue(entry, "opened");
}

// The record a run leaves behind. A failure keeps counting attempts; any
// earlier attempt's did/warn is replaced, never accumulated.
export function nextRecord(
  prev: HookRecord | undefined,
  run: HookRun | "none",
  at: string,
): HookRecord {
  if (run === "none") return { at, ok: true, attempts: 0, none: true };
  const attempts = (prev?.attempts ?? 0) + 1;
  return {
    at,
    ok: run.ok,
    attempts,
    ...(run.output.did.length ? { did: run.output.did } : {}),
    ...(run.output.warn.length ? { warn: run.output.warn } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

export function mergeTodos(
  notes: string[],
  hookTodos: { text: string; link?: string }[],
): Todo[] {
  return [
    ...notes.map((text) => ({ text, source: "note" as const })),
    ...hookTodos.map((t) => ({ ...t, source: "hook" as const })),
  ];
}

export const openTodos = (e: Entry): Todo[] =>
  (e.todos ?? []).filter((t) => !t.done);

export function toggleTodo(todos: Todo[], i: number): Todo[] {
  return todos.map((t, j) => (j === i ? { ...t, done: !t.done } : t));
}

export const firstOpenLink = (e: Entry): string | undefined =>
  openTodos(e).find((t) => t.link)?.link;

export function addTodo(statePath: string, key: string, text: string): string {
  const e = loadState(statePath)[key];
  if (!e) return `${key}: gone`;
  patchEntry(statePath, key, {
    todos: [...(e.todos ?? []), { text, source: "manual" }],
  });
  return `added: ${text}`;
}

// Tick or untick to-do i (0-based); the last one ticked retires the entry.
export function tickTodo(statePath: string, key: string, i: number): string {
  const e = loadState(statePath)[key];
  const todo = e?.todos?.[i];
  if (!e || !todo) return `${key}: no to-do ${i + 1}`;
  const todos = toggleTodo(e.todos!, i);
  const left = todos.filter((t) => !t.done).length;
  patchEntry(statePath, key, {
    todos,
    ...(left === 0 ? { status: "done" as const } : {}),
  });
  if (left === 0) return `${key}: all done`;
  return `${todo.done ? "reopened" : "done"}: ${todo.text}`;
}

export async function runHook(
  path: string,
  payload: HookPayload,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = HOOK_TIMEOUT_MS,
): Promise<HookRun> {
  const empty: HookOutput = { todos: [], did: [], warn: [], log: [] };
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([path], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, output: empty, error: `cannot run ${path}: ${e}` };
  }
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  // Race, not await: a hook's own children can hold stdout open long after
  // the hook itself is killed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]),
    new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (result === "timeout") {
    proc.kill("SIGKILL");
    return {
      ok: false,
      output: empty,
      error: `timed out after ${timeoutMs / 1000}s`,
    };
  }
  const [stdout, stderr, code] = result;
  const output = parseHookOutput(stdout);
  if (stderr.trim()) output.log.push(...stderr.trimEnd().split("\n"));
  if (code !== 0) {
    const last = stderr.trim().split("\n").at(-1);
    return {
      ok: false,
      output,
      error: `exit ${code}${last ? `: ${last}` : ""}`,
    };
  }
  return { ok: true, output };
}

interface RawHookPr {
  number?: number;
  url?: string;
  title?: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  labels?: { name?: string }[];
  mergedAt?: string | null;
  files?: { path?: string }[];
  comments?: { author?: { login?: string }; body?: string }[];
}

export const HOOK_PR_FIELDS =
  "number,url,title,body,headRefName,baseRefName,isDraft,labels,mergedAt,files,comments";

export function buildPayload(
  gh: GhCtx,
  repo: string,
  number: string,
  event: HookEvent,
  dryRun: boolean,
  localPath: string | null,
): HookPayload | null {
  const raw = prView<RawHookPr>(gh, repo, number, HOOK_PR_FIELDS);
  if (!raw) return null;
  const body = raw.body ?? "";
  return {
    event,
    dry_run: dryRun,
    pr: {
      repo,
      number: raw.number ?? Number(number),
      url: raw.url ?? "",
      title: raw.title ?? "",
      branch: raw.headRefName ?? "",
      base: raw.baseRefName ?? "",
      draft: raw.isDraft ?? false,
      labels: (raw.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
      merged_at: raw.mergedAt || null,
      body,
      files: (raw.files ?? []).map((f) => f.path ?? "").filter(Boolean),
      comments: (raw.comments ?? []).map((c) => ({
        author: c.author?.login ?? "",
        body: c.body ?? "",
      })),
    },
    notes: parseAfterMerge(body),
    local_path: localPath,
  };
}

export interface Fired {
  // false: try again next poll (gh failed, or a failed attempt with retries left)
  settled: boolean;
  notes: string[];
  todos: { text: string; link?: string }[];
  error?: string;
}

// Run one event's hook for a mine entry and record the outcome on it.
export async function fireEvent(
  ctx: Ctx,
  key: string,
  event: HookEvent,
): Promise<Fired> {
  const { statePath } = ctx.paths;
  const entry = loadState(statePath)[key];
  const path = hookPath(ctx.paths, event);
  const record = (rec: HookRecord) =>
    patchEntry(statePath, key, {
      hooks: { ...(loadState(statePath)[key]?.hooks ?? {}), [event]: rec },
    });
  // opened needs nothing from the PR when there is no hook; merged always
  // needs the body for its After-merge notes
  if (!path && event === "opened") {
    record(nextRecord(entry?.hooks?.[event], "none", timestamp()));
    return { settled: true, notes: [], todos: [] };
  }
  const { repo, number } = splitKey(key);
  const payload = buildPayload(
    ctx.gh,
    repo,
    number,
    event,
    false,
    entry?.local_path ?? null,
  );
  if (!payload) {
    ctx.log(`HOOK ${key} ${event}: gh pr view failed, retrying next poll`);
    return { settled: false, notes: [], todos: [] };
  }
  if (!path) {
    record(nextRecord(entry?.hooks?.[event], "none", timestamp()));
    return { settled: true, notes: payload.notes, todos: [] };
  }
  const run = isExecutable(path)
    ? await runHook(path, payload, hooksDir(ctx.paths), {
        ...(process.env as Record<string, string>),
        ...ctx.gh.env,
      })
    : {
        ok: false,
        output: { todos: [], did: [], warn: [], log: [] },
        error: `${path} is not executable`,
      };
  for (const line of run.output.log) ctx.log(`HOOK ${key} ${event}: ${line}`);
  const rec = nextRecord(entry?.hooks?.[event], run, timestamp());
  record(rec);
  if (run.ok) {
    ctx.log(
      `HOOK ${key} ${event}: ok${rec.did ? ` — ${rec.did.join("; ")}` : ""}`,
    );
    return { settled: true, notes: payload.notes, todos: run.output.todos };
  }
  const exhausted = rec.attempts >= HOOK_MAX_ATTEMPTS;
  ctx.log(
    `HOOK ${key} ${event}: failed (${run.error}), attempt ${rec.attempts}/${HOOK_MAX_ATTEMPTS}`,
  );
  return {
    settled: exhausted,
    notes: payload.notes,
    todos: [],
    error: run.error,
  };
}
