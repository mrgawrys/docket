import { expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildOpener,
  DEFAULT_OPENERS,
  effectiveOpeners,
  openerContext,
  resolveOpeners,
  resolveWorktree,
  type OpenerContext,
} from "../src/openers";
import type { Entry } from "../src/state";

const cfg = (openers?: Config["openers"]): Config => ({
  orgs: [],
  repos: {},
  ...(openers ? { openers } : {}),
});

// The world tests state instead of inheriting: CI has no revdiff or tuicr.
const installed =
  (...bins: string[]) =>
  (bin: string) =>
    bins.includes(bin);

const ctx = (over: Partial<OpenerContext> = {}): OpenerContext => ({
  worktree: { path: "/wt/pr 7" },
  clone: "/clones/demo",
  base: "abc123",
  head: "HEAD",
  number: "7",
  repo: "acme/demo",
  url: "https://github.test/acme/demo/pull/7",
  ...over,
});

test("resolution walks the chain top to bottom and takes the first hit", () => {
  const all = resolveOpeners(cfg(), installed("revdiff", "tuicr", "git"));
  expect(all.diff).toEqual(["revdiff", "{base}", "{head}"]);

  const noRevdiff = resolveOpeners(cfg(), installed("tuicr", "git"));
  expect(noRevdiff.diff).toEqual(["tuicr", "-r", "{base}..{head}"]);

  const gitOnly = resolveOpeners(cfg(), installed("git"));
  expect(gitOnly.diff).toEqual(["git", "diff", "{base}...{head}"]);
});

test("a chain with nothing installed resolves to undefined, not a crash", () => {
  const none = resolveOpeners(cfg(), () => false);
  expect(none.diff).toBeUndefined();
  expect(buildOpener("diff", none, ctx())).toEqual({
    unavailable: "no diff opener found on PATH",
  });
});

test("$SHELL expands from the environment, with /bin/sh as the floor", () => {
  const fish = resolveOpeners(cfg(), installed("/opt/bin/fish"), {
    SHELL: "/opt/bin/fish",
  } as NodeJS.ProcessEnv);
  expect(fish.shell).toEqual(["/opt/bin/fish"]);

  const bare = resolveOpeners(
    cfg(),
    installed("/bin/sh"),
    {} as NodeJS.ProcessEnv,
  );
  expect(bare.shell).toEqual(["/bin/sh"]);
});

test("config replaces a verb's chain outright and leaves the others alone", () => {
  const custom = cfg({ diff: [{ cmd: ["delta", "{base}"] }] });
  expect(effectiveOpeners(custom).diff).toEqual([{ cmd: ["delta", "{base}"] }]);
  expect(effectiveOpeners(custom).shell).toEqual(DEFAULT_OPENERS.shell!);

  // the replaced chain has no git fallback left: an absent delta means no diff verb
  expect(resolveOpeners(custom, installed("git")).diff).toBeUndefined();
});

test("tokens substitute per argument, so a path with spaces stays one argv slot", () => {
  const resolved = resolveOpeners(
    cfg({
      diff: [
        {
          cmd: [
            "show",
            "{worktree}",
            "{base}..{head}",
            "{repo}#{number}",
            "{url}",
          ],
        },
      ],
    }),
    installed("show"),
  );
  expect(buildOpener("diff", resolved, ctx())).toEqual({
    argv: [
      "show",
      "/wt/pr 7",
      "abc123..HEAD",
      "acme/demo#7",
      "https://github.test/acme/demo/pull/7",
    ],
    cwd: "/wt/pr 7",
  });
});

test("verbs run in the worktree, and are unavailable when it is gone", () => {
  const resolved = resolveOpeners(cfg(), installed("git"));
  expect(buildOpener("diff", resolved, ctx())).toHaveProperty(
    "cwd",
    "/wt/pr 7",
  );

  const gone = buildOpener(
    "diff",
    resolved,
    ctx({ worktree: { missing: "worktree is gone: /wt/pr 7" } }),
  );
  expect(gone).toEqual({ unavailable: "worktree is gone: /wt/pr 7" });
});

test("worktree resolution distinguishes never-had-one from vanished", () => {
  const entry = (over: Partial<Entry>): Entry => ({
    status: "ready",
    updated_at: "t",
    ...over,
  });
  expect(resolveWorktree(entry({ status: "failed" }), () => true)).toEqual({
    missing: "no worktree recorded (failed)",
  });
  expect(resolveWorktree(entry({ worktrees: ["/gone"] }), () => false)).toEqual(
    {
      missing: "worktree is gone: /gone",
    },
  );
  expect(resolveWorktree(entry({ worktrees: ["/here"] }), () => true)).toEqual({
    path: "/here",
  });
});

test("the base commit comes from merge-base, trying each ref that could exist", () => {
  const entry: Entry = {
    status: "ready",
    local_path: "/clones/demo",
    url: "u",
    worktrees: ["/wt/pr-7"],
    updated_at: "t",
  };
  const calls: string[][] = [];
  const found = openerContext("acme/demo#7", entry, {
    exists: () => true,
    git: (args, cwd) => {
      calls.push([...args, cwd]);
      return "deadbeef";
    },
  });
  expect(found.base).toBe("deadbeef");
  expect(calls).toEqual([["merge-base", "HEAD", "origin/HEAD", "/wt/pr-7"]]);
  expect(found).toMatchObject({
    number: "7",
    repo: "acme/demo",
    head: "HEAD",
    clone: "/clones/demo",
  });

  // a clone whose origin/HEAD symref was never set, on a master-default repo:
  // assuming origin/main here builds a diff against a ref that does not exist
  const masterDefault = openerContext("acme/demo#7", entry, {
    exists: () => true,
    git: (args) => (args[2] === "origin/master" ? "cafe" : null),
  });
  expect(masterDefault.base).toBe("cafe");

  const noBase = openerContext("acme/demo#7", entry, {
    exists: () => true,
    git: () => null,
  });
  expect(noBase.base).toBeNull();
});

test("a diff with no resolvable base reports why instead of running", () => {
  const r = buildOpener(
    "diff",
    { diff: ["git", "diff", "{base}...{head}"] },
    ctx({ base: null }),
  );
  expect(r).toHaveProperty("unavailable");
  expect((r as { unavailable: string }).unavailable).toContain(
    "no base branch",
  );
});

test("no worktree means no git lookup at all", () => {
  let ran = false;
  const c = openerContext(
    "acme/demo#7",
    { status: "skipped", updated_at: "t" },
    {
      exists: () => true,
      git: () => {
        ran = true;
        return "x";
      },
    },
  );
  expect(ran).toBe(false);
  expect(c.base).toBeNull();
  expect(c.worktree).toEqual({ missing: "no worktree recorded (skipped)" });
});
