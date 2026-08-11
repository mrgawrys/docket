import { expect, test } from "bun:test";
import type { Config } from "../src/config";
import { denialGroups, isAllowed, parseDenials } from "../src/denials";

// The opening of a real dontAsk denial, verbatim; the rest of the message is
// boilerplate advice to the agent that nothing here reads.
const denialText = (tool: string) =>
  `Permission to use ${tool} has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal…`;

const used = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const result = (id: string, content: unknown, isError = true) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content,
        },
      ],
    },
  });

const denied = (id: string, tool = "Bash") => result(id, denialText(tool));

// The two log lines one denied bash call leaves behind.
const deniedBash = (id: string, command: string) => [
  used(id, "Bash", { command, description: "check something" }),
  denied(id),
];

const log = (...lines: string[]) => lines.join("\n") + "\n";

const cfg = (extra?: string[]): Config => ({
  orgs: [],
  repos: {},
  ...(extra ? { extra_allowed_tools: extra } : {}),
});

test("a denial is joined to the call it names and becomes a suggested rule", () => {
  expect(denialGroups(log(...deniedBash("t1", "rg --files")), cfg())).toEqual([
    {
      tool: "Bash",
      suggestion: "Bash(rg:*)",
      count: 1,
      examples: ["rg --files"],
      writeShaped: false,
      alreadyAllowed: false,
    },
  ]);
});

test("a denial delivered as content blocks reads the same as a plain string", () => {
  const lines = log(
    used("t1", "Bash", { command: "rg --files" }),
    result("t1", [{ type: "text", text: denialText("Bash") }]),
  );
  expect(denialGroups(lines, cfg()).map((g) => g.count)).toEqual([1]);
});

test("a `cd <worktree> &&` prefix is not what the rule is about", () => {
  const [group] = denialGroups(
    log(
      ...deniedBash(
        "t1",
        "cd /Users/me/worktrees/pr-6520 && git check-ignore -v docs/x.md",
      ),
    ),
    cfg(),
  );
  expect(group?.suggestion).toBe("Bash(git check-ignore:*)");
});

test("repeated denials of one command shape collapse into a counted group", () => {
  const [group] = denialGroups(
    log(
      ...deniedBash("t1", "git check-ignore -v a.md"),
      ...deniedBash("t2", "git check-ignore -v b.md"),
      ...deniedBash("t3", "git check-ignore -v c.md"),
      ...deniedBash("t4", "git check-ignore -v d.md"),
      ...deniedBash("t5", "git check-ignore -v a.md"),
    ),
    cfg(),
  );
  expect(group?.count).toBe(5);
  // capped, and the repeat of a.md does not take one of the three slots
  expect(group?.examples).toEqual([
    "git check-ignore -v a.md",
    "git check-ignore -v b.md",
    "git check-ignore -v c.md",
  ]);
});

test("an argument is not part of the rule — one command is one group", () => {
  // Only a multiplexer's second word is a subcommand. Taking one anywhere else
  // gives `Bash(echo done:*)`: a rule covering exactly the call already denied,
  // and three echo denials become three rows instead of one group of three.
  const [group, ...rest] = denialGroups(
    log(
      ...deniedBash("t1", "echo starting"),
      ...deniedBash("t2", "echo done"),
      ...deniedBash("t3", "echo finished"),
    ),
    cfg(),
  );
  expect(group?.suggestion).toBe("Bash(echo:*)");
  expect(group?.count).toBe(3);
  expect(rest).toEqual([]);
});

test("a multiplexer keeps its subcommand, which is what the rule is about", () => {
  // `Bash(git:*)` would allow `git push`, `Bash(gh pr:*)` would allow
  // `gh pr comment` — these rules are only safe at their full depth.
  const lines = log(
    ...deniedBash("t1", "git check-ignore -v a.md"),
    ...deniedBash("t2", "gh pr view 6520 --json title"),
    ...deniedBash("t3", "npm test"),
  );
  expect(
    denialGroups(lines, cfg())
      .map((g) => g.suggestion)
      .sort(),
  ).toEqual([
    "Bash(gh pr view:*)",
    "Bash(git check-ignore:*)",
    "Bash(npm test:*)",
  ]);
});

test("a denial of anything but Bash suggests the bare tool name", () => {
  const lines = log(
    used("t1", "WebFetch", { url: "https://example.com/rfc", prompt: "what" }),
    denied("t1", "WebFetch"),
  );
  expect(denialGroups(lines, cfg())).toEqual([
    {
      tool: "WebFetch",
      suggestion: "WebFetch",
      count: 1,
      examples: ["https://example.com/rfc"],
      writeShaped: false,
      alreadyAllowed: false,
    },
  ]);
});

test("an ordinary tool failure is not a denial", () => {
  // Exit codes and missing files come back as errors too; only the permission
  // prefix means the allowlist turned the call away.
  const lines = log(
    used("t1", "Bash", { command: "git status" }),
    result("t1", "fatal: not a git repository\nexit code 128"),
    used("t2", "Bash", { command: "rg --files" }),
    result("t2", denialText("Bash"), false),
  );
  expect(denialGroups(lines, cfg())).toEqual([]);
});

