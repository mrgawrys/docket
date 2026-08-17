// `docket prompt`: the review-task step over an already-finished setup.
// Lives here rather than main.ts so tests can drive the command body —
// main.ts calls process.exit at import time.

import { homedir } from "node:os";
import {
  type Paths,
  effectiveReviewPrompt,
  paths as resolvePaths,
  writeConfigText,
} from "../config";
import type { StepResult } from "../reviewtask";
import { makeUi } from "./flow";
import {
  type ReviewTaskOptions,
  makeDerive,
  makeEditor,
  runReviewTaskStep,
} from "./reviewtask";
import { type Resolved, resolveConfig } from "./trigger";

export interface PromptOptions {
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  step?: (o: ReviewTaskOptions) => Promise<StepResult>;
  resolve?: (p: Paths, isTty: boolean) => Promise<Resolved>;
}

// The review-task step over the loaded config. Deliberately resolveConfig,
// not withCtx: this never talks to GitHub, so a gh_account whose token has
// gone stale must not block editing the task (doctor's reasoning).
export async function promptCommand(opts: PromptOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const p = opts.paths ?? resolvePaths(env);
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const isTty = Boolean(
    (input as { isTTY?: boolean }).isTTY &&
      (output as { isTTY?: boolean }).isTTY,
  );
  const resolve = opts.resolve ?? resolveConfig;
  const found = await resolve(p, isTty);
  if ("code" in found) return found.code;
  // The wizard's step 4 just asked this exact question; asking twice is the
  // bug this flag exists to prevent.
  if (found.wizardRan) return 0;
  const cfg = found.cfg;

  const ui = makeUi(input, output, env.HOME || homedir());
  let result: StepResult;
  try {
    ui.say(ui.bold("Review task"));
    ui.say(ui.dim(`config → ${p.configPath}`));
    const step = opts.step ?? runReviewTaskStep;
    result = await step({
      ui,
      cfg,
      editor: makeEditor(ui, env),
      derive: makeDerive(cfg),
    });
  } finally {
    ui.close();
  }
  const say = (s: string) => output.write(`${s}\n`);
  if (result === "aborted") {
    say("input ended — nothing was written.");
    return 1;
  }

  let changed = false;
  if (result.task === "default") {
    // deleting the key is the whole point of "default" being an answer;
    // extra_allowed_tools is never deleted — hand-tuned entries are the user's
    if (cfg.review_prompt !== undefined) {
      delete cfg.review_prompt;
      changed = true;
    }
  } else {
    if (result.review_prompt !== effectiveReviewPrompt(cfg)) {
      cfg.review_prompt = result.review_prompt;
      changed = true;
    }
    if (result.extra_allowed_tools) {
      const before = cfg.extra_allowed_tools ?? [];
      const after = result.extra_allowed_tools;
      if (
        before.length !== after.length ||
        before.some((v, i) => v !== after[i])
      ) {
        cfg.extra_allowed_tools = after;
        changed = true;
      }
    }
  }
  if (!changed) {
    say("nothing changed — the config stands as it is.");
    return 0;
  }
  writeConfigText(p.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  say(`wrote ${p.configPath}`);
  return 0;
}
