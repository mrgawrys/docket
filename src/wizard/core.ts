// Pure logic behind the first-run wizard (spec §1). No prompts, no spawns —
// Task 7's interactive flow drives these functions and owns all I/O.
//
// Ported from the validated prototype (prototypes/first-run-wizard/native-wizard/wizard.ts).

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCAN_MAX_DEPTH = 3;

const SCAN_SKIP = new Set([
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "Library",
]);

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// -------------------------------------------------------------- clone scan --

export interface Checkout {
  path: string;
  // A linked worktree carries a .git *file* pointing at the real repo, where a
  // clone has a .git directory. Several worktrees of one repo all report the
  // same origin, so this is what tells the main clone from its worktrees.
  linked: boolean;
}

// Walks the filesystem only — no git spawn, so this needs no shim to test.
export function findGitRepos(root: string, maxDepth: number): Checkout[] {
  const found = new Map<string, Checkout>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it, not the whole scan
    }
    // A clone is worth recording and still worth descending into: a workspace
    // repo with the real project clones gitignored inside it is a normal
    // layout, and stopping here would hide every one of them.
    const git = entries.find((e) => e.name === ".git");
    if (git) found.set(dir, { path: dir, linked: !git.isDirectory() });
    for (const e of entries) {
      // the dot-prefix skip is what keeps us out of .git itself
      if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) {
        continue;
      }
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return [...found.values()];
}

// git@github.com:org/repo.git, https://github.com/org/repo(.git),
// ssh://git@github.com/org/repo — all collapse to "org/repo". Never derived
// from the directory name.
export function parseOrigin(url: string): { org: string; repo: string } | null {
  const m = url
    .trim()
    .match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) return null;
  return { org: m[1]!, repo: m[2]! };
}

export interface RepoMatch {
  slug: string;
  path: string;
}

// One entry per repo: config keys on "org/repo", so several checkouts of the
// same repo would collapse anyway — pick which one survives deliberately. A
// real clone beats a linked worktree, then the shallower path wins. Pure: the
// caller has already resolved each checkout's origin.
export function dedupeRepos(
  checkouts: Array<Checkout & { org: string; repo: string }>,
): RepoMatch[] {
  const best = new Map<string, Checkout>();
  for (const checkout of checkouts) {
    const slug = `${checkout.org}/${checkout.repo}`;
    const held = best.get(slug);
    if (!held) {
      best.set(slug, checkout);
      continue;
    }
    const better =
      held.linked !== checkout.linked
        ? !checkout.linked
        : checkout.path.length < held.path.length;
    if (better) best.set(slug, checkout);
  }
  return [...best.entries()].map(([slug, c]) => ({ slug, path: c.path }));
}

// Ties the scan, origin resolution, and dedupe together. `getOrigin` is
// injected (real callers run `git -C <dir> remote get-url origin`) so this
// stays testable with a fake instead of a git shim.
export function scanForRepos(
  root: string,
  orgs: string[],
  maxDepth: number,
  getOrigin: (dir: string) => string | null,
): RepoMatch[] {
  const wanted = new Set(orgs.map((o) => o.toLowerCase()));
  const resolved: Array<Checkout & { org: string; repo: string }> = [];
  for (const checkout of findGitRepos(root, maxDepth)) {
    const origin = getOrigin(checkout.path);
    if (!origin) continue;
    const parsed = parseOrigin(origin);
    if (!parsed || !wanted.has(parsed.org.toLowerCase())) continue;
    resolved.push({ ...checkout, org: parsed.org, repo: parsed.repo });
  }
  return dedupeRepos(resolved);
}

// ------------------------------------------------------------------ accounts --

export interface Account {
  name: string;
  active: boolean;
}

// `gh auth status` is human-oriented text, roughly:
//
//   github.com
//     ✓ Logged in to github.com account mrgawrys (keyring)
//     - Active account: true
//     - Token scopes: 'gist', 'read:org', ...
//
// so we anchor on the "account <name>" phrase and treat everything after it as
// decoration, then attach the nearest following "Active account:" line.
export function parseAccounts(text: string): Account[] {
  const accounts: Account[] = [];
  for (const line of text.split("\n")) {
    const login = line.match(/Logged in to \S+ account (\S+)/);
    if (login?.[1]) {
      accounts.push({ name: login[1], active: false });
      continue;
    }
    const active = line.match(/Active account:\s*(\S+)/);
    if (active && accounts.length > 0) {
      accounts[accounts.length - 1]!.active = active[1] === "true";
    }
  }
  return accounts;
}

// --------------------------------------------------------------- selection --

// Numbered multi-select: empty picks everything, "none" picks nothing,
// otherwise comma/space separated 1-based numbers. Returns 0-based indices,
// or null on any out-of-range token.
export function parseSelection(input: string, count: number): number[] | null {
  const raw = input.trim().toLowerCase();
  if (raw === "" || raw === "a" || raw === "all") {
    return [...Array(count).keys()];
  }
  if (raw === "n" || raw === "none") return [];
  const picked: number[] = [];
  for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    if (!picked.includes(n - 1)) picked.push(n - 1);
  }
  return picked;
}

// -------------------------------------------------------------- completion --

export const expandHome = (p: string, homeDir: string) =>
  p.startsWith("~") ? join(homeDir, p.slice(1)) : p;

// Tab-completes directory names for the clone-root prompt. Returns hits as
// whole replacement lines paired with the whole line, which is what readline
// substitutes. `homeDir` defaults to the real home so it plugs straight into
// readline's completer signature; tests pass a sandboxed one.
export function completePath(
  line: string,
  homeDir: string = homedir(),
): [string[], string] {
  if (line.trim() === "") return [[], line];
  const expanded = expandHome(line, homeDir);
  const cut = expanded.lastIndexOf("/");
  const dir = cut === -1 ? "." : expanded.slice(0, cut + 1) || "/";
  const partial = cut === -1 ? expanded : expanded.slice(cut + 1);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [[], line];
  }
  const hits = entries
    .filter((e) => {
      if (!e.name.startsWith(partial)) return false;
      // hidden directories only once the user commits to a leading dot
      if (e.name.startsWith(".") && !partial.startsWith(".")) return false;
      return (
        e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name)))
      );
    })
    .map((e) => `${dir === "." ? "" : dir}${e.name}/`)
    // keep the answer in the shape the user is typing it
    .map((p) =>
      line.startsWith("~") && p.startsWith(homeDir)
        ? `~${p.slice(homeDir.length)}`
        : p,
    )
    .sort();
  return [hits, line];
}
