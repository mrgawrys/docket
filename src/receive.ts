// The receive side of the review loop: build the prompt a receive run gets,
// gate the automatic path, and resolve+record the checkout it runs in.

import { existsSync } from "node:fs";
import { checkoutsDirFor, resolveCheckout } from "./checkout";
import { effectiveReceivePrompt, type Config } from "./config";
import { prMineInfo } from "./github";
// type-only: receive.ts must not pull the runner in at runtime (reviewer.ts
// imports this module for the mine RunPlan)
import type { Ctx } from "./reviewer";
import { patchEntry, splitKey, type Entry } from "./state";
import { selfCommand } from "./proc";
import { receiveSummaryInstruction } from "./summary";

// The author opens the session to review each point in turn, so the report is
// fixed like the summary: a custom receive_prompt changes the work, not this.
export const RECEIVE_REPORT_INSTRUCTION =
  `Report each review point in its own section, in the order the feedback ` +
  `was given, so the author can read them one at a time. Each section ` +
  `stands on its own:\n` +
  `- a heading that says what came of the point (fixed, declined, deferred, ` +
  `needs your call);\n` +
  `- for a comment on a line, the code it is on, the way GitHub shows it ` +
  `above the thread: the last few lines of the comment's \`diff_hunk\`, ` +
  `ending at the commented line, in a \`diff\` fence;\n` +
  `- the reviewer's comment quoted in full, with who wrote it and the file ` +
  `and line it is on;\n` +
  `- enough context to judge it without opening an editor: what the code ` +
  `did, and whether the reviewer was right;\n` +
  `- what you changed, as before-and-after code with the commit, or why ` +
  `you left it;\n` +
  `- a draft reply for that thread, for the author to post themselves, or ` +
  `a note that none is needed.`;

// The run ends `ready`; only the author, back in the resumed session, knows
// when the review is dealt with — so the agent moves the row then, not now.
export const receiveHandledInstruction = (self: string, key: string): string =>
  `This first run ends with your report — never run \`handled\` in it. If ` +
  `the author comes back to this session and has pushed your work, or ` +
  `settled every point another way: re-read all three feedback sources ` +
  `first. If anything arrived after your report, tell them and work it. ` +
  `Otherwise run \`${self} handled ${key}\` so docket's queue stops showing ` +
  `the review as waiting for them.`;

// Fixed checkout hygiene wraps a configurable task body, exactly like the
// review prompt: the preamble (stay in the checkout, no push, no GitHub
// writes) and the summary demand are NOT configurable; only the middle is.
export function receivePrompt(
  cfg: Config,
  key: string,
  entry: Entry,
  note?: string,
  self = selfCommand(),
): string {
  const { repo, number } = splitKey(key);
  const body = effectiveReceivePrompt(cfg)
    .replaceAll("{number}", number)
    .replaceAll("{repo}", repo);
  const fb = entry.checkout_fallback;
  // A fallback is neither the author's checkout nor on the branch, so the
  // opener cannot claim it is either.
  const where = fb ? "a working copy" : "the checkout of its branch";
  let p =
    `You are addressing code review feedback on PR #${number} (${repo}), in ` +
    `${where} at ${entry.checkout_path ?? "."} — the ` +
    `current directory. Work ONLY in this checkout; never touch any other ` +
    `working copy. You may edit files and commit locally. NEVER push, and ` +
    `NEVER write to GitHub (no comments, no reviews, no API mutations) — ` +
    `the author reviews your work and pushes themselves.\n\n` +
    (fb
      ? `This is a fresh worktree docket created at the PR head because your ` +
        `own checkout of this branch could not be used (\`${fb.reason}\`). ` +
        `It is on a detached HEAD — that is expected. Commit normally; the ` +
        `author cherry-picks your commits onto their branch.\n\n`
      : "") +
    `The feedback lives in three places; read all of them first: inline ` +
    `thread comments via \`gh api repos/${repo}/pulls/${number}/comments\`, ` +
    `review bodies via \`gh api repos/${repo}/pulls/${number}/reviews\`, ` +
    `and conversation comments via ` +
    `\`gh api repos/${repo}/issues/${number}/comments\`. ` +
    `If none of them can be read, stop and say so — do not go looking for ` +
    `other work to do instead.\n\n` +
    `${body}\n\n${RECEIVE_REPORT_INSTRUCTION}\n\n` +
    `${receiveSummaryInstruction(self, key)}\n\n` +
    receiveHandledInstruction(self, key);
  if (note) p += `\n\nAdditional context from the author: ${note}`;
  return p;
}

// The automatic trigger's gate — and only the automatic one: docket receive
// and the R verb run regardless, though a blocked checkout still refuses.
export function shouldAutoRun(
  cfg: Config,
  entry: Entry,
): { ok: true } | { ok: false; reason: string } {
  if (!cfg.receive_enabled)
    return { ok: false, reason: "receive_enabled is off" };
  if ((entry.flags ?? []).includes("draft"))
    return { ok: false, reason: "PR is a draft" };
  return { ok: true };
}

export type PreparedCheckout =
  | { ok: true; path: string }
  | { ok: false; reason: string };

// Resolve the PR's working copy and record it on the entry. Runs at trigger
// time and again inside the run process right before spawning claude (the
// TOCTOU guard — a checkout can change between poll and spawn).
export function prepareCheckout(
  ctx: Ctx,
  key: string,
  entry: Entry,
): PreparedCheckout {
  const { repo, number } = splitKey(key);
  const clone = entry.local_path ?? ctx.cfg.repos[repo];
  if (!clone || !existsSync(clone))
    return { ok: false, reason: "no local clone mapped" };
  const info = prMineInfo(ctx.gh, repo, number);
  if (!info)
    return { ok: false, reason: "cannot fetch the PR head from GitHub" };
  const branch = info.headRefName || entry.branch;
  if (!branch) return { ok: false, reason: "PR head branch unknown" };
  const r = resolveCheckout(
    clone,
    branch,
    info.headRefOid,
    checkoutsDirFor(ctx.paths, repo),
  );
  if (!r.ok) return r;
  // Fallback or tracking worktree alike, a copy docket made records the head
  // it was handed: the keep guard tells one holding someone's commits from
  // one holding nothing by whether its HEAD has moved off this.
  const base = r.fallback?.base ?? r.created;
  patchEntry(ctx.paths.statePath, key, {
    checkout_path: r.path,
    local_path: clone,
    branch,
    // written every time, undefined included: a checkout that resolves in
    // place again must stop claiming its commits live somewhere else
    checkout_fallback: r.fallback && { reason: r.fallback.reason },
    ...(base !== undefined
      ? { fallback_bases: { ...entry.fallback_bases, [r.path]: base } }
      : {}),
    ...(r.ownsBranch ? { branch_owned: true } : {}),
    // worktrees[] means "paths docket may delete" — only a docket-created
    // checkout ever goes in.
    ...(r.owned && !(entry.worktrees ?? []).includes(r.path)
      ? { worktrees: [...(entry.worktrees ?? []), r.path] }
      : {}),
  });
  return { ok: true, path: r.path };
}
