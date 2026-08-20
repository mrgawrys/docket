// The review-task setup step (spec §2): choose default or custom, capture the
// custom task through $EDITOR, and optionally have claude derive the
// extra_allowed_tools the task needs. Pure helpers live in ../reviewtask;
// this module owns the dialogue and the real editor/derive subprocesses.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  DEFAULT_RECEIVE_PROMPT,
  DEFAULT_REVIEW_PROMPT,
  claudeBin,
  claudeEnv,
} from "../config";
import {
  type StepResult,
  derivationPrompt,
  dropPostingTools,
  editorTemplate,
  mergeTools,
  parseDerivedTools,
  stripEditorComments,
} from "../reviewtask";
import { InputEnded, type Ui, cleanEnv } from "./flow";

const DERIVE_TIMEOUT_MS = 90_000;

export interface ReviewTaskOptions {
  ui: Ui;
  // In the wizard this is whatever mayOverwrite read off disk, cast down —
  // nothing is validated, so every field is read defensively.
  cfg: Config;
  // Opens $EDITOR on `seed`, returns the saved text; null = editor failed,
  // file unchanged, or result empty. undefined field = $EDITOR unset →
  // line-by-line entry via ui.ask, blank line ends it.
  editor?: (seed: string) => string | null;
  // Resolves to claude's stdout; rejects on timeout/non-zero exit.
  // undefined field = claude unavailable → the derivation offer is never made.
  derive?: (prompt: string) => Promise<string>;
}

const currentTask = (cfg: Config): string =>
  typeof cfg.review_prompt === "string" && cfg.review_prompt.trim()
    ? cfg.review_prompt
    : DEFAULT_REVIEW_PROMPT;

const stringArray = (v: unknown): string[] =>
  Array.isArray(v) && v.every((t) => typeof t === "string")
    ? (v as string[])
    : [];

// The task text, from $EDITOR or line-by-line; null = keep the current task.
async function captureTask(
  o: Pick<ReviewTaskOptions, "ui" | "editor">,
  seed: string,
): Promise<string | null> {
  const { ui } = o;
  if (o.editor) {
    const saved = o.editor(editorTemplate(seed));
    if (saved === null) return null;
    return stripEditorComments(saved) || null;
  }
  ui.say(ui.dim("   no $EDITOR set — type the task; a blank line ends it."));
  const lines: string[] = [];
  for (;;) {
    const line = await ui.ask("   ");
    if (!line) break;
    lines.push(line);
  }
  return lines.join("\n") || null;
}

