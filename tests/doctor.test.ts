import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "./harness";

// A claude home whose plugins registry contains the code-review plugin.
function claudeHome(sb: Sandbox, withPlugin: boolean): string {
  const home = join(sb.tmp, "cchome");
  mkdirSync(join(home, "plugins"), { recursive: true });
  const plugins = withPlugin
    ? { "code-review@claude-plugins-official": [{ scope: "user" }] }
    : {};
  writeFileSync(
    join(home, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }),
  );
  return home;
}

test("doctor: all checks green → exit 0, one ✓ per check", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
    gh_account: "workacct",
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(0);
  expect(r.out.match(/✓/g)?.length).toBe(6);
  expect(r.out).not.toContain("✗");
  expect(r.out).toContain("code-review plugin");
});

test("doctor: gh_account not set → that check is not run", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(0);
  expect(r.out.match(/✓/g)?.length).toBe(5);
});

test("doctor: missing config → ✗ with example hint, later checks skipped, exit 1", () => {
  const sb = makeSandbox();
  rmSync(join(sb.configDir, "config.json"));
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("✗");
  expect(r.out).toContain("config.example.json");
  expect(r.out).toContain("skipped");
  expect(r.out).not.toContain("✓");
});

test("doctor: repo path missing or not a git repo → ✗ names the path", () => {
  const sb = makeSandbox();
  const gone = join(sb.tmp, "no-such-clone");
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": gone },
    claude_config_dir: claudeHome(sb, true),
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain(gone);
  expect(r.out).toContain("✗");
});

test("doctor: gh auth status fails → ✗ with gh auth login hint", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
  });
  const r = sb.run(["doctor"], { GH_AUTH_STATUS_FAIL: "1" });
  expect(r.code).toBe(1);
  expect(r.out).toContain("gh auth login");
});

test("doctor: pinned gh_account token unresolvable → ✗ names the account", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
    gh_account: "workacct",
  });
  const r = sb.run(["doctor"], { GH_AUTH_TOKEN_FAIL: "1" });
  expect(r.code).toBe(1);
  expect(r.out).toContain("workacct");
});

test("doctor: claude binary not runnable → ✗ mentions claude", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
  });
  const r = sb.run(["doctor"], { CLAUDE_BIN: join(sb.tmp, "no-such-claude") });
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/✗.*claude/);
});

test("doctor: code-review plugin missing → ✗ with install one-liner", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, false),
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain(
    "claude plugin install code-review@claude-plugins-official",
  );
});

test("doctor: extra_allowed_tools configured → ✓ reports how many", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
    extra_allowed_tools: ["Bash(bun test:*)", "Skill(my-review)"],
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/✓.*extra allowed tools: 2/);
});

test("doctor: claude_env configured → ✓ names the variables", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
    claude_env: { CLAUDE_BASH_WATCHDOG_SECONDS: "0" },
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/✓.*claude env extras: CLAUDE_BASH_WATCHDOG_SECONDS/);
});

test("doctor: malformed extra_allowed_tools fails the config check", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    extra_allowed_tools: "Bash(bun test:*)",
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/✗.*config/);
  expect(r.out).toContain("extra_allowed_tools");
});

test("doctor: custom review_prompt without /code-review → plugin not required", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, false),
    review_prompt: "Review this PR carefully and summarize the risks.",
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("not required");
  expect(r.out).not.toContain(
    "claude plugin install code-review@claude-plugins-official",
  );
});

test("doctor: custom review_prompt that keeps /code-review still requires the plugin", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, false),
    review_prompt: "Please run /code-review {number} and be thorough.",
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain(
    "claude plugin install code-review@claude-plugins-official",
  );
});

test("doctor: blank review_prompt → ✗ telling the user to remove or fill it", () => {
  const sb = makeSandbox();
  sb.gitInitDemo();
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: claudeHome(sb, true),
    review_prompt: "   ",
  });
  const r = sb.run(["doctor"]);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/✗.*review_prompt/);
});
