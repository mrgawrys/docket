// Take the user to a PR's working copy: the visit policy picks it
// (checkout.ts), this records what it picked the way a run does — so the next
// keypress is instant and cleanup knows which copies docket made.

import { existsSync } from "node:fs";
import { checkoutsDirFor, visitCheckout } from "./checkout";
import { prMineInfo } from "./github";
// type-only: a keypress must not pull the runner in at runtime
import type { Ctx } from "./reviewer";
import { patchEntry, splitKey, type Entry } from "./state";

export type Visited =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export function visitEntry(ctx: Ctx, key: string, entry: Entry): Visited {
  const { repo, number } = splitKey(key);
  const clone = entry.local_path ?? ctx.cfg.repos[repo];
  if (!clone || !existsSync(clone))
    return { ok: false, reason: "no local clone mapped" };
  // poll records the branch, so the common keypress never reaches the network;
  // this is the cold-start path for an entry that never got one.
  const branch = entry.branch ?? prMineInfo(ctx.gh, repo, number)?.headRefName;
  if (!branch)
    return { ok: false, reason: "PR head branch unknown — S syncs it" };
  const r = visitCheckout(clone, branch, checkoutsDirFor(ctx.paths, repo));
  if (!r.ok) return r;
  const made = r.created;
  patchEntry(ctx.paths.statePath, key, {
    checkout_path: r.path,
    local_path: clone,
    branch,
    // checkout_fallback stays untouched: it is the run policy's word for its
    // own copy, a visit never makes one, and the next run rewrites it anyway.
    ...(made?.base !== undefined
      ? { fallback_bases: { ...entry.fallback_bases, [r.path]: made.base } }
      : {}),
    ...(made?.ownsBranch ? { branch_owned: true } : {}),
    ...(made && !(entry.worktrees ?? []).includes(r.path)
      ? { worktrees: [...(entry.worktrees ?? []), r.path] }
      : {}),
  });
  return { ok: true, path: r.path };
}
