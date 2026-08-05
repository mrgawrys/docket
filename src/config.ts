import { join } from "node:path";

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
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME ?? "";
  const configDir =
    env.DOCKET_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "docket");
  const stateDir =
    env.DOCKET_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "docket");
  return {
    configDir,
    stateDir,
    configPath: join(configDir, "config.json"),
    statePath: join(stateDir, "state.json"),
    logPath: join(stateDir, "docket.log"),
    lockDir: join(stateDir, ".lock"),
  };
}

export class ConfigError extends Error {}

export async function loadConfig(p: Paths = paths()): Promise<Config> {
  const file = Bun.file(p.configPath);
  if (!(await file.exists())) {
    throw new ConfigError(
      `no config at ${p.configPath} — copy config.example.json there and fill it in`,
    );
  }
  let cfg: Config;
  try {
    cfg = (await file.json()) as Config;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${p.configPath}: ${e}`);
  }
  if (
    !Array.isArray(cfg.orgs) ||
    typeof cfg.repos !== "object" ||
    cfg.repos === null
  ) {
    throw new ConfigError(
      `invalid config at ${p.configPath} — need "orgs" (array) and "repos" (object); see config.example.json`,
    );
  }
  if (
    cfg.claude_env !== undefined &&
    (typeof cfg.claude_env !== "object" ||
      cfg.claude_env === null ||
      Array.isArray(cfg.claude_env) ||
      Object.values(cfg.claude_env).some((v) => typeof v !== "string"))
  ) {
    throw new ConfigError(
      `invalid config at ${p.configPath} — "claude_env" must be an object of string values`,
    );
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
      throw new ConfigError(
        `invalid config at ${p.configPath} — "openers" must map a verb to a list of { "cmd": ["prog", "args"] }`,
      );
    }
  }
  if (
    cfg.extra_allowed_tools !== undefined &&
    (!Array.isArray(cfg.extra_allowed_tools) ||
      cfg.extra_allowed_tools.some((t) => typeof t !== "string"))
  ) {
    throw new ConfigError(
      `invalid config at ${p.configPath} — "extra_allowed_tools" must be an array of strings`,
    );
  }
  return cfg;
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
): boolean =>
  env.DOCKET_NOTIFY !== undefined
    ? env.DOCKET_NOTIFY === "1"
    : cfg.notifications !== false;
