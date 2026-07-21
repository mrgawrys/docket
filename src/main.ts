#!/usr/bin/env bun

import { ConfigError, ghBin, loadConfig, paths as resolvePaths } from "./config";
import { prView } from "./github";
import { makeLogger } from "./log";
import { acquireLock } from "./lock";
import { dismissKey, interactiveList } from "./list";
import { pollCycle } from "./poll";
import { execReview, startReview, type Ctx, type StartResult } from "./reviewer";
import { offCommand, onCommand } from "./scheduler";
import {
  ensureState, loadState, normalizeKey, reconcileOrphans, setStatus, splitKey,
} from "./state";
import { logCommand, statusCommand, watchCommand } from "./status";
import { reconcile } from "./sync";

const USAGE = `reviews — pre-run Claude Code reviews for PRs awaiting you

Usage:
  reviews                    interactive list (resume #, d# dismiss, r# retry, q quit)
  reviews poll [--dry-run]   one poll cycle (what launchd runs); reviews run
                             in parallel as detached background processes
  reviews sync               reconcile state with GitHub
  reviews review <pr> [note] force-review a PR (org/repo#N or a GitHub PR URL)
  reviews retry <key>        re-run a failed review
  reviews dismiss <key>      mark done + remove the PR worktree
  reviews status             poller state, live poll, state counts
  reviews log [n]            last n log lines (default 20)
  reviews watch              follow the log live
  reviews on | off           enable/disable the scheduled poller
`;

type Command = (args: string[]) => Promise<number>;

export const commands: Record<string, Command> = {
  help: async () => {
    console.log(USAGE);
    return 0;
  },
};