test("write-shaped suggestions are flagged, so nothing offers a one-key apply", () => {
  const lines = log(
    ...deniedBash("t1", "gh pr comment 6520 --body 'looks good'"),
    ...deniedBash("t2", "git push origin HEAD"),
    ...deniedBash("t3", "rm -rf /tmp/scratch"),
    ...deniedBash("t4", "gh api repos/o/r/pulls/1/reviews -f event=APPROVE"),
    ...deniedBash("t5", "rg --files"),
    ...deniedBash("t7", "gh auth status 2>&1 | grep 'Logged in to'"),
    ...deniedBash("t8", "gh pr view 6520 --json title"),
    // an interpreter, an in-place editor and a command-builder are write tools
    // wearing a read tool's name: `Bash(sh:*)` grants everything `Bash(rm:*)` does
    ...deniedBash("t9", "sh -c 'cat pkg.json'"),
    ...deniedBash("t10", "sed -i '' s/a/b/ notes.md"),
    ...deniedBash("t11", "xargs rm < paths.txt"),
    ...deniedBash("t12", "git submodule update --init"),
    used("t6", "Edit", { file_path: "/Users/me/wt/src/x.ts" }),
    denied("t6", "Edit"),
  );
  const flags = Object.fromEntries(
    denialGroups(lines, cfg()).map((g) => [g.suggestion, g.writeShaped]),
  );
  expect(flags).toEqual({
    "Bash(gh pr comment:*)": true,
    "Bash(git push:*)": true,
    "Bash(rm:*)": true,
    "Bash(gh api:*)": true,
    Edit: true,
    "Bash(rg:*)": false,
    // the gh verbs that only read still get an apply
    "Bash(gh auth status:*)": false,
    "Bash(gh pr view:*)": false,
    "Bash(sh:*)": true,
    "Bash(sed:*)": true,
    "Bash(xargs:*)": true,
    // `git submodule update` writes to the working tree
    "Bash(git submodule:*)": true,
  });
});

test("a rule that exists but did not match is flagged, not suggested again", () => {
  // `git -C <dir> log` never matches `Bash(git log:*)`: the rule is in the
  // baseline allowlist and the call is denied all the same.
  const [group] = denialGroups(
    log(
      ...deniedBash("t1", "git -C /Users/me/wt log --oneline origin/dev..HEAD"),
    ),
    cfg(),
  );
  expect(group?.suggestion).toBe("Bash(git log:*)");
  expect(group?.alreadyAllowed).toBe(true);
});

test("a suggestion the user already configured counts as allowed too", () => {
  const lines = log(...deniedBash("t1", "rg --files"));
  expect(denialGroups(lines, cfg(["  Bash(rg:*)  "]))[0]?.alreadyAllowed).toBe(
    true,
  );
  expect(denialGroups(lines, cfg([]))[0]?.alreadyAllowed).toBe(false);
  expect(isAllowed("Bash(git fetch:*)", cfg())).toBe(true);
  expect(isAllowed("Bash(rg:*)", cfg())).toBe(false);
});

test("junk and half-written lines do not stop the parse", () => {
  const lines = log(
    "waiting for review output …",
    "",
    '{"type":"system","subtype":"init","session_id":"abc"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"looking"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9"',
    '{"type":"user","message":{"content":"a plain string, not blocks"}}',
    ...deniedBash("t1", "rg --files"),
  );
  expect(denialGroups(lines, cfg()).map((g) => g.suggestion)).toEqual([
    "Bash(rg:*)",
  ]);
});

test("a denial whose call never appeared is dropped rather than guessed at", () => {
  const lines = log(denied("toolu_gone"), ...deniedBash("t1", "rg --files"));
  expect(parseDenials(lines)).toEqual([
    {
      tool: "Bash",
      input: { command: "rg --files", description: "check something" },
    },
  ]);
});

test("a rule comes from the first real statement of a multi-line command", () => {
  const command =
    '\n# probe what the ignore rules do\nW=/Users/me/wt\ngit -C $W show --stat 070e8b5 2>&1 | grep -i "docs/"';
  const [group] = denialGroups(log(...deniedBash("t1", command)), cfg());
  expect(group?.suggestion).toBe("Bash(git show:*)");
  // the example keeps the command as written, on one line
  expect(group?.examples).toEqual([
    '# probe what the ignore rules do W=/Users/me/wt git -C $W show --stat 070e8b5 2>&1 | grep -i "docs/"',
  ]);
});

test("a backslash-continued line is one statement, not a command called `\\`", () => {
  const command =
    'cd /Users/me/wt && \\\necho "--- plan.md ---" && \\\ngit check-ignore -v --no-index docs/plan.md';
  const [group] = denialGroups(log(...deniedBash("t1", command)), cfg());
  expect(group?.suggestion).toBe("Bash(echo:*)");
});

test("a command whose first word cannot name a program is dropped", () => {
  // A denied bash array literal and a denied loop: neither is a rule the user
  // could add, and a row suggesting one is noise in the panel.
  const array =
    '# check the paths that matter\nPATHS=(\n"docs/specs/x.md"\n"docs/plans/y.md"\n)';
  const loop =
    'for f in "docs/specs/x.md" "docs/plans/y.md"; do\ncat "$f"\ndone';
  expect(
    denialGroups(
      log(...deniedBash("t1", array), ...deniedBash("t2", loop)),
      cfg(),
    ),
  ).toEqual([]);
});

test("an example is bounded — state.json keeps it forever", () => {
  const [group] = denialGroups(
    log(...deniedBash("t1", `rg ${"x".repeat(300)}`)),
    cfg(),
  );
  expect(group?.examples[0]).toBe(`rg ${"x".repeat(117)}`);
});

test("groups are ordered by how often the review was turned away", () => {
  const lines = log(
    ...deniedBash("a1", "rg --files"),
    ...deniedBash("b1", "cat notes.md"),
    ...deniedBash("b2", "cat other.md"),
  );
  expect(denialGroups(lines, cfg()).map((g) => g.suggestion)).toEqual([
    "Bash(cat:*)",
    "Bash(rg:*)",
  ]);
});
