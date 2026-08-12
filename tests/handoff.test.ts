import { expect, test } from "bun:test";
import type { DenialGroup } from "../src/denials";
import { handoffPrompt } from "../src/handoff";

const group = (over: Partial<DenialGroup> = {}): DenialGroup => ({
  tool: "Bash",
  suggestion: "Bash(rg:*)",
  count: 3,
  examples: ["rg --files"],
  writeShaped: false,
  alreadyAllowed: false,
  ...over,
});

const input = (over: Partial<Parameters<typeof handoffPrompt>[0]> = {}) => ({
  key: "acme/demo#42",
  groups: [group()],
  configPath: "/Users/me/.config/docket/config.json",
  extraAllowedTools: ["Bash(gh pr view:*)"],
  effectiveAllowedTools: "Read,Grep,Bash(gh pr view:*)",
  runLogPath: "/Users/me/.local/state/docket/runs/acme-demo-42.jsonl",
  runLogExists: true,
  ...over,
});

test("the prompt explains what docket is and its read-only stance", () => {
  const p = handoffPrompt(input());
  expect(p).toContain("docket");
  expect(p.toLowerCase()).toContain("read-only");
});

test("a single group carries its suggestion, count and example", () => {
  const p = handoffPrompt(
    input({
      groups: [
        group({
          suggestion: "Bash(git log:*)",
          count: 5,
          examples: ["git log --oneline"],
        }),
      ],
    }),
  );
  expect(p).toContain("Bash(git log:*)");
  expect(p).toContain("denied 5 times");
  expect(p).toContain("git log --oneline");
});

test("every group is carried, not just the first", () => {
  const p = handoffPrompt(
    input({
      groups: [
        group({ suggestion: "Bash(rg:*)", examples: ["rg --files"] }),
        group({
          suggestion: "WebFetch",
          tool: "WebFetch",
          examples: ["https://example.com"],
        }),
      ],
    }),
  );
  expect(p).toContain("Bash(rg:*)");
  expect(p).toContain("rg --files");
  expect(p).toContain("WebFetch");
  expect(p).toContain("https://example.com");
});

test("the config path, current extras and effective allowlist are all present", () => {
  const p = handoffPrompt(input());
  expect(p).toContain("/Users/me/.config/docket/config.json");
  expect(p).toContain("Bash(gh pr view:*)");
  expect(p).toContain("Read,Grep,Bash(gh pr view:*)");
});

test("an existing run log is pointed at by path", () => {
  const p = handoffPrompt(input({ runLogExists: true }));
  expect(p).toContain("/Users/me/.local/state/docket/runs/acme-demo-42.jsonl");
});

test("a missing run log says so instead of pointing at a dead path", () => {
  const p = handoffPrompt(input({ runLogExists: false }));
  expect(p).not.toContain(
    "/Users/me/.local/state/docket/runs/acme-demo-42.jsonl",
  );
  expect(p.toLowerCase()).toMatch(/not available|no run log|missing/);
});

test("the standing order is research only, with change deferred to the user", () => {
  const p = handoffPrompt(input());
  const lower = p.toLowerCase();
  expect(lower).toContain("research only");
  expect(lower).toMatch(/propose|options/);
  expect(lower).toMatch(/nothing until|do not change|no changes/);
});

test("the PR the denials came from is named", () => {
  const p = handoffPrompt(input({ key: "acme/demo#42" }));
  expect(p).toContain("acme/demo#42");
});

test("a write-shaped group's conflict with the read-only stance is carried along", () => {
  const p = handoffPrompt(
    input({
      groups: [group({ suggestion: "Bash(git push:*)", writeShaped: true })],
    }),
  );
  expect(p).toContain("Bash(git push:*)");
  expect(p.toLowerCase()).toContain("read-only stance");
});

test("a rule that exists but didn't match says so, since that is why it was handed off", () => {
  const p = handoffPrompt(
    input({
      groups: [group({ suggestion: "Bash(git log:*)", alreadyAllowed: true })],
    }),
  );
  expect(p.toLowerCase()).toContain("didn't match");
});
