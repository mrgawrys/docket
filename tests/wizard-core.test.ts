import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  type Checkout,
  completePath,
  dedupeRepos,
  findGitRepos,
  parseAccounts,
  parseOrigin,
  parseSelection,
  scanForRepos,
} from "../src/wizard/core";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const mkGitDir = (repoDir: string) => {
  mkdirSync(join(repoDir, ".git"), { recursive: true });
};
const mkGitFile = (repoDir: string) => {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, ".git"), "gitdir: /elsewhere\n");
};

// ------------------------------------------------------------ findGitRepos --

test("findGitRepos: records a repo and keeps descending into it", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, "workspace"));
  mkGitDir(join(root, "workspace", "nested"));
  const found = findGitRepos(root, 3)
    .map((c) => c.path)
    .sort();
  expect(found).toEqual(
    [join(root, "workspace"), join(root, "workspace", "nested")].sort(),
  );
});

test("findGitRepos: a .git directory is a real clone, not linked", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, "repo"));
  const found = findGitRepos(root, 3);
  expect(found).toEqual([{ path: join(root, "repo"), linked: false }]);
});

test("findGitRepos: a .git file marks a linked worktree", () => {
  const root = tmp("dk-scan-");
  mkGitFile(join(root, "repo-wt"));
  const found = findGitRepos(root, 3);
  expect(found).toEqual([{ path: join(root, "repo-wt"), linked: true }]);
});

test("findGitRepos: skips dot-directories and the SCAN_SKIP set", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, ".hidden", "repo"));
  mkGitDir(join(root, "node_modules", "repo"));
  mkGitDir(join(root, "vendor", "repo"));
  expect(findGitRepos(root, 3)).toEqual([]);
});

test("findGitRepos: stops descending past the depth cap", () => {
  const root = tmp("dk-scan-");
  // depth 0 = root, so a repo 4 levels down is out of reach at maxDepth 3
  mkGitDir(join(root, "a", "b", "c", "d"));
  expect(findGitRepos(root, 3)).toEqual([]);
});

test("findGitRepos: an unreadable subdirectory is skipped, not fatal", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, "ok"));
  // a file where a directory entry would be walked — readdirSync on it throws
  writeFileSync(join(root, "not-a-dir"), "");
  expect(findGitRepos(root, 3).map((c) => c.path)).toEqual([join(root, "ok")]);
});

// -------------------------------------------------------------- parseOrigin --

test("parseOrigin: ssh form", () => {
  expect(parseOrigin("git@github.com:mrgawrys/docket.git")).toEqual({
    org: "mrgawrys",
    repo: "docket",
  });
});

test("parseOrigin: https form without .git suffix", () => {
  expect(parseOrigin("https://github.com/mrgawrys/docket")).toEqual({
    org: "mrgawrys",
    repo: "docket",
  });
});

test("parseOrigin: ssh:// form with .git suffix", () => {
  expect(parseOrigin("ssh://git@github.com/mrgawrys/docket.git")).toEqual({
    org: "mrgawrys",
    repo: "docket",
  });
});

test("parseOrigin: tolerates trailing whitespace", () => {
  expect(parseOrigin("https://github.com/mrgawrys/docket.git\n")).toEqual({
    org: "mrgawrys",
    repo: "docket",
  });
});

test("parseOrigin: a non-github URL is null", () => {
  expect(parseOrigin("https://gitlab.com/mrgawrys/docket.git")).toBeNull();
});

// -------------------------------------------------------------- dedupeRepos --

test("dedupeRepos: a real clone beats a linked worktree of the same repo", () => {
  const checkouts = [
    {
      path: "/x/worktrees/docket-wt",
      linked: true,
      org: "mrgawrys",
      repo: "docket",
    },
    {
      path: "/x/Development/docket",
      linked: false,
      org: "mrgawrys",
      repo: "docket",
    },
  ];
  expect(dedupeRepos(checkouts)).toEqual([
    { slug: "mrgawrys/docket", path: "/x/Development/docket" },
  ]);
});

test("dedupeRepos: between two clones, the shallower path wins", () => {
  const checkouts = [
    {
      path: "/x/Development/nested/docket",
      linked: false,
      org: "mrgawrys",
      repo: "docket",
    },
    { path: "/x/docket", linked: false, org: "mrgawrys", repo: "docket" },
  ];
  expect(dedupeRepos(checkouts)).toEqual([
    { slug: "mrgawrys/docket", path: "/x/docket" },
  ]);
});

test("dedupeRepos: distinct repos all survive", () => {
  const checkouts = [
    { path: "/x/docket", linked: false, org: "mrgawrys", repo: "docket" },
    { path: "/x/other", linked: false, org: "mrgawrys", repo: "other" },
  ];
  expect(
    dedupeRepos(checkouts)
      .map((r) => r.slug)
      .sort(),
  ).toEqual(["mrgawrys/docket", "mrgawrys/other"]);
});

