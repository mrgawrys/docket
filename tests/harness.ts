import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "../dev/sandbox";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

// The gh/claude/launchctl shims live in dev/sandbox.ts, shared with the demo
// sandbox; this harness adds the capture-file accessors and run helpers on top.

export interface Sandbox {
  tmp: string;
  env: Record<string, string>;
  configDir: string;
  stateDir: string;
  statePath: string;
  logPath: string;
  demoRepo: string;
  run(
    args: string[],
    extraEnv?: Record<string, string | undefined>,
  ): { code: number; out: string; err: string };
  runAsync(
    args: string[],
    extraEnv?: Record<string, string | undefined>,
  ): Bun.Subprocess;
  state(): Record<string, any>;
  waitEntry(
    key: string,
    pred: (e: any) => boolean,
    timeoutMs?: number,
  ): Promise<any>;
  writeConfig(cfg: unknown): void;
  writeState(s: unknown): void;
  claudeCalls(): number;
  promptCapture(): string;
  allowedCapture(): string;
  cfgdirCapture(): string;
  watchdogCapture(): string;
  ghTokenCapture(): string;
  ghCalls(): string[];
  statusAtCall(): string;
  gitInitDemo(): void;
}

export function makeSandbox(): Sandbox {
  const tmp = mkdtempSync(join(tmpdir(), "docket-it-"));
  const { configDir, stateDir, env } = materialize(tmp);
  const demoRepo = join(tmp, "demo");
  mkdirSync(demoRepo, { recursive: true });

  const statePath = join(stateDir, "state.json");
  const writeConfig = (cfg: unknown) =>
    writeFileSync(join(configDir, "config.json"), JSON.stringify(cfg));
  writeConfig({ orgs: ["testorg"], repos: { "testorg/demo": demoRepo } });

  return {
    tmp,
    env,
    configDir,
    stateDir,
    statePath,
    logPath: join(stateDir, "docket.log"),
    demoRepo,
    run(args, extraEnv = {}) {
      const e: Record<string, string | undefined> = {
        ...process.env,
        ...env,
        ...extraEnv,
      };
      for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
      const p = Bun.spawnSync(["bun", MAIN, ...args], {
        env: e as Record<string, string>,
      });
      return {
        code: p.exitCode,
        out: p.stdout.toString(),
        err: p.stderr.toString(),
      };
    },
    runAsync(args, extraEnv = {}) {
      const e: Record<string, string | undefined> = {
        ...process.env,
        ...env,
        ...extraEnv,
      };
      for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
      return Bun.spawn(["bun", MAIN, ...args], {
        env: e as Record<string, string>,
      });
    },
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    // reviews run in detached background processes — poll/review/retry return
    // before results land, so tests poll the state file
    async waitEntry(key, pred, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let e: any;
        try {
          e = JSON.parse(readFileSync(statePath, "utf8"))[key];
        } catch {
          // state.json mid-write or absent
        }
        if (e && pred(e)) return e;
        if (Date.now() > deadline) {
          throw new Error(`waitEntry timeout for ${key}: ${JSON.stringify(e)}`);
        }
        await Bun.sleep(25);
      }
    },
    writeConfig,
    writeState: (s) => writeFileSync(statePath, JSON.stringify(s)),
    claudeCalls: () =>
      readFileSync(env.CLAUDE_CALLS!, "utf8").split("\n").filter(Boolean)
        .length,
    promptCapture: () => readFileSync(env.PROMPT_CAPTURE!, "utf8"),
    allowedCapture: () => readFileSync(env.ALLOWED_CAPTURE!, "utf8"),
    cfgdirCapture: () => readFileSync(env.CFGDIR_CAPTURE!, "utf8"),
    watchdogCapture: () => readFileSync(env.WATCHDOG_CAPTURE!, "utf8"),
    ghTokenCapture: () => readFileSync(env.GHTOKEN_CAPTURE!, "utf8"),
    ghCalls: () =>
      readFileSync(env.GH_CALLS!, "utf8").split("\n").filter(Boolean),
    statusAtCall: () => readFileSync(env.STATUS_AT_CALL!, "utf8").trim(),
    gitInitDemo() {
      const g = (...a: string[]) =>
        Bun.spawnSync(["git", "-C", demoRepo, ...a], {
          env: process.env as Record<string, string>,
        });
      g("init", "-q");
      g(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      g("worktree", "add", "--quiet", join(demoRepo, ".worktrees", "pr-7"));
    },
  };
}
