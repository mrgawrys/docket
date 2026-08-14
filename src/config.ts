import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import EXAMPLE_CONFIG from "../config.example.json" with { type: "text" };

// TypeScript types a JSON import as the parsed object and ignores the import
// attribute; the `type: "text"` is what Bun honours, so at run time this is the
// file's raw text — which is the point, the user gets the comments and order.
const EXAMPLE_TEXT = EXAMPLE_CONFIG as unknown as string;

// One candidate command for a TUI verb. argv is exec'd directly, never through
// a shell — see src/openers.ts for the tokens and the one $SHELL exception.
export interface Opener {
  cmd: string[];
}
export type Openers = Record<string, Opener[]>;

export interface Config {
  orgs: string[];
  repos: Record<string, string>;
  openers?: Openers;
  poll_interval_minutes?: number;
  claude_bin?: string;
  claude_config_dir?: string;
  claude_env?: Record<string, string>;
  gh_account?: string;
  ignored_teams?: string[];
  notifications?: boolean;
  review_prompt?: string;
  extra_allowed_tools?: string[];
}

// The review task handed to claude, minus the fixed worktree hygiene that wraps
// it (see reviewPrompt). {number}/{repo} are substituted at run time.
export const DEFAULT_REVIEW_PROMPT =
  "Review the PR by running /code-review {number}.";

// The task body actually used: the configured override, or the default when it
// is absent or blank. doctor reports a blank override separately.
export const effectiveReviewPrompt = (cfg: Config): string =>
  cfg.review_prompt?.trim() ? cfg.review_prompt : DEFAULT_REVIEW_PROMPT;

// Everything the /code-review skill's agents run, read-only. Deliberately
// absent: `gh pr comment` and broad `gh api` — the headless run must never
// post to GitHub; the user opens the ready session and posts themselves.
// `gh api repos/*/commits/*/pulls` is the one scoped exception: a read-only
// commit→PR lookup reviewers reach for, with no POST meaning on that path.
export const ALLOWED_TOOLS =
  "Read,Grep,Glob,Task,Agent,TodoWrite,Skill(code-review),Skill(code-review:code-review),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),Bash(gh pr list:*),Bash(gh api user:*),Bash(gh api repos/*/commits/*/pulls:*),Bash(gh search:*),Bash(gh issue view:*),Bash(gh issue list:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git blame:*),Bash(git rev-parse:*),Bash(git fetch:*),Bash(git worktree:*),Bash(git checkout:*),Bash(git branch:*),Bash(cd:*),Bash(echo:*)";

// The --allowedTools value a review runs with: the read-only baseline plus any
// configured extras. Extras are spliced in verbatim (claude's own grammar) —
// what a custom review_prompt needs, the user allows here.
export const effectiveAllowedTools = (cfg: Config): string =>
  [ALLOWED_TOOLS, ...(cfg.extra_allowed_tools ?? [])].join(",");

export interface Paths {
  configDir: string;
  stateDir: string;
  configPath: string;
  statePath: string;
  logPath: string;
  lockDir: string;
  // Where the same things lived before the rename; undefined when the
  // directory is pinned by env, which has no old counterpart.
  legacyConfigDir?: string;
  legacyStateDir?: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME ?? "";
  // `||` throughout, not `??`: an env var expanded from something unset arrives
  // as "", which means "not set" here and never "the filesystem root".
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  // The pre-rename AUTO_REVIEW_* names still work. A pinned directory is
  // already the user's live data, so it is adopted where it stands — migrating
  // would strand the queue and re-review (and re-bill) the whole backlog.
  const pinnedConfig = env.DOCKET_CONFIG_DIR || env.AUTO_REVIEW_CONFIG_DIR;
  const pinnedState = env.DOCKET_STATE_DIR || env.AUTO_REVIEW_STATE_DIR;
  const configDir = pinnedConfig || join(configHome, "docket");
  const stateDir = pinnedState || join(stateHome, "docket");
  return {
    configDir,
    stateDir,
    configPath: join(configDir, "config.json"),
    statePath: join(stateDir, "state.json"),
    logPath: join(stateDir, "docket.log"),
    lockDir: join(stateDir, ".lock"),
    legacyConfigDir: pinnedConfig ? undefined : join(configHome, "auto-review"),
    legacyStateDir: pinnedState ? undefined : join(stateHome, "auto-review"),
  };
}

