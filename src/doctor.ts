import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  claudeBin,
  claudeEnv,
  effectiveReviewPrompt,
  ghBin,
  loadConfig,
  paths as resolvePaths,
} from "./config";
import { ghAccountToken } from "./github";

interface RunResult {
  ok: boolean;
  out: string;
}

// Spawn failures (missing binary) count as a failed check, not a crash.
function runs(cmd: string[], extraEnv: Record<string, string> = {}): RunResult {
  try {
    const p = Bun.spawnSync(cmd, {
      env: { ...process.env, ...extraEnv } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
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
    ([, path]) =>
      !existsSync(path) ||
      !runs(["git", "-C", path, "rev-parse", "--git-dir"]).ok,
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
    fail(
      `gh: ${gh} not runnable`,
      "install the GitHub CLI: https://cli.github.com",
    );
  } else if (!runs([gh, "auth", "status"]).ok) {
    fail("gh: not authenticated", "run: gh auth login");
  } else {
    pass("gh: installed and authenticated");
  }

  if (cfg.gh_account) {
    // the exact resolution path withCtx uses — doctor must not drift from it
    const token = ghAccountToken(gh, cfg.gh_account);
    if ("token" in token) {
      pass(`gh account pin: token resolves for '${cfg.gh_account}'`);
    } else {
      fail(
        `gh account pin: no token for '${cfg.gh_account}'`,
        `run: gh auth login (the account name must match gh auth status)`,
      );
    }
  }

  const claude = claudeBin(cfg);
  if (runs([claude, "--version"], claudeEnv(cfg)).ok) {
    pass(`claude: ${claude} runs`);
  } else {
    fail(
      `claude: ${claude} not runnable`,
      "install Claude Code, or set claude_bin in config.json",
    );
  }

  // Extras run without prompts in the headless review — surface them so the
  // config's effective allowlist is visible at a glance.
  if (cfg.extra_allowed_tools?.length) {
    pass(`extra allowed tools: ${cfg.extra_allowed_tools.length} configured`);
  }

  // A blank review_prompt runs the default (which needs the plugin) but is
  // almost certainly a mistake — flag it so the config reads honestly.
  if (cfg.review_prompt !== undefined && !cfg.review_prompt.trim()) {
    fail(
      "review_prompt is set but blank",
      "remove the key or give it a value; the default /code-review prompt runs meanwhile",
    );
  }

  // The plugin is only a dependency when the effective prompt runs /code-review.
  if (effectiveReviewPrompt(cfg).includes("/code-review")) {
    const claudeHome =
      cfg.claude_config_dir ?? join(process.env.HOME ?? "", ".claude");
    const registryPath = join(claudeHome, "plugins", "installed_plugins.json");
    let hasPlugin = false;
    try {
      const registry = await Bun.file(registryPath).json();
      hasPlugin = Object.keys(registry.plugins ?? {}).some((k) =>
        k.startsWith("code-review@"),
      );
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
  } else {
    pass("code-review plugin: not required (custom review_prompt)");
  }

  return failed === 0 ? 0 : 1;
}
