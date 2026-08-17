// Everything about the review-task setup step that needs no I/O: the editor
// seed, the derivation prompt and its parsing, the posting-tool tripwire, and
// the allowlist union. The dialogue that drives these lives in
// src/wizard/reviewtask.ts.

import { ALLOWED_TOOLS } from "./config";

// What the step hands back — "default" is an answer, not an omission: it is
// how `docket prompt` clears a custom task, which a mergeable fragment could
// never express.
export type StepResult =
  | { task: "default" }
  | { task: "custom"; review_prompt: string; extra_allowed_tools?: string[] }
  | "aborted";

export function editorTemplate(current: string): string {
  return `# The review task docket hands to claude for each PR.
# {number} and {repo} are substituted. Lines starting with # are ignored.
#
# Two things wrap this and are not configurable: the run happens in a git
# worktree, and it ends with a json block {headline, issues, risk}.

${current}
`;
}

// The git-commit convention: only lines *starting* with # are comments; a #
// mid-line is content.
export function stripEditorComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

export function derivationPrompt(
  task: string,
  clonePaths: string[],
  pluginsDir: string,
): string {
  const clones = clonePaths.length
    ? clonePaths.map((p) => `- ${p}`).join("\n")
    : "- (none configured)";
  return `A headless code review will run this task with a fixed read-only tool
allowlist. Work out which extra allowlist entries the task needs beyond that
baseline — a headless run cannot ask for permission, so anything unlisted is
denied mid-run.

The task:

${task}

The baseline allowlist it already has:

${ALLOWED_TOOLS}

If the task names a slash command or skill, locate it and read it — the tools
it needs are in the file, not in the task text. Look under ${pluginsDir},
~/.claude/skills, and .claude/skills in these configured clones:

${clones}

Every entry must be traceable to something you read; do not guess broadly.
If the task needs nothing beyond the baseline, answer with an empty list.

End your answer with a fenced json block, and nothing after it:

\`\`\`json
{"tools": [], "notes": "one line on what you read"}
\`\`\`
`;
}

// Anchored at the end of the output, like src/summary.ts: the session may
// quote json in its reasoning, and a block picked from the middle would be a
// quote, not the answer. The leading group is greedy on purpose — a lazy one
// starts at the *first* fence and swallows everything up to the final one.
const TRAILING_BLOCK = /^([\s\S]*)\n?```(?:json)?[ \t]*\n([\s\S]*?)\n?```\s*$/;

export function parseDerivedTools(
  stdout: string,
): { tools: string[]; notes?: string } | { error: string } {
  const m = TRAILING_BLOCK.exec(stdout);
  if (!m) return { error: "no trailing json block in the answer" };
  let raw: unknown;
  try {
    raw = JSON.parse(m[2]!);
  } catch (e) {
    return { error: `unparseable json block: ${e}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "the json block is not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tools) || o.tools.some((t) => typeof t !== "string")) {
    return { error: '"tools" must be an array of strings' };
  }
  const result: { tools: string[]; notes?: string } = {
    tools: o.tools as string[],
  };
  if (typeof o.notes === "string") result.notes = o.notes;
  return result;
}

// The tripwire, not a guarantee (spec §3): allowlist entries are prefix
// patterns, so no entry-level check can promise read-only survives. This
// catches the obvious cases; the real gate is the user reading the proposal.
const POSTING_COMMANDS = [
  "gh pr comment",
  "gh pr review",
  "gh pr create",
  "gh pr merge",
];

export function dropPostingTools(tools: string[]): {
  kept: string[];
  dropped: string[];
} {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of tools) {
    const posts =
      POSTING_COMMANDS.some((c) => t.includes(c)) ||
      (t.includes("gh api") && (t.includes("-X") || t.includes("--method")));
    (posts ? dropped : kept).push(t);
  }
  return { kept, dropped };
}

// Union with what the config already holds — hand-set entries always survive,
// and `added` is what the proposal shows.
export function mergeTools(
  existing: string[],
  derived: string[],
): { merged: string[]; added: string[] } {
  const merged = [...existing];
  const added: string[] = [];
  for (const d of derived) {
    if (merged.includes(d)) continue;
    merged.push(d);
    added.push(d);
  }
  return { merged, added };
}
