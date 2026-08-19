import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RECEIVE_PROMPT,
  RECEIVE_ALLOWED_TOOLS,
  effectiveReceiveAllowedTools,
  effectiveReceivePrompt,
  type Config,
} from "../src/config";
import { receivePrompt, shouldAutoRun } from "../src/receive";
import type { Entry } from "../src/state";
import { makeSandbox, type Sandbox } from "./harness";

const bareCfg = (over: Partial<Config> = {}): Config => ({
  orgs: [],
  repos: {},
  ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  status: "open",
  checkout_path: "/tmp/co/feature",
  updated_at: "t",
  ...over,
});

test("receivePrompt: fixed preamble — checkout only, commits yes, push and GitHub writes never", () => {
  const p = receivePrompt(bareCfg(), "mine:acme/widgets#12", entry());
  expect(p).toContain("Work ONLY in this checkout");
  expect(p).toContain("/tmp/co/feature");
  expect(p).toContain("edit files and commit locally");
  expect(p).toContain("NEVER push");
  expect(p).toContain("NEVER write to GitHub");
  expect(p).toContain(
    "Address the review feedback by running /receive-code-review 12.",
  );
  expect(p).toContain("triage summary"); // the summary block is demanded too
});

test("receivePrompt: custom body substituted, preamble still fixed, note appended", () => {
  const p = receivePrompt(
    bareCfg({ receive_prompt: "Fix the feedback on {repo}#{number}." }),
    "mine:acme/widgets#12",
    entry(),
    "skip the nits",
  );
  expect(p).toContain("Fix the feedback on acme/widgets#12.");
  expect(p).toContain("NEVER push");
  expect(p).toContain("Additional context from the author: skip the nits");
  expect(p.trimEnd().endsWith("skip the nits")).toBe(true);
});

test("effectiveReceivePrompt: blank override falls back to the default", () => {
  expect(effectiveReceivePrompt(bareCfg({ receive_prompt: "  " }))).toBe(
    DEFAULT_RECEIVE_PROMPT,
  );
});

test("receive allowlist: edit + local git verbs, and never push or GitHub writes", () => {
  const joined = RECEIVE_ALLOWED_TOOLS.join(",");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Edit");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Write");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("MultiEdit");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Bash(git add:*)");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Bash(git commit:*)");
  // the guarantee the receive feature rests on: assert the absence
  expect(joined).not.toContain("push");
  expect(joined).not.toContain("gh pr comment");
  expect(joined).not.toContain("gh pr review");
  expect(joined).not.toContain("gh pr merge");
  expect(joined).not.toContain("gh pr edit");
  expect(joined).not.toContain("gh pr ready");
  expect(joined).not.toContain("gh api -X");
  // extras append after the baseline
  expect(
    effectiveReceiveAllowedTools(
      bareCfg({ extra_receive_allowed_tools: ["Bash(bun test:*)"] }),
    ).at(-1),
  ).toBe("Bash(bun test:*)");
});

test("shouldAutoRun: requires receive_enabled and a non-draft PR", () => {
  expect(shouldAutoRun(bareCfg(), entry())).toEqual({
    ok: false,
    reason: "receive_enabled is off",
  });
  expect(
    shouldAutoRun(
      bareCfg({ receive_enabled: true }),
      entry({ flags: ["draft"] }),
    ),
  ).toEqual({ ok: false, reason: "PR is a draft" });
  expect(shouldAutoRun(bareCfg({ receive_enabled: true }), entry())).toEqual({
    ok: true,
  });
});

