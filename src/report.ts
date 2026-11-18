import type { Ctx } from "./reviewer";
import { entryKind, loadState, patchEntry } from "./state";
import { toSummary, type Summary } from "./summary";
import { syncMineKey } from "./sync";

export interface Verdict {
  code: number;
  message: string;
}

const FLAGS: Record<string, keyof Summary> = {
  "--headline": "headline",
  "--issues": "issues",
  "--risk": "risk",
  "--addressed": "addressed",
  "--deferred": "deferred",
};
const NUMERIC = new Set<keyof Summary>(["issues", "addressed", "deferred"]);

// Every rejection names what to fix: the caller is an agent that retries.
export function parseReport(args: string[]): Summary | { error: string } {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const field = FLAGS[flag];
    if (!field) return { error: `unknown flag: ${arg}` };
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    raw[field] = NUMERIC.has(field) ? Number(value) : value;
  }
  const summary = toSummary(raw) ?? {};
  for (const field of Object.keys(raw) as (keyof Summary)[]) {
    if (summary[field] === undefined)
      return { error: `bad value for --${field}: ${String(raw[field])}` };
  }
  if (Object.keys(summary).length === 0)
    return {
      error: `nothing to report — pass at least one of ${Object.keys(FLAGS).join(", ")}`,
    };
  return summary;
}

export function reportKey(ctx: Ctx, key: string, args: string[]): Verdict {
  if (!loadState(ctx.paths.statePath)[key])
    return { code: 1, message: `unknown key: ${key}` };
  const parsed = parseReport(args);
  if ("error" in parsed) return { code: 1, message: parsed.error };
  patchEntry(ctx.paths.statePath, key, { summary: parsed });
  return { code: 0, message: `reported ${key}` };
}

export async function handledKey(
  ctx: Ctx,
  key: string,
  sync: (ctx: Ctx, key: string) => Promise<boolean> = syncMineKey,
): Promise<Verdict> {
  const entry = loadState(ctx.paths.statePath)[key];
  if (!entry) return { code: 1, message: `unknown key: ${key}` };
  if (entryKind(key) !== "mine")
    return { code: 1, message: `${key} is not one of your PRs` };
  if (entry.status !== "ready")
    return {
      code: 1,
      message: `${key} is ${entry.status}, not ready — nothing to mark`,
    };
  // open is a status sync refreshes from the reviewers' standing, so the
  // sync right after lands the row on their verdict.
  patchEntry(ctx.paths.statePath, key, { status: "open" });
  if (!(await sync(ctx, key)))
    return {
      code: 0,
      message: `${key} marked open — GitHub could not be read, the next poll shows the reviewers' verdict`,
    };
  const now = loadState(ctx.paths.statePath)[key]?.status ?? "open";
  return { code: 0, message: `${key} marked handled — now ${now}` };
}
