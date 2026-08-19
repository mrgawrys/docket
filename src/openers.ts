import { existsSync } from "node:fs";
import type { Config, Opener, Openers } from "./config";
import { entryKind, splitKey, type Entry } from "./state";

// First entry whose binary is on PATH wins. `git diff` is the floor of the diff
// chain: git is already required, so the chain can never come up empty.
export const DEFAULT_OPENERS: Openers = {
  shell: [{ cmd: ["$SHELL"] }],
  diff: [
    { cmd: ["revdiff", "{base}", "{head}"] },
    { cmd: ["tuicr", "-r", "{base}..{head}"] },
    { cmd: ["git", "diff", "{base}...{head}"] },
  ],
};

// A verb in config replaces that verb's default chain outright — merging would
// make it impossible to remove a default entry.
export const effectiveOpeners = (cfg: Config): Openers => ({
  ...DEFAULT_OPENERS,
  ...(cfg.openers ?? {}),
});

export type Resolve = (bin: string) => boolean;
export const onPath: Resolve = (bin) => Bun.which(bin) !== null;

// The one shell exception to "argv is exec'd directly": a login shell is the
// whole point of the `shell` verb, and only as cmd[0].
const expandShell = (bin: string, env: NodeJS.ProcessEnv): string =>
  bin === "$SHELL" ? (env.SHELL ?? "/bin/sh") : bin;

// Winning command per verb, or undefined when nothing in the chain resolves.
export type ResolvedOpeners = Record<string, string[] | undefined>;

// Resolved once per config load, not per frame: cursor movement does no PATH
// lookups, and the legend can grey out what is not installed before a keypress.
export function resolveOpeners(
  cfg: Config,
  resolve: Resolve = onPath,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpeners {
  const out: ResolvedOpeners = {};
  for (const [verb, chain] of Object.entries(effectiveOpeners(cfg))) {
    const winner = chain.find((o: Opener) =>
      resolve(expandShell(o.cmd[0] ?? "", env)),
    );
    out[verb] = winner && [
      expandShell(winner.cmd[0] ?? "", env),
      ...winner.cmd.slice(1),
    ];
  }
  return out;
}

export type Worktree = { path: string } | { missing: string };

export interface OpenerContext {
  worktree: Worktree;
  clone: string;
  // null when no base branch could be resolved — see mergeBase.
  base: string | null;
  head: string;
  number: string;
  repo: string;
  url: string;
}

export type OpenerResult =
  | { argv: string[]; cwd: string }
  | { unavailable: string };

export function buildOpener(
  verb: string,
  resolved: ResolvedOpeners,
  ctx: OpenerContext,
): OpenerResult {
  const cmd = resolved[verb];
  if (!cmd) return { unavailable: `no ${verb} opener found on PATH` };
  if ("missing" in ctx.worktree) return { unavailable: ctx.worktree.missing };
  if (ctx.base === null && cmd.some((a) => a.includes("{base}"))) {
    return {
      unavailable:
        "no base branch: none of origin/HEAD, origin/main, origin/master resolve",
    };
  }
  const tokens: Record<string, string> = {
    "{worktree}": ctx.worktree.path,
    "{clone}": ctx.clone,
    "{base}": ctx.base ?? "",
    "{head}": ctx.head,
    "{number}": ctx.number,
    "{repo}": ctx.repo,
    "{url}": ctx.url,
  };
  // Substituted per argument, never re-split: a path with spaces stays one argv slot.
  const argv = cmd.map((arg) =>
    arg.replace(
      /\{(worktree|clone|base|head|number|repo|url)\}/g,
      (t) => tokens[t] ?? t,
    ),
  );
  return { argv, cwd: ctx.worktree.path };
}

export type GitRunner = (args: string[], cwd: string) => string | null;

export const runGit: GitRunner = (args, cwd) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

// origin/HEAD is a symref plenty of clones never got — and when it is missing,
// "main" is a guess that fails outright on a master-default repo. Try the ones
// that could exist and let the verb report a missing base rather than run a
// diff against a ref that isn't there.
function mergeBase(git: GitRunner, cwd: string): string | null {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    const base = git(["merge-base", "HEAD", ref], cwd);
    if (base) return base;
  }
  return null;
}

// Never falls back to the clone when the worktree is gone: dropping the user
// somewhere they did not ask to be is worse than a disabled verb.
export function resolveWorktree(
  entry: Entry,
  exists: (p: string) => boolean = existsSync,
): Worktree {
  const path = entry.worktrees?.[0];
  if (!path) return { missing: `no worktree recorded (${entry.status})` };
  if (!exists(path)) return { missing: `worktree is gone: ${path}` };
  return { path };
}

// The working copy a verb should open for this entry: the review's recorded
// worktree, or a mine entry's resolved checkout.
export function resolveEntryWorktree(
  key: string,
  entry: Entry,
  exists: (p: string) => boolean = existsSync,
): Worktree {
  if (entryKind(key) !== "mine") return resolveWorktree(entry, exists);
  const path = entry.checkout_path;
  if (!path) return { missing: `no checkout yet (${entry.status})` };
  if (!exists(path)) return { missing: `checkout is gone: ${path}` };
  return { path };
}

export function openerContext(
  key: string,
  entry: Entry,
  deps: { exists?: (p: string) => boolean; git?: GitRunner } = {},
): OpenerContext {
  const { repo, number } = splitKey(key);
  const worktree = resolveEntryWorktree(key, entry, deps.exists);
  const git = deps.git ?? runGit;
  const base = "path" in worktree ? mergeBase(git, worktree.path) : null;
  return {
    worktree,
    clone: entry.local_path ?? "",
    base,
    head: "HEAD",
    number,
    repo,
    url: entry.url ?? "",
  };
}