export class ConfigError extends Error {
  // True only when there is no config file at all — the one config error the
  // first-run wizard is an answer to. A typed marker, because matching on the
  // message would break the first time the wording changes.
  readonly noConfig: boolean;
  constructor(message: string, noConfig = false) {
    super(message);
    this.noConfig = noConfig;
  }
}

// What a run with no config does when there is nobody to ask: leave an
// editable starter config rather than a pointer to a file the user may not
// have checked out. Returns the message to report. Only ever called on a
// config that is genuinely absent — it overwrites whatever is there.
export async function seedExampleConfig(p: Paths): Promise<string> {
  try {
    mkdirSync(p.configDir, { recursive: true });
    await Bun.write(p.configPath, EXAMPLE_TEXT);
  } catch {
    // unwritable config dir — fall back to telling them where it goes
    return `no config at ${p.configPath} and it could not be written there — create it with "orgs" (array) and "repos" (object), or point DOCKET_CONFIG_DIR at a writable directory`;
  }
  return `no config yet — wrote a starter one to ${p.configPath}; fill in "orgs" and "repos", then run: docket doctor`;
}

// docket was called auto-review, and kept both directories under that name.
// Copy them over on the first run that finds them, leaving the originals in
// place. State matters as much as config here: without it every PR already
// reviewed looks new, and the whole backlog gets reviewed (and billed) again.
export function migrateLegacyDirs(p: Paths): void {
  const pairs: [string | undefined, string][] = [
    [p.legacyConfigDir, p.configDir],
    [p.legacyStateDir, p.stateDir],
  ];
  for (const [from, to] of pairs) {
    if (!from || existsSync(to) || !existsSync(from)) continue;
    // Stage beside the destination and rename it into place. The guard above
    // reads the destination as "already migrated", so a copy interrupted
    // halfway must not leave one behind — that skips the retry forever and
    // starts the queue empty, which is the exact loss this function prevents.
    const staging = `${to}.migrating`;
    try {
      rmSync(staging, { recursive: true, force: true });
      cpSync(from, staging, {
        recursive: true,
        // a legacy dir that is itself a symlink (dotfiles) must become a real
        // copy, not a link back into it — we promise the originals are untouched
        dereference: true,
        // a lock is one running process's claim, not something to inherit;
        // this covers the poll lock (.lock) and the state lock (state.json.lock)
        filter: (src) => !basename(src).endsWith(".lock"),
      });
      // the log is named after the command, and the command was renamed
      const oldLog = join(staging, "auto-review.log");
      if (existsSync(oldLog))
        renameSync(oldLog, join(staging, basename(p.logPath)));
      renameSync(staging, to);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw new ConfigError(
        `could not migrate ${from} to ${to}: ${e} — the originals are untouched; move them by hand, then re-run`,
      );
    }
  }
}

// Every rule about a well-formed config, in one place: the message to report,
// or null when it is sound. The two readers react differently — loadConfig
// throws at startup, readConfigSync keeps its snapshot mid-render — but neither
// gets to disagree about what valid means, so a field added here is guarded on
// both paths at once.
export function configProblem(cfg: Config, where: string): string | null {
  if (
    !Array.isArray(cfg.orgs) ||
    typeof cfg.repos !== "object" ||
    cfg.repos === null
  ) {
    return `invalid config at ${where} — need "orgs" (array of GitHub orgs) and "repos" (object mapping "org/repo" to a local clone path)`;
  }
  if (
    cfg.claude_env !== undefined &&
    (typeof cfg.claude_env !== "object" ||
      cfg.claude_env === null ||
      Array.isArray(cfg.claude_env) ||
      Object.values(cfg.claude_env).some((v) => typeof v !== "string"))
  ) {
    return `invalid config at ${where} — "claude_env" must be an object of string values`;
  }
  if (cfg.openers !== undefined) {
    const bad =
      typeof cfg.openers !== "object" ||
      cfg.openers === null ||
      Array.isArray(cfg.openers) ||
      Object.values(cfg.openers).some(
        (chain) =>
          !Array.isArray(chain) ||
          chain.some(
            (o) =>
              typeof o !== "object" ||
              o === null ||
              !Array.isArray(o.cmd) ||
              o.cmd.length === 0 ||
              o.cmd.some((a) => typeof a !== "string"),
          ),
      );
    if (bad) {
      return `invalid config at ${where} — "openers" must map a verb to a list of { "cmd": ["prog", "args"] }`;
    }
  }
  if (
    cfg.extra_allowed_tools !== undefined &&
    (!Array.isArray(cfg.extra_allowed_tools) ||
      cfg.extra_allowed_tools.some((t) => typeof t !== "string"))
  ) {
    return `invalid config at ${where} — "extra_allowed_tools" must be an array of strings`;
  }
  return null;
}

