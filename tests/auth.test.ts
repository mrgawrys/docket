import { expect, test } from "bun:test";
import { authDir, claudeAuth, type AuthRun } from "../src/auth";
import type { Config } from "../src/config";

const cfg = (extra: Partial<Config> = {}): Config =>
  ({ orgs: [], repos: {}, ...extra }) as Config;

const says =
  (out: string | null): AuthRun =>
  () =>
    out;

test("claudeAuth: loggedIn true → ok", () => {
  const r = claudeAuth(cfg(), says('{"loggedIn":true,"authMethod":"api_key"}'));
  expect(r).toEqual({ ok: true });
});

test("claudeAuth: loggedIn false → logged out, naming the config dir", () => {
  const r = claudeAuth(
    cfg({ claude_config_dir: "/tmp/work-account" }),
    says('{"loggedIn":false,"authMethod":"none"}'),
  );
  expect(r).toEqual({ ok: false, dir: "/tmp/work-account" });
});

test("authDir: an empty claude_config_dir falls back to ~/.claude", () => {
  expect(authDir(cfg({ claude_config_dir: "" }), { HOME: "/home/me" })).toBe(
    "/home/me/.claude",
  );
});

// The message names the account that answered, not a different one: with the
// config key empty the spawn inherits the ambient dir, so the report must too.
test("authDir: an ambient CLAUDE_CONFIG_DIR wins over the ~/.claude default", () => {
  expect(
    authDir(cfg(), { HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.alt" }),
  ).toBe("/home/me/.alt");
});

test("authDir: the config key still outranks an ambient one", () => {
  expect(
    authDir(cfg({ claude_config_dir: "/pinned" }), {
      CLAUDE_CONFIG_DIR: "/home/me/.alt",
    }),
  ).toBe("/pinned");
});

test("claudeAuth: non-JSON output → unknown, not logged out", () => {
  const r = claudeAuth(cfg(), says("Usage: claude auth <command>"));
  expect(r).toHaveProperty("unknown");
});

test("claudeAuth: spawn failure → unknown, not logged out", () => {
  const r = claudeAuth(cfg({ claude_bin: "/no/such/claude" }), says(null));
  expect(r).toHaveProperty("unknown");
  expect((r as { unknown: string }).unknown).toContain("cannot run");
});

test("claudeAuth: loggedIn absent → unknown (an old CLI is not a logout)", () => {
  const r = claudeAuth(cfg(), says('{"authMethod":"none"}'));
  expect(r).toHaveProperty("unknown");
});

test("claudeAuth: probes with the same binary and env a review runs with", () => {
  let seen: { cmd: string[]; env: Record<string, string> } | undefined;
  claudeAuth(
    cfg({
      claude_bin: "/opt/claude",
      claude_config_dir: "/home/me/.claude-work",
      claude_env: { CLAUDE_BASH_WATCHDOG_SECONDS: "0" },
    }),
    (cmd, env) => {
      seen = { cmd, env };
      return '{"loggedIn":true}';
    },
  );
  expect(seen!.cmd).toEqual(["/opt/claude", "auth", "status"]);
  expect(seen!.env).toEqual({
    CLAUDE_BASH_WATCHDOG_SECONDS: "0",
    CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
  });
});