async function withCtx(fn: (ctx: Ctx) => Promise<number>): Promise<number> {
  const paths = resolvePaths();
  let cfg;
  try {
    cfg = await loadConfig(paths);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  ensureState(paths.statePath);
  const log = makeLogger(paths.logPath);
  let ghEnv = process.env as Record<string, string>;
  if (cfg.gh_account) {
    // pin every gh call (and claude's gh calls) to one account — the poller
    // must not depend on whichever account `gh auth switch` left active
    const p = Bun.spawnSync([ghBin(), "auth", "token", "--user", cfg.gh_account], {
      stderr: "pipe",
    });
    const token = p.stdout.toString().trim();
    if (p.exitCode !== 0 || !token) {
      console.error(
        `cannot resolve a token for gh account '${cfg.gh_account}' — ` +
          `run: gh auth login (then gh auth status)\n${p.stderr.toString()}`,
      );
      return 1;
    }
    ghEnv = { ...ghEnv, GH_TOKEN: token };
  }
  const ctx: Ctx = {
    cfg, paths, log,
    gh: { gh: ghBin(), log, logPath: paths.logPath, env: ghEnv },
    counters: { started: 0, reviewed: 0, failed: 0, skipped: 0, synced: 0 },
    current: { key: "" },
  };
  return fn(ctx);
}

// Reviews themselves run detached, so lock holders are always short-lived:
// the lock only stops overlapping poll/sync cycles from double-starting work.
async function runLocked(ctx: Ctx, fn: () => Promise<number>): Promise<number> {
  const release = acquireLock(ctx.paths.lockDir, ctx.log);
  if (!release) return 0; // another live run holds the lock (bash exits 0 here)
  const onSignal = () => {
    ctx.log("canceled (interrupted)");
    release();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    reconcileOrphans(ctx.paths.statePath, ctx.log);
    return await fn();
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// review/retry don't take the poll lock: they only mark state and spawn a
// runner, and double-starts are stopped by the live-pid checks. Holding the
// lock would make them silently no-op whenever a poll cycle is in flight.
async function runUnlocked(ctx: Ctx, fn: () => Promise<number>): Promise<number> {
  reconcileOrphans(ctx.paths.statePath, ctx.log);
  return fn();
}

const startedMsg = (key: string, result: StartResult): number => {
  if (result === "started") {
    console.log(`${key}: review started in the background — you'll get a notification; follow with: reviews watch`);
  } else if (result === "already-running") {
    console.log(`${key}: a review is already running`);
  }
  return result === "spawn-failed" ? 1 : 0;
};

commands["review"] = (args) =>
  withCtx((ctx) =>
    runUnlocked(ctx, async () => {
      const raw = args[0];
      if (!raw) {
        console.error("usage: reviews review ORG/REPO#NUM|URL [note]");
        return 1;
      }
      let key: string;
      try {
        key = normalizeKey(raw);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      const { repo, number } = splitKey(key);
      const info = prView<{ title?: string; url?: string }>(ctx.gh, repo, number, "title,url");
      if (!info) {
        console.error(`cannot fetch ${key} from GitHub (does the PR exist?)`);
        return 1;
      }
      const result = await startReview(ctx, key, repo, info.title ?? "", info.url ?? "", args[1]);
      return startedMsg(key, result);
    }),
  );

commands["retry"] = (args) =>
  withCtx((ctx) =>
    runUnlocked(ctx, async () => {
      const raw = args[0];
      if (!raw) {
        console.error("usage: reviews retry ORG/REPO#NUM [note]");
        return 1;
      }
      let key: string;
      try {
        key = normalizeKey(raw);
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      const entry = loadState(ctx.paths.statePath)[key];
      if (!entry) {
        console.error(`unknown key: ${key}`);
        return 1;
      }
      const { repo } = splitKey(key);
      const result = await startReview(ctx, key, repo, entry.title ?? "", entry.url ?? "", args[1]);
      return startedMsg(key, result);
    }),
  );

// internal: the detached runner `startReview` spawns — one foreground review
commands["exec"] = (args) =>
  withCtx(async (ctx) => {
    const key = args[0];
    if (!key) {
      console.error("usage: reviews exec ORG/REPO#NUM");
      return 1;
    }
    const onSignal = () => {
      ctx.current.child?.kill("SIGTERM");
      if (ctx.current.key) {
        setStatus(ctx.paths.statePath, ctx.current.key, "canceled", "run interrupted");
        ctx.log(`CANCELED ${ctx.current.key} (interrupted) — retry with: reviews retry ${ctx.current.key}`);
      }
      process.exit(130);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      return await execReview(ctx, key);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  });

commands["sync"] = () =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
      reconcile(ctx);
      ctx.log(`sync complete: ${ctx.counters.synced} updated`);
      return 0;
    }),
  );

commands["poll"] = (args) =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
      await pollCycle(ctx, args.includes("--dry-run"));
      return 0;
    }),
  );

commands["dismiss"] = (args) =>
  withCtx(async (ctx) => {
    const raw = args[0];
    if (!raw) {
      console.error("usage: reviews dismiss ORG/REPO#NUM");
      return 1;
    }
    let key: string;
    try {
      key = normalizeKey(raw);
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    if (!loadState(ctx.paths.statePath)[key]) {
      console.error(`unknown key: ${key}`);
      return 1;
    }
    dismissKey(ctx, key);
    return 0;
  });

commands["status"] = () => withCtx((ctx) => statusCommand(ctx));
commands["log"] = (args) => {
  const n = Number(args[0] ?? 20);
  return withCtx((ctx) => logCommand(ctx, Number.isFinite(n) && n >= 1 ? n : 20));
};
commands["watch"] = () => withCtx((ctx) => watchCommand(ctx));
commands["on"] = () => withCtx((ctx) => onCommand(ctx));
commands["off"] = async () => offCommand();

async function main(): Promise<number> {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === undefined)
    return withCtx((ctx) => interactiveList(ctx, (key) => commands["retry"]!([key])));
  if (cmd === "-h" || cmd === "--help") return commands["help"]!([]);
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown subcommand: ${cmd} (try: reviews help)`);
    return 1;
  }
  return fn(rest);
}

process.exit(await main());
