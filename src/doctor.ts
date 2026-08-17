import { existsSync } from "node:fs";
import { join } from "node:path";
import { authDir, claudeAuth } from "./auth";
import {
  ConfigError,
  type Paths,
  claudeBin,
  claudeEnv,
  effectiveReviewPrompt,
  ghBin,
  loadConfig,
  paths as resolvePaths,
  placeholderEntries,
  seedExampleConfig,
} from "./config";
import { ghAccountToken } from "./github";
import { effectiveOpeners, resolveOpeners } from "./openers";
import { launchdLoaded, legacyLaunchdLabel } from "./scheduler";

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
export async function doctorCommand(
  p: Paths = resolvePaths(),
): Promise<number> {
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
    // doctor is the one command a fresh install is told to run, and it is not
    // interactive: no config means seed one and say what to fill in.
    const msg =
      e instanceof ConfigError
        ? e.noConfig
          ? await seedExampleConfig(p)
          : e.message
        : String(e);
    fail(`config: ${p.configPath}`, msg);
    console.log("  (remaining checks skipped — fix the config first)");
    return 1;
  }

  // Loading only proves the shape is right. The starter config passes that on
  // its way out of the box, and a poller aimed at "your-github-org" then finds
  // nothing forever — with every check below it reporting ✓.
  const placeholders = placeholderEntries(cfg);
  if (placeholders.length) {
    fail(
      `config still has starter placeholders: ${placeholders.join(", ")}`,
      `replace them in ${p.configPath} with your own orgs and clone paths`,
    );
  } else if (cfg.orgs.length === 0 && Object.keys(cfg.repos).length === 0) {
    fail(
      "config has no orgs and no repos",
      `add at least one org to poll and its clone path in ${p.configPath}`,
    );
  }

  // The rename left a poller behind on every machine that upgraded without
  // install.sh. It polls the pre-rename state, so nothing else here would
  // notice it — and every PR gets reviewed, and billed, twice.
  if (launchdLoaded(legacyLaunchdLabel())) {
    fail(
      `old poller still loaded: ${legacyLaunchdLabel()}`,
      "run: docket on (it removes the old job), or: launchctl bootout gui/$(id -u)/" +
        legacyLaunchdLabel(),
    );
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

    // A runnable claude is credential-blind: without this, doctor stays green
    // while every review fails on an expired session.
    const auth = claudeAuth(cfg);
    if ("unknown" in auth) {
      fail(
        `claude auth: could not determine (${auth.unknown})`,
        "upgrade Claude Code — 'claude auth status' is how docket checks this",
      );
    } else if (!auth.ok) {
      fail(
        `claude auth: not logged in (${auth.dir})`,
        `run: CLAUDE_CONFIG_DIR=${auth.dir} claude auth login`,
      );
    } else {
      // naming the dir matters on a machine with more than one account
      pass(`claude auth: logged in (${authDir(cfg)})`);
    }
  } else {
    fail(
      `claude: ${claude} not runnable`,
      "install Claude Code, or set claude_bin in config.json",
    );
  }

  // The TUI resolves each verb's chain once at startup and greys out what it
  // cannot run; report the same answer here, so a greyed-out `d` has an
  // explanation that does not require opening the TUI.
  const winners = resolveOpeners(cfg);
  for (const [verb, chain] of Object.entries(effectiveOpeners(cfg))) {
    const winner = winners[verb];
    if (winner) {
      pass(`opener ${verb}: ${winner.join(" ")}`);
    } else {
      fail(
        `opener ${verb}: none of ${chain.map((o) => o.cmd[0]).join(", ")} is on PATH`,
        `install one of them, or set a chain that resolves under "openers" in config.json`,
      );
    }
  }

  // Extras run without prompts in the headless review — surface them so the
  // config's effective allowlist is visible at a glance.
  if (cfg.extra_allowed_tools?.length) {
    pass(`extra allowed tools: ${cfg.extra_allowed_tools.length} configured`);
  }

  // Same visibility for env extras: they shape every claude invocation.
  if (cfg.claude_env && Object.keys(cfg.claude_env).length) {
    pass(`claude env extras: ${Object.keys(cfg.claude_env).join(", ")}`);
  }

  // A blank review_prompt runs the default (which needs the plugin) but is
  // almost certainly a mistake — flag it so the config reads honestly.
  if (cfg.review_prompt !== undefined && !cfg.review_prompt.trim()) {
    fail(
      "review_prompt is set but blank",
      "remove the key or give it a value; the default /code-review prompt runs meanwhile",
    );
  }

  // The plugin registry, read once and shared by the /code-review check and
  // the per-entry Skill(plugin:name) checks below.
  // `||`, not `??`: the seeded config carries claude_config_dir: "", and an
  // empty one here would look up the registry at a relative path and report
  // an installed plugin missing. claudeEnv() reads it the same way.
  const claudeHome =
    cfg.claude_config_dir || join(process.env.HOME ?? "", ".claude");
  const registryPath = join(claudeHome, "plugins", "installed_plugins.json");
  let registryKeys: string[] = [];
  try {
    const registry = await Bun.file(registryPath).json();
    registryKeys = Object.keys(registry.plugins ?? {});
  } catch {
    // missing/unreadable registry → nothing installed
  }
  const installed = (plugin: string) =>
    registryKeys.some((k) => k.startsWith(`${plugin}@`));

  // The plugin is only a dependency when the effective prompt runs /code-review.
  if (effectiveReviewPrompt(cfg).includes("/code-review")) {
    if (installed("code-review")) {
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

  // Every Skill(plugin:name) entry names a plugin that must be installed —
  // this is what makes a copied config self-verifying. Bare Skill(foo) is a
  // personal or project skill, not in the registry, so it is skipped.
  for (const entry of cfg.extra_allowed_tools ?? []) {
    const m = /^Skill\(([^:()]+):([^:()]+)\)$/.exec(entry);
    if (!m) continue;
    const plugin = m[1]!;
    if (installed(plugin)) {
      pass(`plugin for ${entry} installed`);
    } else {
      // docket cannot know which marketplace the plugin came from
      fail(
        `plugin for ${entry}: '${plugin}' not found in ${registryPath}`,
        `install the '${plugin}' plugin: claude plugin install ${plugin}@<marketplace>`,
      );
    }
  }

  return failed === 0 ? 0 : 1;
}