// --- the mocked end-to-end flows ---

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// An origin with a reviewed `feature` branch and a clone mapped in the config.
function prScenario(sb: Sandbox, over: Partial<Config> = {}) {
  const origin = join(sb.tmp, "origin");
  mkdirSync(origin);
  git(sb.tmp, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "f.txt"), "one\n");
  git(origin, "add", "f.txt");
  git(origin, "commit", "-qm", "init");
  git(origin, "checkout", "-qb", "feature");
  writeFileSync(join(origin, "f.txt"), "two\n");
  git(origin, "commit", "-qam", "feature work");
  const headSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  const clone = join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", origin, clone);
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": clone },
    ...over,
  });
  const mineJson = JSON.stringify({
    state: "OPEN",
    isDraft: false,
    headRefOid: headSha,
    headRefName: "feature",
    reviews: [
      {
        author: { login: "colleague" },
        state: "CHANGES_REQUESTED",
        body: "please fix",
        submittedAt: "2026-07-19T10:00:00Z",
      },
    ],
  });
  return { clone, headSha, mineJson };
}

test("feedback on an opted-in PR runs receive headlessly in a docket-owned checkout", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const r = sb.run(["sync"], { GH_PR_MINE_JSON: mineJson });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.session_id).toBe("sess-1234");
  expect(e.review_at).toBe("2026-07-19T10:00:00Z");
  expect(e.reviewer).toBe("colleague");

  // the checkout is docket's own, recorded as deletable, and the run's cwd
  const expected = realpathSync(
    join(sb.stateDir, "checkouts", "testorg-demo", "feature"),
  );
  expect(realpathSync(e.checkout_path)).toBe(expected);
  expect(e.worktrees).toEqual([expected]);
  expect(realpathSync(sb.cwdCapture())).toBe(expected);

  // the receive allowlist and prompt, not the review ones
  expect(sb.allowedCapture()).toBe(RECEIVE_ALLOWED_TOOLS.join(","));
  expect(sb.promptCapture()).toContain("/receive-code-review 7");
  expect(sb.promptCapture()).toContain("NEVER push");
});

test("feedback with a blocked (dirty) checkout is skipped with the reason, no run", () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "uncommitted local work\n");
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const before = sb.claudeCalls();
  const r = sb.run(["sync"], { GH_PR_MINE_JSON: mineJson });
  expect(r.code).toBe(0);
  const e = sb.state()["mine:testorg/demo#7"];
  expect(e.status).toBe("skipped");
  expect(e.error).toContain("checkout dirty");
  expect(e.review_at).toBe("2026-07-19T10:00:00Z"); // cursor still advanced
  expect(sb.claudeCalls()).toBe(before);
});

test("feedback while not opted in records the verdict only", () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb); // receive_enabled absent
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const before = sb.claudeCalls();
  expect(sb.run(["sync"], { GH_PR_MINE_JSON: mineJson }).code).toBe(0);
  const e = sb.state()["mine:testorg/demo#7"];
  expect(e.status).toBe("changes-requested");
  expect(e.checkout_path).toBeUndefined(); // nothing resolved, nothing created
  expect(sb.claudeCalls()).toBe(before);
});

test("docket receive runs regardless of receive_enabled, keys under mine:", async () => {
  const sb = makeSandbox();
  const { mineJson } = prScenario(sb); // opted out — the manual verb ignores that
  const r = sb.run(["receive", "testorg/demo#7", "skip the wording nits"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.title).toBe("Manual PR"); // fetched via gh pr view
  expect(e.note).toBe("skip the wording nits");
  expect(sb.promptCapture()).toContain(
    "Additional context from the author: skip the wording nits",
  );
  // a URL normalizes into the same key shape
  expect(sb.run(["receive", "total garbage"]).code).not.toBe(0);
});

test("exec re-checks the checkout before spawning claude (TOCTOU downgrade)", () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  // the checkout went dirty between trigger and runner
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "raced\n");
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "reviewing",
      branch: "feature",
      local_path: clone,
      checkout_path: clone,
      updated_at: new Date().toISOString(),
    },
  });
  const before = sb.claudeCalls();
  const r = sb.run(["exec", "mine:testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).not.toBe(0);
  const e = sb.state()["mine:testorg/demo#7"];
  expect(e.status).toBe("skipped");
  expect(e.error).toContain("checkout dirty");
  expect(sb.claudeCalls()).toBe(before);
});
