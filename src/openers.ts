import { existsSync } from "node:fs";
import type { Config, Opener, Openers } from "./config";
import { splitKey, type Entry } from "./state";

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
  base: string;
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
  const tokens: Record<string, string> = {
    "{worktree}": ctx.worktree.path,
    "{clone}": ctx.clone,
    "{base}": ctx.base,
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

export function openerContext(
  key: string,
  entry: Entry,
  deps: { exists?: (p: string) => boolean; git?: GitRunner } = {},
): OpenerContext {
  const { repo, number } = splitKey(key);
  const worktree = resolveWorktree(entry, deps.exists);
  const git = deps.git ?? runGit;
  const base =
    ("path" in worktree &&
      git(["merge-base", "HEAD", "origin/HEAD"], worktree.path)) ||
    "origin/main";
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
