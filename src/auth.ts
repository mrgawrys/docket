import { join } from "node:path";
import { claudeBin, claudeEnv, type Config } from "./config";

export type AuthState =
  | { ok: true }
  | { ok: false; dir: string } // definitively logged out
  | { unknown: string }; // the probe could not answer — reason

// stdout of the probe, or null when it could not be spawned.
export type AuthRun = (
  cmd: string[],
  env: Record<string, string>,
) => string | null;

const defaultRun: AuthRun = (cmd, env) => {
  try {
    const p = Bun.spawnSync(cmd, {
      env: { ...process.env, ...env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return p.stdout.toString();
  } catch {
    return null;
  }
};

// Which account an answer is about — resolved the way the spawn resolves it.
// claudeEnv pins CLAUDE_CONFIG_DIR only when the config sets it, so with the
// key empty an ambient one is the dir actually probed; naming ~/.claude there
// would report a different account than the one that answered. `||`, not `??`:
// the seeded config carries claude_config_dir: "".
export const authDir = (
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  cfg.claude_config_dir ||
  env.CLAUDE_CONFIG_DIR ||
  join(env.HOME ?? "", ".claude");

// Same binary and env startReview uses, so the probe cannot drift from what
// the review actually runs. The exit code is useless here — `claude auth
// status` exits 0 logged in or out — so only the JSON answers.
export function claudeAuth(cfg: Config, run: AuthRun = defaultRun): AuthState {
  const bin = claudeBin(cfg);
  const out = run([bin, "auth", "status"], claudeEnv(cfg));
  if (out === null) return { unknown: `cannot run ${bin}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { unknown: "'claude auth status' did not print JSON" };
  }
  const loggedIn = (parsed as { loggedIn?: unknown } | null)?.loggedIn;
  if (typeof loggedIn !== "boolean") {
    return { unknown: "'claude auth status' reported no loggedIn field" };
  }
  return loggedIn ? { ok: true } : { ok: false, dir: authDir(cfg) };
}
