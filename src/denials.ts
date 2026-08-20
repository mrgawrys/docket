import {
  effectiveAllowedTools,
  effectiveReceiveAllowedTools,
  type Config,
} from "./config";
import type { EntryKind } from "./state";

// What a headless review's permission denials say, read off its stream-json run
// log after the fact. Reviews run with `--permission-mode dontAsk` and a
// read-only allowlist (see ALLOWED_TOOLS in config.ts), so a denied call is
// either a rule worth adding or a deliberate wall — and the user only ever sees
// which if something digs it out of the log.

// One denied tool call, joined to the tool_use that asked for it.
export interface DeniedCall {
  tool: string;
  input: Record<string, unknown>;
}

// A run's denials that one allowlist entry would have covered. Stored on the
// PR's state entry, so every field stays JSON-plain.
export interface DenialGroup {
  tool: string;
  // the `extra_allowed_tools` entry that would have let these calls through
  suggestion: string;
  count: number;
  examples: string[];
  // Would let the review write — to GitHub, to git history, or to disk. Shown
  // like any other group, but never applied with one key: docket's read-only
  // stance must not erode one convenient keypress at a time.
  writeShaped: boolean;
  // The rule is already in the effective allowlist and the call was denied
  // anyway — a `*` in the middle of a pattern, or a prefix the call never
  // matched. Adding it again fixes nothing.
  alreadyAllowed: boolean;
}

// In real logs this prefix cleanly separates denials from ordinary tool
// failures (exit codes, missing files), which come back as errors too.
const DENIAL_PREFIX = "Permission to use";
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_LENGTH = 120;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;

// The content blocks of one run-log line; empty for junk, noise and the
// half-written line at the end of a log still being appended to.
function blocks(line: string): Block[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const content = asRecord(asRecord(event)?.message)?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Block => asRecord(b) !== undefined)
    : [];
}

// A tool_result carries either a string or content blocks.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const text = asRecord(b)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

// Every denied call in a run log, in the order the run made them. A denial
// whose tool_use is not in the log is dropped: without the call there is
// nothing to suggest.
export function parseDenials(logText: string): DeniedCall[] {
  const calls = new Map<string, DeniedCall>();
  const denied: DeniedCall[] = [];
  for (const line of logText.split("\n")) {
    for (const b of blocks(line)) {
      if (b.type === "tool_use" && b.id && b.name) {
        calls.set(b.id, { tool: b.name, input: asRecord(b.input) ?? {} });
        continue;
      }
      if (b.type !== "tool_result" || !b.is_error || !b.tool_use_id) continue;
      if (!resultText(b.content).trimStart().startsWith(DENIAL_PREFIX))
        continue;
      const call = calls.get(b.tool_use_id);
      if (call) denied.push(call);
    }
  }
  return denied;
}

// `a && b`, `a; b`, `a | b` — the rule comes from one statement, not the chain.
const SEPARATORS = /\s*(?:&&|\|\||[;|])\s*/;
// Setup the real command hides behind: `cd <worktree> &&`, `W=<path>;`.
const PRELUDE = /^(?:cd\s|\w+=)/;
// A statement can carry its own environment — `GH_PAGER=cat gh pr view 1`.
// Only assignments the command follows are stripped, so a statement that is
// nothing but an assignment stays one and PRELUDE still skips it.
const ENV_PREFIX = /^(?:\w+=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
// A word that can still be part of the rule; a flag, path or argument ends it.
const RULE_WORD = /^[a-z][a-z0-9-]*$/i;
// What a program can be called. Reviews also run things no allowlist prefix
// could ever cover — array literals, quoted paths, loops — and those are
// dropped rather than turned into a rule nobody can use.
const COMMAND_NAME = /^[A-Za-z0-9_./@-]+$/;
const SHELL_KEYWORDS = new Set([
  "for",
  "while",
  "until",
  "if",
  "case",
  "function",
  "do",
  "then",
]);
// How many words past the command name the rule needs. Only a multiplexer's
// second word is a subcommand — anywhere else it is an argument, and
// `Bash(echo done:*)` is a rule covering the one call already denied. `gh`
// takes two: `Bash(gh pr:*)` would allow `gh pr comment`.
const RULE_WORDS: Record<string, number> = {
  git: 1,
  gh: 2,
  npm: 1,
  pnpm: 1,
  yarn: 1,
  bun: 1,
  docker: 1,
  brew: 1,
  cargo: 1,
  go: 1,
};

// The allowlist entry that would have covered a denied shell command, derived
// from its leading words — `cd /wt && git fetch origin` -> `Bash(git fetch:*)`.
function bashSuggestion(command: string): string | undefined {
  const statements = command
    // a trailing backslash continues the statement onto the next line
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .flatMap((l) => l.split(SEPARATORS))
    .map((s) => s.trim().replace(ENV_PREFIX, ""))
    .filter(Boolean);
  const statement = statements.find((s) => !PRELUDE.test(s)) ?? statements[0];
  const [name, ...rest] = statement?.split(/\s+/) ?? [];
  if (!name || !COMMAND_NAME.test(name) || SHELL_KEYWORDS.has(name))
    return undefined;
  // `git -C <dir> log` is `cd <dir> && git log` spelled differently
  if (name === "git" && rest[0] === "-C") rest.splice(0, 2);
  const words = [name];
  const limit = RULE_WORDS[name] ?? 0;
  for (const word of rest) {
    if (words.length > limit || !RULE_WORD.test(word)) break;
    words.push(word);
  }
  return `Bash(${words.join(" ")}:*)`;
}

// Whatever names what the tool was asked to do, bounded: state.json keeps this
// forever, and nothing else stops an agent from sending a huge input.
function exampleOf(input: Record<string, unknown>): string | undefined {
  const raw =
    input.command ??
    input.url ??
    input.file_path ??
    input.pattern ??
    input.prompt;
  if (typeof raw !== "string") return undefined;
  return (
    raw.replace(/\s+/g, " ").trim().slice(0, MAX_EXAMPLE_LENGTH) || undefined
  );
}

// Tools that change something; a review that needs them is not doing review.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const WRITE_SHAPED: RegExp[] = [
  /^git (?:push|commit|add|rm|mv|reset|clean|revert|restore|stash|apply|cherry-pick|merge|rebase|tag|config|remote|submodule|gc)\b/,
  // every gh verb but the few that only read; `gh api` is one flag away from
  // posting, whatever path it names
  /^gh (?!pr (?:view|diff|checks|list)\b|issue (?:view|list)\b|repo view\b|search\b|auth status\b)/,
  // a bare multiplexer drags its write subcommands in with it
  /^(?:git|gh|npm|pnpm|yarn|bun|pip3?|brew|docker)$/,
  /^(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|dd|tee|truncate|kill|killall|curl|wget|rsync|npm|pnpm|yarn|bun|pip3?|brew|docker|make)\b/,
  // An interpreter, an in-place editor or a command-builder is a write tool
  // wearing a read tool's name — `Bash(sh:*)` grants everything `Bash(rm:*)`
  // does, and every pattern here is anchored, so `xargs rm` would slip past.
  // npx/bunx belong here too: they fetch a package and run it.
  /^(?:sh|bash|zsh|fish|python3?|node|deno|ruby|perl|osascript|sudo|env|eval|xargs|sed|awk|find|tee|npx|bunx)\b/,
];

