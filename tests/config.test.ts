import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, claudeBin, ghBin, loadConfig, notifyEnabled, paths } from "../src/config";

test("paths: env overrides beat XDG beats HOME defaults", () => {
  const home = { HOME: "/h" } as NodeJS.ProcessEnv;
  expect(paths(home).configPath).toBe("/h/.config/auto-review/config.json");
  expect(paths(home).statePath).toBe("/h/.local/state/auto-review/state.json");
  const xdg = { HOME: "/h", XDG_CONFIG_HOME: "/x/cfg", XDG_STATE_HOME: "/x/st" } as NodeJS.ProcessEnv;
  expect(paths(xdg).configDir).toBe("/x/cfg/auto-review");
  expect(paths(xdg).lockDir).toBe("/x/st/auto-review/.lock");
  const own = { HOME: "/h", AUTO_REVIEW_CONFIG_DIR: "/o/c", AUTO_REVIEW_STATE_DIR: "/o/s" } as NodeJS.ProcessEnv;
  expect(paths(own).configPath).toBe("/o/c/config.json");
  expect(paths(own).logPath).toBe("/o/s/auto-review.log");
});

test("loadConfig: missing file throws ConfigError pointing at config.example.json", async () => {
  const p = paths({ AUTO_REVIEW_CONFIG_DIR: "/nonexistent-xyz", AUTO_REVIEW_STATE_DIR: "/tmp" } as NodeJS.ProcessEnv);
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
  await expect(loadConfig(p)).rejects.toThrow(/config\.example\.json/);
});

test("loadConfig: parses a valid config; rejects one without orgs/repos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-cfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ orgs: ["o"], repos: { "o/r": "/tmp" } }));
  const p = paths({ AUTO_REVIEW_CONFIG_DIR: dir, AUTO_REVIEW_STATE_DIR: dir } as NodeJS.ProcessEnv);
  const cfg = await loadConfig(p);
  expect(cfg.orgs).toEqual(["o"]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ hello: 1 }));
  await expect(loadConfig(p)).rejects.toThrow(ConfigError);
});

test("binary + notification resolution", () => {
  const cfg = { orgs: [], repos: {}, claude_bin: "/x/claude", notifications: false };
  expect(claudeBin(cfg, {} as NodeJS.ProcessEnv)).toBe("/x/claude");
  expect(claudeBin(cfg, { CLAUDE_BIN: "/env/claude" } as NodeJS.ProcessEnv)).toBe("/env/claude");
  expect(claudeBin({ orgs: [], repos: {} }, {} as NodeJS.ProcessEnv)).toBe("claude");
  expect(ghBin({} as NodeJS.ProcessEnv)).toBe("gh");
  expect(ghBin({ GH_BIN: "/g" } as NodeJS.ProcessEnv)).toBe("/g");
  expect(notifyEnabled(cfg, {} as NodeJS.ProcessEnv)).toBe(false);
  expect(notifyEnabled({ orgs: [], repos: {} }, {} as NodeJS.ProcessEnv)).toBe(true);
  expect(notifyEnabled({ orgs: [], repos: {} }, { AUTO_REVIEW_NOTIFY: "0" } as NodeJS.ProcessEnv)).toBe(false);
});
