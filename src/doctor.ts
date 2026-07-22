import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError, claudeBin, ghBin, loadConfig, paths as resolvePaths,
} from "./config";

interface RunResult {
  ok: boolean;
  out: string;
}

// Spawn failures (missing binary) count as a failed check, not a crash.
function runs(cmd: string[], extraEnv: Record<string, string> = {}): RunResult {
  try {
    const p = Bun.spawnSync(cmd, {
      env: { ...process.env, ...extraEnv } as Record<string, string>,
      stdout: "pipe", stderr: "pipe",
    });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// Walks the dependency chain a review run needs, one ✓/✗ line per check.
// Deliberately not withCtx: withCtx hard-exits on the very conditions doctor
// must report (missing config, unresolvable gh_account token).
export async function doctorCommand(): Promise<number> {
  const p = resolvePaths();
  let failed = 0;
  const pass = (label: string) => console.log(`✓ ${label}`);
  const fail = (label: string, hint: string) => {
    failed++;
    console.log(`✗ ${label}`);
    console.log(`  → fix: ${hint}`);
  };

  let cfg;
  try {
    cfg = await loadConfig(p);
    pass(`config: ${p.configPath}`);
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : String(e);
    fail(`config: ${p.configPath}`, msg);
    console.log("  (remaining checks skipped — fix the config first)");
    return 1;
  }

  const repos = Object.entries(cfg.repos);
  const bad = repos.filter(
    ([, path]) => !existsSync(path) || !runs(["git", "-C", path, "rev-parse", "--git-dir"]).ok,
  );
  if (bad.length === 0) {
    pass(`repo clones: ${repos.length} mapped, all present`);
  } else {
    fail(
      `repo clones: ${bad.map(([repo, path]) => `${repo} → ${path}`).join(", ")}`,
      "clone the repo(s) at those paths, or fix the paths in config.json",
    );
  }

  const gh = ghBin();
  if (!runs([gh, "--version"]).ok) {
    fail(`gh: ${gh} not runnable`, "install the GitHub CLI: https://cli.github.com");
  } else if (!runs([gh, "auth", "status"]).ok) {
    fail("gh: not authenticated", "run: gh auth login");
  } else {
    pass("gh: installed and authenticated");
  }

  if (cfg.gh_account) {
    const token = runs([gh, "auth", "token", "--user", cfg.gh_account]);
    if (token.ok && token.out) {
      pass(`gh account pin: token resolves for '${cfg.gh_account}'`);
    } else {
      fail(
        `gh account pin: no token for '${cfg.gh_account}'`,
        `run: gh auth login (the account name must match gh auth status)`,
      );
    }
  }

  const claude = claudeBin(cfg);
  const claudeEnv = cfg.claude_config_dir ? { CLAUDE_CONFIG_DIR: cfg.claude_config_dir } : {};
  if (runs([claude, "--version"], claudeEnv).ok) {
    pass(`claude: ${claude} runs`);
  } else {
    fail(`claude: ${claude} not runnable`, "install Claude Code, or set claude_bin in config.json");
  }

  const claudeHome = cfg.claude_config_dir ?? join(process.env.HOME ?? "", ".claude");
  const registryPath = join(claudeHome, "plugins", "installed_plugins.json");
  let hasPlugin = false;
  try {
    const registry = await Bun.file(registryPath).json();
    hasPlugin = Object.keys(registry.plugins ?? {}).some((k) => k.startsWith("code-review@"));
  } catch {
    // missing/unreadable registry → plugin not installed
  }
  if (hasPlugin) {
    pass("code-review plugin installed");
  } else {
    fail(
      `code-review plugin: not found in ${registryPath}`,
      "run: claude plugin install code-review@claude-plugins-official",
    );
  }

  return failed === 0 ? 0 : 1;
}
