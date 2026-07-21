import { join } from "node:path";

export interface Config {
  orgs: string[];
  repos: Record<string, string>;
  poll_interval_minutes?: number;
  claude_bin?: string;
  claude_config_dir?: string;
  gh_account?: string;
  ignored_teams?: string[];
  notifications?: boolean;
}

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
    env.AUTO_REVIEW_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "auto-review");
  const stateDir =
    env.AUTO_REVIEW_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "auto-review");
  return {
    configDir,
    stateDir,
    configPath: join(configDir, "config.json"),
    statePath: join(stateDir, "state.json"),
    logPath: join(stateDir, "auto-review.log"),
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
  if (!Array.isArray(cfg.orgs) || typeof cfg.repos !== "object" || cfg.repos === null) {
    throw new ConfigError(
      `invalid config at ${p.configPath} — need "orgs" (array) and "repos" (object); see config.example.json`,
    );
  }
  return cfg;
}

export const claudeBin = (cfg: Config, env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_BIN ?? cfg.claude_bin ?? "claude";

export const ghBin = (env: NodeJS.ProcessEnv = process.env): string => env.GH_BIN ?? "gh";

export const runLogPath = (p: Paths, key: string): string =>
  join(p.stateDir, "runs", key.replace(/[/#]/g, "-") + ".jsonl");

export const notifyEnabled = (cfg: Config, env: NodeJS.ProcessEnv = process.env): boolean =>
  env.AUTO_REVIEW_NOTIFY !== undefined
    ? env.AUTO_REVIEW_NOTIFY === "1"
    : cfg.notifications !== false;