// "Bash(git push:*)" -> "git push"; any other suggestion is a bare tool name.
const ruleCommand = (suggestion: string): string =>
  /^Bash\((.*):\*\)$/.exec(suggestion)?.[1] ?? suggestion;

// Exported because a group's flag is frozen at the end of the run that wrote
// it: what the UI rails on, and what a hand-off prompt claims, must be what
// this version of the classifier says now.
export function isWriteShaped(suggestion: string): boolean {
  if (WRITE_TOOLS.has(suggestion)) return true;
  const command = ruleCommand(suggestion);
  return WRITE_SHAPED.some((re) => re.test(command));
}

// Is this entry already in the allowlist the run ran with — the kind's
// baseline or the user's extras for that kind? Exported because the same
// question decides whether the UI may offer to add it.
export function isAllowed(
  suggestion: string,
  cfg: Config,
  kind: EntryKind = "review",
): boolean {
  const list =
    kind === "mine"
      ? effectiveReceiveAllowedTools(cfg)
      : effectiveAllowedTools(cfg).split(",");
  return list.some((entry) => entry.trim() === suggestion);
}

// A group's suggestion, added to the config text on disk — into the extras
// key of the kind whose run was denied. JSON.parse/stringify round-trips key
// order (object keys iterate in the order JSON.parse read them), so this
// survives without a diff-preserving JSON library.
export function applySuggestion(
  configText: string,
  suggestion: string,
  kind: EntryKind = "review",
): string {
  const cfg = JSON.parse(configText) as Config;
  const field =
    kind === "mine" ? "extra_receive_allowed_tools" : "extra_allowed_tools";
  const tools = cfg[field] ?? [];
  if (!tools.some((t) => t.trim() === suggestion)) {
    cfg[field] = [...tools, suggestion];
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

// The denials of one run, grouped and classified: what to suggest, how often it
// bit, and the two reasons a suggestion must not be applied blindly.
export function denialGroups(
  logText: string,
  cfg: Config,
  kind: EntryKind = "review",
): DenialGroup[] {
  const groups = new Map<string, DenialGroup>();
  for (const call of parseDenials(logText)) {
    const command =
      typeof call.input.command === "string" ? call.input.command : "";
    const suggestion =
      call.tool === "Bash" ? bashSuggestion(command) : call.tool;
    if (!suggestion) continue; // a Bash call with no command says nothing
    let group = groups.get(suggestion);
    if (!group) {
      group = {
        tool: call.tool,
        suggestion,
        count: 0,
        examples: [],
        writeShaped: isWriteShaped(suggestion),
        alreadyAllowed: isAllowed(suggestion, cfg, kind),
      };
      groups.set(suggestion, group);
    }
    group.count++;
    const example = exampleOf(call.input);
    if (
      example &&
      group.examples.length < MAX_EXAMPLES &&
      !group.examples.includes(example)
    ) {
      group.examples.push(example);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.suggestion.localeCompare(b.suggestion),
  );
}