test("scanForRepos: resolves origins via the injected runner, filters by org, dedupes", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, "docket"));
  mkGitFile(join(root, "worktrees", "docket-wt"));
  mkGitDir(join(root, "other-org-repo"));
  const origins: Record<string, string> = {
    [join(root, "docket")]: "git@github.com:mrgawrys/docket.git",
    [join(root, "worktrees", "docket-wt")]:
      "git@github.com:mrgawrys/docket.git",
    [join(root, "other-org-repo")]: "git@github.com:someone-else/thing.git",
  };
  const matches = scanForRepos(
    root,
    ["mrgawrys"],
    3,
    (dir) => origins[dir] ?? null,
  );
  expect(matches).toEqual([
    { slug: "mrgawrys/docket", path: join(root, "docket") },
  ]);
});

test("scanForRepos: org matching is case-insensitive", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, "docket"));
  const matches = scanForRepos(
    root,
    ["MrGawrys"],
    3,
    () => "git@github.com:mrgawrys/docket.git",
  );
  expect(matches).toEqual([
    { slug: "mrgawrys/docket", path: join(root, "docket") },
  ]);
});

test("scanForRepos: a checkout with no resolvable origin is skipped", () => {
  const root = tmp("dk-scan-");
  mkGitDir(join(root, "docket"));
  const matches = scanForRepos(root, ["mrgawrys"], 3, () => null);
  expect(matches).toEqual([]);
});

// ------------------------------------------------------------- parseAccounts --

test("parseAccounts: a single logged-in account", () => {
  const text =
    "github.com\n  ✓ Logged in to github.com account mrgawrys (keyring)\n";
  expect(parseAccounts(text)).toEqual([{ name: "mrgawrys", active: false }]);
});

test("parseAccounts: several accounts, active marker attaches to the nearest login", () => {
  const text = [
    "github.com",
    "  ✓ Logged in to github.com account mrgawrys (keyring)",
    "  - Active account: true",
    "  ✓ Logged in to github.com account mrgawrys-work (keyring)",
    "  - Active account: false",
  ].join("\n");
  expect(parseAccounts(text)).toEqual([
    { name: "mrgawrys", active: true },
    { name: "mrgawrys-work", active: false },
  ]);
});

test("parseAccounts: no accounts logged in", () => {
  expect(parseAccounts("you are not logged into any GitHub hosts")).toEqual([]);
});

// ------------------------------------------------------------ parseSelection --

test("parseSelection: empty input selects everything", () => {
  expect(parseSelection("", 3)).toEqual([0, 1, 2]);
});

test("parseSelection: 'a' and 'all' select everything", () => {
  expect(parseSelection("a", 3)).toEqual([0, 1, 2]);
  expect(parseSelection("ALL", 3)).toEqual([0, 1, 2]);
});

test("parseSelection: 'n' and 'none' select nothing", () => {
  expect(parseSelection("n", 3)).toEqual([]);
  expect(parseSelection("None", 3)).toEqual([]);
});

test("parseSelection: comma and space separated numbers, deduped", () => {
  expect(parseSelection("1, 3 3", 3)).toEqual([0, 2]);
});

test("parseSelection: any out-of-range token invalidates the whole input", () => {
  expect(parseSelection("1, 9", 3)).toBeNull();
  expect(parseSelection("0", 3)).toBeNull();
});

// -------------------------------------------------------------- completePath --

test("completePath: only offers directories, not files", () => {
  const root = tmp("dk-complete-");
  mkdirSync(join(root, "Development"));
  writeFileSync(join(root, "Development.txt"), "");
  const [hits] = completePath(`${root}/`, root);
  expect(hits).toEqual([`${root}/Development/`]);
});

test("completePath: hides dotfiles until a leading dot is typed", () => {
  const root = tmp("dk-complete-");
  mkdirSync(join(root, ".config"));
  mkdirSync(join(root, "Development"));
  const [hidden] = completePath(`${root}/`, root);
  expect(hidden).toEqual([`${root}/Development/`]);
  const [shown] = completePath(`${root}/.`, root);
  expect(shown).toEqual([`${root}/.config/`]);
});

test("completePath: re-collapses a ~-typed answer back to ~", () => {
  const root = tmp("dk-complete-");
  mkdirSync(join(root, "Development"));
  const [hits] = completePath("~/Dev", root);
  expect(hits).toEqual(["~/Development/"]);
});

test("completePath: empty input has no completions", () => {
  expect(completePath("  ")).toEqual([[], "  "]);
});

test("completePath: a symlink to a directory counts as a directory", () => {
  const root = tmp("dk-complete-");
  const real = join(root, "real-dir");
  mkdirSync(real);
  symlinkSync(real, join(root, "linked-dir"));
  const [hits] = completePath(`${root}/`, root);
  expect(hits.sort()).toEqual([`${root}/linked-dir/`, `${root}/real-dir/`]);
});
