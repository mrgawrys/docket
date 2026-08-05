import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_TOOLS,
  ConfigError,
  DEFAULT_REVIEW_PROMPT,
  claudeBin,
  effectiveAllowedTools,
  effectiveReviewPrompt,
  ghBin,
  loadConfig,
  notifyEnabled,
  paths,
} from "../src/config";

test("paths: env overrides beat XDG beats HOME defaults", () => {
  const home = { HOME: "/h" } as NodeJS.ProcessEnv;
  expect(paths(home).configPath).toBe("/h/.config/docket/config.json");
  expect(paths(home).statePath).toBe("/h/.local/state/docket/state.json");
  const xdg = {
    HOME: "/h",
    XDG_CONFIG_HOME: "/x/cfg",
    XDG_STATE_HOME: "/x/st",
  } as NodeJS.ProcessEnv;
  expect(paths(xdg).configDir).toBe("/x/cfg/docket");
  expect(paths(xdg).lockDir).toBe("/x/st/docket/.lock");
  const own = {
    HOME: "/h",
    DOCKET_CONFIG_DIR: "/o/c",
    DOCKET_STATE_DIR: "/o/s",
  } as NodeJS.ProcessEnv;
  expect(paths(own).configPath).toBe("/o/c/config.json");
  expect(paths(own).logPath).toBe("/o/s/docket.log");
  expect(paths(xdg).legacyConfigDir).toBe("/x/cfg/auto-review");
  expect(paths(own).legacyStateDir).toBeUndefined();
});

// A fresh XDG home under a temp dir, so nothing touches the real one.
const freshPaths = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return paths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_STATE_HOME: join(root, "st"),
  } as NodeJS.ProcessEnv);
};

test("loadConfig: no config anywhere seeds an editable one and says to fill it in", async () => {
  const p = freshPaths("dk-seed-");
  const err = await loadConfig(p).catch((e) => e);
  expect(err).toBeInstanceOf(ConfigError);
  expect(err.message).toMatch(/fill in/);
  const seeded = JSON.parse(readFileSync(p.configPath, "utf8"));
  expect(seeded.orgs.length).toBeGreaterThan(0);
  expect(seeded.openers.diff.length).toBeGreaterThan(0);
  writeFileSync(p.configPath, JSON.stringify({ orgs: ["mine"], repos: {} }));
  expect((await loadConfig(p)).orgs).toEqual(["mine"]);
});

test("loadConfig: a pre-rename install's config and state are carried over", async () => {
  const p = freshPaths("dk-mig-");
  const oldConfig = p.legacyConfigDir!;
  const oldState = p.legacyStateDir!;
  mkdirSync(oldConfig, { recursive: true });
  mkdirSync(join(oldState, ".lock"), { recursive: true });
  writeFileSync(
    join(oldConfig, "config.json"),
    JSON.stringify({ orgs: ["o"], repos: { "o/r": "/tmp" } }),
  );
  writeFileSync(join(oldState, "state.json"), '{"o/r#1":{"status":"done"}}');
  writeFileSync(join(oldState, ".lock", "pid"), "1");

  expect((await loadConfig(p)).orgs).toEqual(["o"]);
  expect(readFileSync(p.statePath, "utf8")).toContain("o/r#1");
  expect(existsSync(p.lockDir)).toBe(false);
  expect(existsSync(join(oldConfig, "config.json"))).toBe(true);
});

test("loadConfig: an existing docket config is never overwritten by the old one", async () => {
  const p = freshPaths("dk-mig2-");
  mkdirSync(p.legacyConfigDir!, { recursive: true });
  writeFileSync(
    join(p.legacyConfigDir!, "config.json"),
    JSON.stringify({ orgs: ["stale"], repos: {} }),
  );
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.configPath, JSON.stringify({ orgs: ["current"], repos: {} }));
  expect((await loadConfig(p)).orgs).toEqual(["current"]);
});

test("loadConfig: parses a valid config; rejects one without orgs/repos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-cfg-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ orgs: ["o"], repos: { "o/r": "/tmp" } }),
  );
  const p = paths({
    DOCKET_CONFIG_DIR: dir,
    DOCKET_STATE_DIR: dir,
  } as NodeJS.ProcessEnv);
  const cfg = await loadConfig(p);
  expect(cfg.orgs).toEqual(["o"]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ hello: 1 }));
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("binary + notification resolution", () => {
  const cfg = {
    orgs: [],
    repos: {},
    claude_bin: "/x/claude",
    notifications: false,
  };
  expect(claudeBin(cfg, {} as NodeJS.ProcessEnv)).toBe("/x/claude");
  expect(
    claudeBin(cfg, { CLAUDE_BIN: "/env/claude" } as NodeJS.ProcessEnv),
  ).toBe("/env/claude");
  expect(claudeBin({ orgs: [], repos: {} }, {} as NodeJS.ProcessEnv)).toBe(
    "claude",
  );
  expect(ghBin({} as NodeJS.ProcessEnv)).toBe("gh");
  expect(ghBin({ GH_BIN: "/g" } as NodeJS.ProcessEnv)).toBe("/g");
  expect(notifyEnabled(cfg, {} as NodeJS.ProcessEnv)).toBe(false);
  expect(notifyEnabled({ orgs: [], repos: {} }, {} as NodeJS.ProcessEnv)).toBe(
    true,
  );
  expect(
    notifyEnabled({ orgs: [], repos: {} }, {
      DOCKET_NOTIFY: "0",
    } as NodeJS.ProcessEnv),
  ).toBe(false);
});

