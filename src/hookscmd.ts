import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeBin, claudeEnv } from "./config";
import {
  buildPayload,
  HOOK_EVENTS,
  HOOK_MAX_ATTEMPTS,
  HOOK_TIMEOUT_MS,
  hookPath,
  hooksDir,
  isExecutable,
  listHooks,
  runHook,
  type HookEvent,
  type HookPayload,
} from "./hooks";
import type { Ctx } from "./reviewer";
import { bareKey, normalizeKey, splitKey } from "./state";

const USAGE = `usage:
  docket hooks                         list hooks
  docket hooks payload <pr> [--event E] print the JSON a hook would get
  docket hooks test <pr> [--event E]    dry-run the hook against a real PR
  docket hooks edit [pr]               write or change hooks with claude
events: ${HOOK_EVENTS.join(", ")} (default merged)`;

function eventArg(args: string[]): HookEvent | null {
  const i = args.indexOf("--event");
  if (i === -1) return "merged";
  const e = args[i + 1];
  return (HOOK_EVENTS as readonly string[]).includes(e ?? "")
    ? (e as HookEvent)
    : null;
}

function payloadFor(
  ctx: Ctx,
  raw: string,
  event: HookEvent,
): HookPayload | string {
  let key: string;
  try {
    key = bareKey(normalizeKey(raw));
  } catch (e) {
    return (e as Error).message;
  }
  const { repo, number } = splitKey(key);
  const p = buildPayload(
    ctx.gh,
    repo,
    number,
    event,
    true,
    ctx.cfg.repos[repo] ?? null,
  );
  return p ?? `cannot fetch ${key} from GitHub (does the PR exist?)`;
}

export const HOOKS_BRIEF = (dir: string, sample: HookPayload | null): string =>
  `You are writing docket lifecycle hooks in ${dir}.

docket runs ${dir}/<event> (any executable; events: ${HOOK_EVENTS.join(", ")})
once per PR the user authored:
- opened: the PR is first seen non-draft, or flips draft → ready
- merged: the PR merged

Contract:
- stdin: one JSON payload (shape below). cwd is ${dir}; timeout ${HOOK_TIMEOUT_MS / 1000}s.
- stdout: JSON lines — {"todo": "...", "link": "..."} adds a to-do to the PR's
  row in docket's Finished tab; {"did": "..."} and {"warn": "..."} are shown
  as what happened. Other lines go to docket's log.
- Non-zero exit or timeout = failure; docket retries next poll, up to
  ${HOOK_MAX_ATTEMPTS} attempts. Hooks MUST be idempotent.
- dry_run: true means print what you would do and change nothing.
- The payload's "notes" are the PR's unchecked "After merge" items; docket
  already turns them into to-dos — don't echo them back.
- Secrets are the hook's job; docket runs under launchd without your shell
  env. Prefer the macOS Keychain (security find-generic-password -w -s NAME).

Test every change with: docket hooks test <pr> --event <event>
(a dry run against a real PR). Make the files executable.

Ask the user what should happen on each event before writing anything.
${sample ? `\nA real payload:\n${JSON.stringify(sample, null, 2)}\n` : ""}`;

export async function hooksCommand(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list") {
    const dir = hooksDir(ctx.paths);
    const found = listHooks(ctx.paths);
    console.log(`hooks dir: ${dir}`);
    for (const e of HOOK_EVENTS) {
      const path = hookPath(ctx.paths, e);
      const note = !found.includes(e)
        ? "—"
        : isExecutable(path!)
          ? "✓"
          : "✗ not executable";
      console.log(`  ${e.padEnd(8)} ${note}`);
    }
    return 0;
  }

  if (sub === "payload" || sub === "test") {
    const event = eventArg(rest);
    if (!rest[0] || !event) {
      console.error(USAGE);
      return 1;
    }
    const payload = payloadFor(ctx, rest[0], event);
    if (typeof payload === "string") {
      console.error(payload);
      return 1;
    }
    if (sub === "payload") {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    const path = hookPath(ctx.paths, event);
    if (!path) {
      console.error(`no ${event} hook at ${join(hooksDir(ctx.paths), event)}`);
      return 1;
    }
    const run = await runHook(path, payload, hooksDir(ctx.paths), {
      ...(process.env as Record<string, string>),
      ...ctx.gh.env,
    });
    for (const n of payload.notes) console.log(`todo (note): ${n}`);
    for (const t of run.output.todos)
      console.log(`todo: ${t.text}${t.link ? ` <${t.link}>` : ""}`);
    for (const d of run.output.did) console.log(`did:  ${d}`);
    for (const w of run.output.warn) console.log(`warn: ${w}`);
    for (const l of run.output.log) console.log(`log:  ${l}`);
    console.log(run.ok ? "ok (dry run)" : `failed: ${run.error}`);
    return run.ok ? 0 : 1;
  }

  if (sub === "edit") {
    const dir = hooksDir(ctx.paths);
    mkdirSync(dir, { recursive: true });
    let sample: HookPayload | null = null;
    if (rest[0]) {
      const p = payloadFor(ctx, rest[0], "merged");
      if (typeof p === "string") {
        console.error(p);
        return 1;
      }
      sample = p;
    }
    const proc = Bun.spawn([claudeBin(ctx.cfg), HOOKS_BRIEF(dir, sample)], {
      cwd: dir,
      env: { ...process.env, ...ctx.gh.env, ...claudeEnv(ctx.cfg) },
      stdio: ["inherit", "inherit", "inherit"],
    });
    return proc.exited;
  }

  console.error(USAGE);
  return 1;
}
