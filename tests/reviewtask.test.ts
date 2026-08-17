import { expect, test } from "bun:test";
import {
  derivationPrompt,
  dropPostingTools,
  editorTemplate,
  mergeTools,
  parseDerivedTools,
  stripEditorComments,
} from "../src/reviewtask";
import { ALLOWED_TOOLS } from "../src/config";

// ---------------------------------------------------------- editorTemplate --

test("the editor seed carries the # header, a blank line, then the task", () => {
  const seed = editorTemplate("Do the thing.");
  const lines = seed.split("\n");
  expect(lines[0]).toBe(
    "# The review task docket hands to claude for each PR.",
  );
  expect(seed).toContain("{number} and {repo} are substituted");
  expect(seed).toContain("worktree");
  expect(seed).toContain("{headline, issues, risk}");
  expect(seed).toContain("\n\nDo the thing.");
  // stripping the seed gives back exactly the task it was seeded with
  expect(stripEditorComments(seed)).toBe("Do the thing.");
});

// ------------------------------------------------------ stripEditorComments --

test("lines starting with # are removed; a # mid-line stays", () => {
  const text = "# header\ntask line one\nuse #7 as the example\n# trailing";
  expect(stripEditorComments(text)).toBe(
    "task line one\nuse #7 as the example",
  );
});

test("an all-comments file yields empty", () => {
  expect(stripEditorComments("# a\n# b\n#\n")).toBe("");
});

// -------------------------------------------------------- derivationPrompt --

test("the derivation prompt carries the task, the baseline, the clones and the plugins dir", () => {
  const p = derivationPrompt(
    "Run the blast-radius skill.",
    ["/home/me/dev/api", "/home/me/dev/web"],
    "/claude/home/plugins",
  );
  expect(p).toContain("Run the blast-radius skill.");
  expect(p).toContain(ALLOWED_TOOLS);
  expect(p).toContain("/home/me/dev/api");
  expect(p).toContain("/home/me/dev/web");
  expect(p).toContain("~/.claude/skills");
  expect(p).toContain(".claude/skills");
  expect(p).toContain("/claude/home/plugins");
  expect(p).toContain("traceable to something you read");
  expect(p).toContain('"tools"');
});

// ------------------------------------------------------- parseDerivedTools --

test("a valid trailing json block parses into tools and notes", () => {
  const out = [
    "I read the skill file.",
    "```json",
    '{"tools": ["Bash(node:*)", "Skill(dev:blast-radius)"], "notes": "read blast-radius"}',
    "```",
  ].join("\n");
  expect(parseDerivedTools(out)).toEqual({
    tools: ["Bash(node:*)", "Skill(dev:blast-radius)"],
    notes: "read blast-radius",
  });
});

test("non-string notes are dropped, not passed through", () => {
  const out = '```json\n{"tools": [], "notes": 42}\n```';
  expect(parseDerivedTools(out)).toEqual({ tools: [] });
});

test("prose with no block is an error", () => {
  expect(parseDerivedTools("I couldn't find any skills.")).toHaveProperty(
    "error",
  );
});

test("a malformed json block is an error", () => {
  expect(parseDerivedTools("```json\n{oops\n```")).toHaveProperty("error");
});

test("a tools array with non-string members is an error", () => {
  expect(
    parseDerivedTools('```json\n{"tools": ["Bash(x:*)", 3]}\n```'),
  ).toHaveProperty("error");
});

test("a missing tools key is an error", () => {
  expect(parseDerivedTools('```json\n{"notes": "hi"}\n```')).toHaveProperty(
    "error",
  );
});

test("a block that is not the last thing in the output is an error", () => {
  const out = [
    "```json",
    '{"tools": ["Bash(x:*)"]}',
    "```",
    "…and that is why.",
  ].join("\n");
  expect(parseDerivedTools(out)).toHaveProperty("error");
});

test("a quoted block mid-message does not shadow the real trailing one", () => {
  const out = [
    "the skill quotes this:",
    "```json",
    '{"tools": ["Bash(evil:*)"]}',
    "```",
    "but my answer is:",
    "```json",
    '{"tools": ["Bash(node:*)"]}',
    "```",
  ].join("\n");
  expect(parseDerivedTools(out)).toEqual({ tools: ["Bash(node:*)"] });
});

// -------------------------------------------------------- dropPostingTools --

test("each blocklisted posting form is dropped", () => {
  const { kept, dropped } = dropPostingTools([
    "Bash(gh pr comment:*)",
    "Bash(gh pr review:*)",
    "Bash(gh pr create:*)",
    "Bash(gh pr merge:*)",
    "Bash(gh api -X POST repos/*:*)",
    "Bash(gh api --method POST repos/*:*)",
  ]);
  expect(kept).toEqual([]);
  expect(dropped.length).toBe(6);
});

test("near-misses survive: gh pr view, gh api without a method", () => {
  const { kept, dropped } = dropPostingTools([
    "Bash(gh pr view:*)",
    "Bash(gh api user:*)",
    "Bash(gh api repos/*/commits/*/pulls:*)",
    "Bash(node:*)",
  ]);
  expect(dropped).toEqual([]);
  expect(kept.length).toBe(4);
});

// -------------------------------------------------------------- mergeTools --

test("merge dedupes, keeps existing first, and reports only the new", () => {
  const { merged, added } = mergeTools(
    ["Bash(rg:*)", "Bash(node:*)"],
    ["Bash(node:*)", "Skill(dev:blast-radius)", "Skill(dev:blast-radius)"],
  );
  expect(merged).toEqual([
    "Bash(rg:*)",
    "Bash(node:*)",
    "Skill(dev:blast-radius)",
  ]);
  expect(added).toEqual(["Skill(dev:blast-radius)"]);
});

test("an empty existing list takes the derived list as it is", () => {
  const { merged, added } = mergeTools([], ["Bash(x:*)"]);
  expect(merged).toEqual(["Bash(x:*)"]);
  expect(added).toEqual(["Bash(x:*)"]);
});
