// The claude-guided half of the first-run wizard (spec §1, "both variants
// ship"): docket hands the terminal to an interactive claude session carrying
// the wizard prompt, then checks what it left behind. Adapted from the
// validated prototype (prototypes/first-run-wizard/claude-wizard/).

import {
  type Paths,
  claudeBin,
  loadConfig,
  paths as resolvePaths,
} from "../config";
import { selfArgs } from "../proc";
import type { WizardOutcome } from "./flow";
import PROMPT from "./claude-prompt.md" with { type: "text" };

// The prompt tells claude to run doctor at the end, so it needs the command
// this very process would be re-invoked with — `docket doctor` once installed,
// `bun /path/src/main.ts doctor` in development.
const shellQuote = (arg: string): string =>
  /^[\w./:@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

export const doctorInvocation = (): string =>
  selfArgs("doctor").map(shellQuote).join(" ");

// The prototype exported the paths as env vars from its launcher; the shipped
// wizard writes them into the prompt, so nothing about the session depends on
// an environment claude may or may not inherit.
export function claudeWizardPrompt(p: Paths, doctorCmd: string): string {
  return PROMPT.replaceAll("{{CONFIG_PATH}}", p.configPath)
    .replaceAll("{{CONFIG_DIR}}", p.configDir)
    .replaceAll("{{DOCTOR_CMD}}", doctorCmd);
}

export interface ClaudeWizardOptions {
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  output?: NodeJS.WritableStream;
  // Real callers hand the terminal to claude; tests stand in for the session.
  session?: (bin: string, prompt: string) => Promise<number | null>;
}

// The TUI is not running yet at first run, so this is a plain spawn with the
// terminal passed straight through — no suspend machinery.
async function claudeSession(
  bin: string,
  prompt: string,
): Promise<number | null> {
  const child = Bun.spawn([bin, prompt], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

export async function runClaudeWizard(
  opts: ClaudeWizardOptions = {},
): Promise<WizardOutcome> {
  const env = opts.env ?? process.env;
  const p = opts.paths ?? resolvePaths(env);
  const output = opts.output ?? process.stdout;
  const say = (s = "") => {
    output.write(`${s}\n`);
  };
  // No config exists yet, so claude_bin cannot have been configured — only the
  // env override and the default name are in play.
  const bin = claudeBin({ orgs: [], repos: {} }, env);
  const session = opts.session ?? claudeSession;

  say();
  say(`handing over to ${bin} — it asks the questions and writes the config.`);
  say();
  try {
    await session(bin, claudeWizardPrompt(p, doctorInvocation()));
  } catch (e) {
    say(`could not start ${bin}: ${(e as Error).message}`);
    say(
      "install the claude CLI (https://code.claude.com), then run docket again.",
    );
    return "came-up-short";
  }

  // What the session claimed is not evidence; the config it was asked for is.
  try {
    await loadConfig(p);
    return "completed";
  } catch (e) {
    say(`no usable config at ${p.configPath} — ${(e as Error).message}`);
    return "came-up-short";
  }
}
