// The first-run trigger (spec §1): what a command does about the config it
// found, and the offer it puts up when there is a person there to answer.

import { createInterface } from "node:readline/promises";
import {
  type Config,
  ConfigError,
  type Paths,
  loadConfig,
  placeholderEntries,
  seedExampleConfig,
} from "../config";
import { type ClaudeWizardOptions, runClaudeWizard } from "./claude";
import {
  type WizardOptions,
  type WizardOutcome,
  runNativeWizard,
} from "./flow";

export type FirstRunAction =
  | "offer-wizard"
  | "seed-and-fail"
  | "proceed"
  | "report-error";

export type OfferReason = "no-config" | "placeholders";

// The whole trigger rule, kept away from the I/O it decides between.
// Placeholders count as "no config yet" because they load as shape-valid: a
// poller seeded by an earlier headless run would otherwise be the only thing
// the user ever gets, and the wizard would never be offered.
export function firstRunAction(
  found: Config | ConfigError,
  isTty: boolean,
): FirstRunAction {
  if (found instanceof ConfigError) {
    // Any other config error is a file the user owns and got wrong. Neither
    // the wizard nor the seeder may write over it.
    if (!found.noConfig) return "report-error";
    return isTty ? "offer-wizard" : "seed-and-fail";
  }
  return isTty && placeholderEntries(found).length > 0
    ? "offer-wizard"
    : "proceed";
}

// ---------------------------------------------------------------- the offer --

// One question, one readline: a wizard opens its own interface on the same
// stdin, and two live at once would both eat the user's keystrokes. Returns
// null when the stream ends, so a closed stdin declines instead of hanging.
async function ask(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
): Promise<string | null> {
  const rl = createInterface({ input, output });
  try {
    // setPrompt, not a bare write: readline repaints the line from its own
    // prompt on edits, and would otherwise replace the question with "> ".
    rl.setPrompt(question);
    rl.prompt();
    const { value, done } = await rl[Symbol.asyncIterator]().next();
    return done ? null : String(value).trim();
  } finally {
    rl.close();
  }
}

export interface OfferOptions {
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  reason?: OfferReason;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runNative?: (o: WizardOptions) => Promise<WizardOutcome>;
  runClaude?: (o: ClaudeWizardOptions) => Promise<WizardOutcome>;
}

export async function offerFirstRun(
  opts: OfferOptions = {},
): Promise<WizardOutcome | "declined"> {
  const env = opts.env ?? process.env;
  const p = opts.paths;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const runNative = opts.runNative ?? runNativeWizard;
  const runClaude = opts.runClaude ?? runClaudeWizard;
  const say = (s = "") => {
    output.write(`${s}\n`);
  };
  const claude = () => runClaude({ paths: p, env, output });

  say();
  say(
    opts.reason === "placeholders"
      ? "docket's config is still the starter template — nothing in it is real yet."
      : "docket has no config yet.",
  );
  say();
  say("  1) quick setup — a few questions, right here");
  say("  2) claude-guided setup — hand it to claude (a session opens)");
  say(
    opts.reason === "placeholders" ? "  3) leave it as it is" : "  3) not now",
  );
  say();

  let choice: string | null;
  for (;;) {
    choice = await ask(input, output, "  choice [1] ");
    if (choice === null || /^([123]|q(uit)?)?$/i.test(choice)) break;
    say("  not a valid choice — 1, 2 or 3");
  }
  if (choice === null || choice === "3" || /^q/i.test(choice))
    return "declined";
  if (choice === "2") return claude();

  const outcome = await runNative({ paths: p, env, input, output });
  if (outcome !== "came-up-short") return outcome;
  // Spec: the claude wizard is also the fallback when the native flow comes up
  // short — an empty org list, a scan that found nothing.
  say();
  const again = await ask(
    input,
    output,
    "  hand the rest to claude instead? [Y/n] ",
  );
  if (again === null || /^n/i.test(again)) return outcome;
  return claude();
}

// ------------------------------------------------------------ what withCtx does --

export interface ResolveDeps {
  load?: (p: Paths) => Promise<Config>;
  seed?: (p: Paths) => Promise<string>;
  offer?: (
    p: Paths,
    reason: OfferReason,
  ) => Promise<WizardOutcome | "declined">;
  report?: (message: string) => void;
}

// wizardRan is true only when the offer-wizard path completed a wizard: setup
// just asked every question, so a command whose question it already asked —
// `docket prompt` — must not ask it again.
export type Resolved = { cfg: Config; wizardRan?: boolean } | { code: number };

// The config a command runs with, or the exit code it leaves with.
export async function resolveConfig(
  p: Paths,
  isTty: boolean,
  deps: ResolveDeps = {},
): Promise<Resolved> {
  const load = deps.load ?? loadConfig;
  const seed = deps.seed ?? seedExampleConfig;
  const offer =
    deps.offer ??
    ((paths: Paths, reason: OfferReason) => offerFirstRun({ paths, reason }));
  const report = deps.report ?? ((m: string) => console.error(m));

  let found: Config | ConfigError;
  try {
    found = await load(p);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    found = e;
  }

  const action = firstRunAction(found, isTty);
  if (action === "offer-wizard") {
    // What the wizard did is on disk, not in its return value, so read it back
    // rather than trust it — and from here the run does exactly what it would
    // have done with nobody there to ask.
    const outcome = await offer(
      p,
      found instanceof ConfigError ? "no-config" : "placeholders",
    );
    const resolved = await resolveConfig(p, false, deps);
    // Only a completed wizard asked the review-task question; a declined or
    // aborted offer never reached it, so `docket prompt` must still ask.
    return "cfg" in resolved && outcome === "completed"
      ? { ...resolved, wizardRan: true }
      : resolved;
  }
  if (found instanceof ConfigError) {
    report(action === "seed-and-fail" ? await seed(p) : found.message);
    return { code: 1 };
  }
  return { cfg: found };
}