// The derivation offer and proposal. Returns the merged allowlist to store,
// or null when nothing should be written (declined, skipped, failed, or
// nothing new) — null must become an *omitted* key, never an empty array,
// so it cannot clobber hand-set extras.
async function deriveExtras(
  o: ReviewTaskOptions,
  task: string,
): Promise<string[] | null> {
  const { ui } = o;
  ui.say();
  ui.say("   docket can't tell which tools that needs — a headless review");
  ui.say("   can't ask, so anything unlisted is denied mid-run.");
  if (!o.derive) return null;

  const offer = await ui.ask(
    "   ask claude to work it out? It reads the skills your prompt names. [Y/n] ",
    "y",
  );
  if (/^n/i.test(offer)) {
    ui.say(
      ui.dim(
        "   ok — a denied tool shows as a ⊘ chip in the queue; the D view lists",
      ),
    );
    ui.say(ui.dim("   denials, and `a` appends one to the allowlist."));
    return null;
  }

  ui.say(ui.dim("   asking claude… (up to 90s)"));
  const clones = Object.values(
    typeof o.cfg.repos === "object" && o.cfg.repos !== null ? o.cfg.repos : {},
  ).filter((p): p is string => typeof p === "string");
  // The same resolution doctor uses — truthiness, not ??: the seeded config
  // carries claude_config_dir: "", which means "not set", never a path.
  const claudeHome =
    typeof o.cfg.claude_config_dir === "string" && o.cfg.claude_config_dir
      ? o.cfg.claude_config_dir
      : join(process.env.HOME ?? "", ".claude");
  const pluginsDir = join(claudeHome, "plugins");
  let parsed: ReturnType<typeof parseDerivedTools>;
  try {
    parsed = parseDerivedTools(
      await o.derive(derivationPrompt(task, clones, pluginsDir)),
    );
  } catch {
    parsed = { error: "derivation failed" };
  }
  if ("error" in parsed) {
    ui.say(
      ui.dim(
        "   couldn't work it out — starting with no extra tools; denials show up in the D view.",
      ),
    );
    return null;
  }
  if (parsed.notes) ui.say(ui.dim(`   (${parsed.notes})`));

  const existing = stringArray(o.cfg.extra_allowed_tools);
  let { kept, dropped } = dropPostingTools(parsed.tools);
  for (;;) {
    const { merged, added } = mergeTools(existing, kept);
    ui.say();
    ui.say("   proposed extra_allowed_tools:");
    if (added.length === 0) ui.say(ui.dim("   (nothing new to add)"));
    for (const t of added) ui.say(`   + ${ui.accent(t)}`);
    if (dropped.length > 0) {
      ui.say(
        ui.dim(
          `   (dropped ${dropped.length} posting tool(s) — the headless review must never post to GitHub)`,
        ),
      );
    }
    ui.say(ui.dim("   these run without prompts — read before accepting."));
    const verb = (
      await ui.ask(
        "   [a] accept  [e] edit the list  [s] skip — start with none ",
        "a",
      )
    ).toLowerCase();
    if (verb.startsWith("s")) return null;
    if (verb.startsWith("e")) {
      // The user's own line is the by-hand path, so the tripwire does not
      // re-run on it — "knowingly" means typed by the user.
      const line = await ui.ask(
        "   tools (comma separated): ",
        kept.join(", "),
      );
      kept = line
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      dropped = [];
      continue;
    }
    if (verb.startsWith("a")) return added.length > 0 ? merged : null;
    ui.say(ui.dim("   not a valid choice"));
  }
}

export async function runReviewTaskStep(
  o: ReviewTaskOptions,
): Promise<StepResult> {
  try {
    return await dialogue(o);
  } catch (e) {
    // A closed stdin is this step's aborted outcome; each door maps it —
    // the wizard to its aborted path, `docket prompt` to exit 1.
    if (e instanceof InputEnded) return "aborted";
    throw e;
  }
}

async function dialogue(o: ReviewTaskOptions): Promise<StepResult> {
  const { ui } = o;
  const current = currentTask(o.cfg);
  const currentIsDefault = current === DEFAULT_REVIEW_PROMPT;
  if (!currentIsDefault) {
    ui.say(ui.dim("   current task:"));
    for (const line of current.split("\n")) ui.say(`     ${ui.accent(line)}`);
  }
  ui.say("   1) default — run /code-review on the PR");
  ui.say("   2) custom  — write your own");
  let choice: string;
  for (;;) {
    choice = await ui.ask("   which? [1-2] ");
    if (choice === "1" || choice === "2") break;
    ui.say(ui.dim("   not a valid choice"));
  }
  if (choice === "1") return { task: "default" };

  const task = await captureTask(o, currentTask(o.cfg));
  if (task === null) {
    // Nothing captured keeps the current task — which is the default answer
    // in the wizard, and the standing custom task in `docket prompt`.
    ui.say(ui.dim("   nothing entered — keeping the current task."));
    if (currentIsDefault) return { task: "default" };
    return { task: "custom", review_prompt: current };
  }

  ui.say();
  ui.say(ui.dim("   review task:"));
  for (const line of task.split("\n")) ui.say(`     ${ui.accent(line)}`);

  const extras = await deriveExtras(o, task);
  if (extras === null) return { task: "custom", review_prompt: task };
  return { task: "custom", review_prompt: task, extra_allowed_tools: extras };
}

// ------------------------------------------------------ the receive step --

export interface ReceiveStepOptions {
  ui: Ui;
  cfg: Config;
  editor?: (seed: string) => string | null;
}

// receive_prompt is only present when a NEW custom task was captured here —
// an existing non-default receive_prompt is never overwritten (a wizard
// answer once deleted a hand-written review_prompt; this is the hard rule
// that keeps it from happening again).
export type ReceiveStepResult =
  | { receive_enabled: boolean; receive_prompt?: string }
  | "aborted";