test("effectiveReviewPrompt: absent review_prompt → the /code-review default", () => {
  expect(effectiveReviewPrompt({ orgs: [], repos: {} })).toBe(
    DEFAULT_REVIEW_PROMPT,
  );
  expect(DEFAULT_REVIEW_PROMPT).toContain("/code-review {number}");
});

test("effectiveReviewPrompt: empty or whitespace review_prompt falls back to default", () => {
  expect(
    effectiveReviewPrompt({ orgs: [], repos: {}, review_prompt: "" }),
  ).toBe(DEFAULT_REVIEW_PROMPT);
  expect(
    effectiveReviewPrompt({ orgs: [], repos: {}, review_prompt: "   \n" }),
  ).toBe(DEFAULT_REVIEW_PROMPT);
});

test("effectiveAllowedTools: no extras → the baseline verbatim", () => {
  expect(effectiveAllowedTools({ orgs: [], repos: {} })).toBe(ALLOWED_TOOLS);
  expect(
    effectiveAllowedTools({ orgs: [], repos: {}, extra_allowed_tools: [] }),
  ).toBe(ALLOWED_TOOLS);
});

test("effectiveAllowedTools: extras are appended after the baseline", () => {
  const got = effectiveAllowedTools({
    orgs: [],
    repos: {},
    extra_allowed_tools: ["Bash(bun test:*)", "Skill(my-review)"],
  });
  expect(got).toBe(`${ALLOWED_TOOLS},Bash(bun test:*),Skill(my-review)`);
});

test("loadConfig: extra_allowed_tools must be an array of strings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-cfg-"));
  const p = paths({
    DOCKET_CONFIG_DIR: dir,
    DOCKET_STATE_DIR: dir,
  } as NodeJS.ProcessEnv);
  const base = { orgs: ["o"], repos: { "o/r": "/tmp" } };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ...base, extra_allowed_tools: "Bash(bun test:*)" }),
  );
  await expect(loadConfig(p)).rejects.toThrow(/extra_allowed_tools/);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ...base, extra_allowed_tools: [1] }),
  );
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ...base, extra_allowed_tools: ["Bash(bun test:*)"] }),
  );
  expect((await loadConfig(p)).extra_allowed_tools).toEqual([
    "Bash(bun test:*)",
  ]);
});

test("loadConfig: claude_env must be an object of string values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-cfg-"));
  const p = paths({
    DOCKET_CONFIG_DIR: dir,
    DOCKET_STATE_DIR: dir,
  } as NodeJS.ProcessEnv);
  const base = { orgs: ["o"], repos: { "o/r": "/tmp" } };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ...base, claude_env: "FOO=1" }),
  );
  await expect(loadConfig(p)).rejects.toThrow(/claude_env/);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ...base, claude_env: { FOO: 1 } }),
  );
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ...base, claude_env: { FOO: "1" } }),
  );
  expect((await loadConfig(p)).claude_env).toEqual({ FOO: "1" });
});

test("loadConfig: openers must map a verb to a list of non-empty cmd arrays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-cfg-"));
  const p = paths({
    DOCKET_CONFIG_DIR: dir,
    DOCKET_STATE_DIR: dir,
  } as NodeJS.ProcessEnv);
  const base = { orgs: ["o"], repos: { "o/r": "/tmp" } };
  const write = (openers: unknown) =>
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ ...base, openers }),
    );

  write({ diff: "revdiff {base} {head}" }); // a command line, not a chain
  await expect(loadConfig(p)).rejects.toThrow(/openers/);
  write({ diff: [{ cmd: "revdiff" }] });
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
  write({ diff: [{ cmd: [] }] });
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);

  write({ diff: [{ cmd: ["delta", "{base}"] }] });
  expect((await loadConfig(p)).openers).toEqual({
    diff: [{ cmd: ["delta", "{base}"] }],
  });
});

test("effectiveReviewPrompt: a set prompt is used verbatim", () => {
  expect(
    effectiveReviewPrompt({
      orgs: [],
      repos: {},
      review_prompt: "Review this PR for security issues.",
    }),
  ).toBe("Review this PR for security issues.");
});