export async function loadConfig(p: Paths = paths()): Promise<Config> {
  migrateLegacyDirs(p);
  const file = Bun.file(p.configPath);
  if (!(await file.exists())) {
    // Nothing written here: a first run on a terminal gets the wizard offered
    // before anything lands on disk, and its callers seed when it doesn't.
    throw new ConfigError(`no config at ${p.configPath}`, true);
  }
  let cfg: Config;
  try {
    cfg = (await file.json()) as Config;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${p.configPath}: ${e}`);
  }
  const problem = configProblem(cfg, p.configPath);
  if (problem) throw new ConfigError(problem);
  return cfg;
}

// The one way docket writes the user's config — the TUI's apply verb and the
// wizard both come through here. tmp + rename so a kill mid-write cannot
// corrupt a hand-maintained file, and through realpath so a config.json
// symlinked into a dotfiles repo keeps its link instead of becoming a regular
// file with the repo copy orphaned. The rename swaps in a fresh inode, so a
// mode the user tightened by hand (claude_env can hold an API key) has to be
// carried over or the write silently widens it back to the umask default.
export function writeConfigText(path: string, text: string): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  const tmp = `${real}.tmp`;
  writeFileSync(tmp, text);
  if (existsSync(real)) chmodSync(tmp, statSync(real).mode & 0o777);
  renameSync(tmp, real);
}

// The config as it stands on disk, for a caller that already holds a startup
// snapshot and needs the fresher one — the TUI re-seeds from here on every
// remount, so a rule applied before a suspend is still applied after it. Any
// failure keeps the snapshot: this runs under a render, where there is nobody
// to report an error to. That has to include a field of the wrong type, not
// just unparseable text — `extra_allowed_tools` set to a string parses fine and
// then throws where effectiveAllowedTools spreads it, mid-frame.
export function readConfigSync(path: string, fallback: Config): Config {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return fallback;
    const cfg = parsed as Config;
    return configProblem(cfg, path) ? fallback : cfg;
  } catch {
    return fallback;
  }
}

export const claudeBin = (
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): string => env.CLAUDE_BIN ?? cfg.claude_bin ?? "claude";

export const ghBin = (env: NodeJS.ProcessEnv = process.env): string =>
  env.GH_BIN ?? "gh";

// Env every claude invocation needs (review runs, resumes, doctor's check) —
// a missed spot here would give them silently different claude setups.
// claude_env carries user-specific extras (e.g. muting a notification hook in
// unattended runs); the dedicated claude_config_dir key wins on conflict.
export const claudeEnv = (cfg: Config): Record<string, string> => ({
  ...(cfg.claude_env ?? {}),
  ...(cfg.claude_config_dir
    ? { CLAUDE_CONFIG_DIR: cfg.claude_config_dir }
    : {}),
});

export const runLogPath = (p: Paths, key: string): string =>
  join(p.stateDir, "runs", key.replace(/[/#]/g, "-") + ".jsonl");

export const notifyEnabled = (
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const flag = env.DOCKET_NOTIFY ?? env.AUTO_REVIEW_NOTIFY;
  return flag !== undefined ? flag === "1" : cfg.notifications !== false;
};

// The starter config is valid JSON of the right shape, so validation alone
// calls an untouched template good — and a poller pointed at "your-github-org"
// finds nothing, forever, without an error. Compare against the template
// itself so this can never drift from what gets seeded.
export function placeholderEntries(cfg: Config): string[] {
  const example = JSON.parse(EXAMPLE_TEXT) as Config;
  const found = (cfg.orgs ?? [])
    .filter((org) => example.orgs.includes(org))
    .map((org) => `orgs: "${org}"`);
  for (const [repo, path] of Object.entries(cfg.repos ?? {})) {
    if (repo in example.repos || Object.values(example.repos).includes(path)) {
      found.push(`repos: "${repo}"`);
    }
  }
  return found;
}