export async function runReceiveStep(
  o: ReceiveStepOptions,
): Promise<ReceiveStepResult> {
  try {
    return await receiveDialogue(o);
  } catch (e) {
    if (e instanceof InputEnded) return "aborted";
    throw e;
  }
}

async function receiveDialogue(
  o: ReceiveStepOptions,
): Promise<ReceiveStepResult> {
  const { ui } = o;
  ui.say("   when someone reviews one of your PRs, docket can pre-run");
  ui.say("   /receive-code-review in that PR's checkout — edits and local");
  ui.say("   commits only; it never pushes, never writes to GitHub.");
  const answer = await ui.ask("   also act on reviews you receive? [y/N] ");
  if (!answer.toLowerCase().startsWith("y")) return { receive_enabled: false };

  const existing =
    typeof o.cfg.receive_prompt === "string" && o.cfg.receive_prompt.trim()
      ? o.cfg.receive_prompt
      : undefined;
  if (existing && existing !== DEFAULT_RECEIVE_PROMPT) {
    ui.say(ui.dim("   keeping your existing receive task:"));
    for (const line of existing.split("\n")) ui.say(`     ${ui.accent(line)}`);
    return { receive_enabled: true };
  }

  ui.say("   1) default — run /receive-code-review on the feedback");
  ui.say("   2) custom  — write your own");
  let choice: string;
  for (;;) {
    choice = await ui.ask("   which? [1-2] ", "1");
    if (choice === "1" || choice === "2") break;
    ui.say(ui.dim("   not a valid choice"));
  }
  if (choice === "1") return { receive_enabled: true };

  const task = await captureTask(o, DEFAULT_RECEIVE_PROMPT);
  if (task === null) {
    ui.say(ui.dim("   nothing entered — using the default receive task."));
    return { receive_enabled: true };
  }
  ui.say();
  ui.say(ui.dim("   receive task:"));
  for (const line of task.split("\n")) ui.say(`     ${ui.accent(line)}`);
  return { receive_enabled: true, receive_prompt: task };
}

// ------------------------------------------- the real editor and derive --

export function makeEditor(
  ui: Ui,
  env: NodeJS.ProcessEnv,
): ((seed: string) => string | null) | undefined {
  const editor = (env.EDITOR ?? "").trim();
  if (!editor) return undefined;
  // $EDITOR is a shell-ish value ("code --wait" is common): word-split it,
  // don't exec it as one token.
  const argv = editor.split(/\s+/);
  return (seed) => {
    const file = join(tmpdir(), `docket-task-${process.pid}-${Date.now()}.md`);
    try {
      writeFileSync(file, seed);
      const code = ui.suspend(
        () =>
          Bun.spawnSync([...argv, file], {
            stdio: ["inherit", "inherit", "inherit"],
            env: cleanEnv(env),
          }).exitCode,
      );
      if (code !== 0) return null;
      const text = readFileSync(file, "utf8");
      return text === seed ? null : text;
    } catch {
      return null;
    } finally {
      rmSync(file, { force: true });
    }
  };
}

export function makeDerive(
  cfg: Config,
): ((prompt: string) => Promise<string>) | undefined {
  // claudeBin, not PATH literally: CLAUDE_BIN/claude_bin can point anywhere,
  // and Bun.which resolves absolute paths too.
  const bin = claudeBin(cfg);
  if (typeof bin !== "string" || !Bun.which(bin)) return undefined;
  return async (prompt) => {
    // Mirrors the review invocation (src/reviewer.ts), read-only and small.
    // claudeEnv is load-bearing: claude_config_dir is where the plugins live.
    const proc = Bun.spawn(
      [
        bin,
        "-p",
        prompt,
        "--output-format",
        "text",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read,Grep,Glob",
      ],
      {
        env: { ...cleanEnv(process.env), ...claudeEnv(cfg) },
        stdout: "pipe",
        // never read, and an undrained pipe can block a chatty child
        stderr: "ignore",
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, DERIVE_TIMEOUT_MS);
    try {
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (timedOut) throw new Error("derivation timed out");
      if (code !== 0) throw new Error(`claude exited ${code}`);
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}
