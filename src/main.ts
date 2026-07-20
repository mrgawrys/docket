#!/usr/bin/env bun

import { ConfigError, ghBin, loadConfig, paths as resolvePaths } from "./config";
import { prView } from "./github";
import { makeLogger } from "./log";
import { acquireLock } from "./lock";
import { dismissKey, interactiveList } from "./list";
import { pollCycle } from "./poll";
import { reviewPr, type Ctx } from "./reviewer";
import {
  ensureState, loadState, normalizeKey, reconcileOrphans, setStatus, splitKey,
} from "./state";
import { logCommand, statusCommand, watchCommand } from "./status";
import { reconcile } from "./sync";

const USAGE = `reviews — pre-run Claude Code reviews for PRs awaiting you

Usage:
  reviews                    interactive list (resume #, d# dismiss, r# retry, q quit)
  reviews poll [--dry-run]   one poll cycle (what launchd runs)
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
  const ctx: Ctx = {
    cfg, paths, log,
    gh: { gh: ghBin(), log, logPath: paths.logPath },
    counters: { reviewed: 0, failed: 0, skipped: 0, synced: 0 },
    current: { key: "" },
  };
  return fn(ctx);
}

async function runLocked(ctx: Ctx, fn: () => Promise<number>): Promise<number> {
  const release = acquireLock(ctx.paths.lockDir, ctx.log);
  if (!release) return 0; // another live run holds the lock (bash exits 0 here)
  const onSignal = () => {
    if (ctx.current.key) {
      ctx.current.child?.kill("SIGTERM");
      setStatus(ctx.paths.statePath, ctx.current.key, "canceled", "run interrupted");
      ctx.log(`CANCELED ${ctx.current.key} (interrupted) — retry with: reviews retry ${ctx.current.key}`);
    } else {
      ctx.log("canceled (interrupted)");
    }
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

commands["review"] = (args) =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
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
      await reviewPr(ctx, key, repo, number, info.title ?? "", info.url ?? "", args[1]);
      return 0;
    }),
  );

commands["retry"] = (args) =>
  withCtx((ctx) =>
    runLocked(ctx, async () => {
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
      const { repo, number } = splitKey(key);
      await reviewPr(ctx, key, repo, number, entry.title ?? "", entry.url ?? "", args[1]);
      return 0;
    }),
  );

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
    dismissKey(ctx, key);
    return 0;
  });

commands["status"] = () => withCtx((ctx) => statusCommand(ctx));
commands["log"] = (args) => withCtx((ctx) => logCommand(ctx, Number(args[0] ?? 20) || 20));
commands["watch"] = () => withCtx((ctx) => watchCommand(ctx));

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
