// Resolve the working copy for a PR branch: the user's clone, the user's
// worktree, or one docket creates under checkoutsDir. A branch that exists
// locally is where the user's work is — a blocked (dirty/ahead) copy never
// falls through to creating a second one.

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { parseWorktrees } from "./worktree";

export type CheckoutResult =
  | { ok: true; path: string; owned: boolean } // owned: created by docket (this call, or previously under checkoutsDir)
  | { ok: false; reason: string };

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
}

const fail = (what: string, r: GitResult): CheckoutResult => ({
  ok: false,
  reason: `${what}: ${r.err || r.out || "git failed"}`,
});

// tmpdirs and home directories are routinely symlinked (macOS /tmp) while git
// reports real paths — compare like with like.
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);

const under = (path: string, dir: string): boolean => {
  const d = real(dir);
  return real(path) === d || real(path).startsWith(d + sep);
};

export function resolveCheckout(
  clone: string,
  branch: string,
  headSha: string,
  checkoutsDir: string,
): CheckoutResult {
  const list = git(clone, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return fail("git worktree list", list);
  const found = parseWorktrees(list.out).find(
    (w) => w.branch === `refs/heads/${branch}`,
  );

  if (found) {
    const path = found.path;
    const status = git(path, ["status", "--porcelain"]);
    if (!status.ok) return fail("git status", status);
    if (status.out) return { ok: false, reason: `checkout dirty: ${path}` };

    // The PR head may be newer than anything fetched yet — without its object
    // the ahead/behind checks below can only error out.
    if (!git(path, ["cat-file", "-e", `${headSha}^{commit}`]).ok) {
      const fetch = git(clone, ["fetch", "origin", branch]);
      if (!fetch.ok) return fail("git fetch", fetch);
    }

    const ahead = git(path, ["rev-list", "--count", `${headSha}..HEAD`]);
    if (!ahead.ok) return fail("git rev-list", ahead);
    if (Number(ahead.out) > 0)
      return { ok: false, reason: `checkout ahead of PR head: ${path}` };

    if (found.head !== headSha) {
      const ff = git(path, ["merge", "--ff-only", headSha]);
      if (!ff.ok) return fail("git merge --ff-only", ff);
    }
    return { ok: true, path, owned: under(path, checkoutsDir) };
  }

  // The branch exists nowhere locally: fetch it and give it a worktree of
  // docket's own, tracking the remote branch. Only this path is owned — the
  // caller records it in worktrees[], the set of paths docket may delete.
  const fetch = git(clone, ["fetch", "origin", branch]);
  if (!fetch.ok) return fail("git fetch", fetch);
  const path = join(checkoutsDir, branch.replace(/[^A-Za-z0-9._-]/g, "-"));
  const add = git(clone, [
    "worktree",
    "add",
    "--track",
    "-b",
    branch,
    path,
    `origin/${branch}`,
  ]);
  if (!add.ok) return fail("git worktree add", add);
  return { ok: true, path, owned: true };
}
