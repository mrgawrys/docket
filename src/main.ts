#!/usr/bin/env bun

import { ghBin, paths as resolvePaths } from "./config";
import { doctorCommand } from "./doctor";
import { ghAccountToken, prView } from "./github";
import { makeLogger } from "./log";
import { acquireLock } from "./lock";
import { dismissKey, killEntry } from "./list";
import { pollCycle } from "./poll";
import {
  execReview,
  startReview,
  type Ctx,
  type StartResult,
} from "./reviewer";
import { offCommand, onCommand } from "./scheduler";
import {
  ensureState,
  loadState,
  normalizeKey,
  reconcileOrphans,
  setStatus,
  splitKey,
} from "./state";
import { logCommand, statusCommand, watchCommand } from "./status";
import { reconcile } from "./sync";
import { runTui } from "./tui/app";
import { childOwnsTerminal } from "./tui/suspend";
import { promptCommand, resolveConfig } from "./wizard/trigger";

const USAGE = `docket — pre-run Claude Code reviews for PRs awaiting you

Usage:
  docket                    review queue (enter resume, s shell, d diff,
                            D denials, w watch live, r retry, x dismiss,
                            K kill, p poll, S sync, ? help, q quit)
  docket poll [--dry-run]   one poll cycle (what launchd runs); reviews run
                            in parallel as detached background processes
  docket sync               reconcile state with GitHub
  docket review <pr> [note] force-review a PR (org/repo#N or a GitHub PR URL)
  docket retry <key>        re-run a failed review
  docket dismiss <key>      mark done + remove the PR worktree
  docket doctor             check setup: config, clones, gh, claude, code-review plugin
  docket prompt             set the review task (and the tools it needs)
  docket status             poller state, live poll, state counts
  docket log [n]            last n log lines (default 20)
  docket watch [pr]         follow the log live; with a PR (org/repo#N or
                            URL), follow that running review instead
  docket on | off           enable/disable the scheduled poller
`;

type Command = (args: string[]) => Promise<number>;

async function withCtx(fn: (ctx: Ctx) => Promise<number>): Promise<number> {
  const paths = resolvePaths();
  // Both streams, because the wizard both asks and prints: the launchd poller
  // has neither, and must never end up waiting on a prompt nobody can answer.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const found = await resolveConfig(paths, interactive);
  if ("code" in found) return found.code;
  const cfg = found.cfg;
  ensureState(paths.statePath);
  const log = makeLogger(paths.logPath);
  let ghEnv = process.env as Record<string, string>;
  if (cfg.gh_account) {
    // pin every gh call (and claude's gh calls) to one account — the poller
    // must not depend on whichever account `gh auth switch` left active
    const t = ghAccountToken(ghBin(), cfg.gh_account);
    if ("error" in t) {
      console.error(
        `cannot resolve a token for gh account '${cfg.gh_account}' — ` +
          `run: gh auth login (then gh auth status)\n${t.error}`,
      );
      return 1;
    }
    ghEnv = { ...ghEnv, GH_TOKEN: t.token };
  }
  const ctx: Ctx = {
    cfg,
    paths,
    log,
    gh: { gh: ghBin(), log, logPath: paths.logPath, env: ghEnv },
    counters: { started: 0, reviewed: 0, failed: 0, skipped: 0, synced: 0 },
    current: { key: "" },
  };
  return fn(ctx);
}

async function withSignals(
  onSignal: () => void,
  fn: () => Promise<number>,
): Promise<number> {
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await fn();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// Reviews themselves run detached, so lock holders are always short-lived:
// the lock only stops overlapping poll/sync cycles from double-starting work.
async function runLocked(ctx: Ctx, fn: () => Promise<number>): Promise<number> {
  const release = acquireLock(ctx.paths.lockDir, ctx.log);
  if (!release) return 0; // another live run holds the lock (bash exits 0 here)
  const onSignal = () => {
    // A poll started with `p` outlives the keystroke, so a suspended child may
    // hold the terminal by now — that Ctrl+C is the child's, not our cancel.
    if (childOwnsTerminal()) return;
    ctx.log("canceled (interrupted)");
    release();
    process.exit(130);
  };
  try {
    return await withSignals(onSignal, async () => {
      reconcileOrphans(ctx.paths.statePath, ctx.log);
      return fn();
    });
  } finally {
    release();
  }
}

// counters are per-cycle; the interactive menu can run several poll/sync
// cycles in one process, so each starts from zero
function resetCounters(ctx: Ctx): void {
  ctx.counters = { started: 0, reviewed: 0, failed: 0, skipped: 0, synced: 0 };
}

// review/retry don't take the poll lock: they only mark state and spawn a
// runner, and double-starts are stopped by the live-pid checks. Holding the
// lock would make them silently no-op whenever a poll cycle is in flight.
async function runUnlocked(
  ctx: Ctx,
  fn: () => Promise<number>,
): Promise<number> {
  reconcileOrphans(ctx.paths.statePath, ctx.log);
  return fn();
}

// Normalize a PR argument, printing the usage/parse error itself; null = bail.
function keyArg(raw: string | undefined, usage: string): string | null {
  if (!raw) {
    console.error(usage);
    return null;
  }
  try {
    return normalizeKey(raw);
  } catch (e) {
    console.error((e as Error).message);
    return null;
  }
}

const startedMsg = (key: string, result: StartResult): number => {
  if (result === "started") {
    console.log(
      `${key}: review started in the background — you'll get a notification; follow with: docket watch`,
    );
  } else if (result === "already-running") {
    console.log(`${key}: a review is already running`);
  }
  return result === "spawn-failed" ? 1 : 0;
};

// Cycle bodies shared by the subcommands and the interactive menu.
const pollLocked = (ctx: Ctx, dry: boolean): Promise<number> =>
  runLocked(ctx, async () => {
    resetCounters(ctx);
    await pollCycle(ctx, dry);
    return 0;
  });

const syncLocked = (ctx: Ctx): Promise<number> =>
  runLocked(ctx, async () => {
    resetCounters(ctx);
    reconcile(ctx);
    ctx.log(`sync complete: ${ctx.counters.synced} updated`);
    return 0;
  });

const retryKey = (ctx: Ctx, key: string, note?: string): Promise<number> =>
  runUnlocked(ctx, async () => {
    const entry = loadState(ctx.paths.statePath)[key];
    if (!entry) {
      console.error(`unknown key: ${key}`);
      return 1;
    }
    const { repo } = splitKey(key);
    const result = await startReview(
      ctx,
      key,
      repo,
      entry.title ?? "",
      entry.url ?? "",
      note,
    );
    return startedMsg(key, result);
  });

const help: Command = async () => {
  console.log(USAGE);
  return 0;
};

const review: Command = (args) =>
  withCtx((ctx) =>
    runUnlocked(ctx, async () => {
      const key = keyArg(
        args[0],
        "usage: docket review ORG/REPO#NUM|URL [note]",
      );
      if (!key) return 1;
      const { repo, number } = splitKey(key);
      const info = prView<{ title?: string; url?: string }>(
        ctx.gh,
        repo,
        number,
        "title,url",
      );
      if (!info) {
        console.error(`cannot fetch ${key} from GitHub (does the PR exist?)`);
        return 1;
      }
      const result = await startReview(
        ctx,
        key,
        repo,
        info.title ?? "",
        info.url ?? "",
        args[1],
      );
      return startedMsg(key, result);
    }),
  );

const retry: Command = (args) =>
  withCtx(async (ctx) => {
    const key = keyArg(args[0], "usage: docket retry ORG/REPO#NUM [note]");
    if (!key) return 1;
    return retryKey(ctx, key, args[1]);
  });

// internal: the detached runner `startReview` spawns — one foreground review
const exec: Command = (args) =>
  withCtx((ctx) => {
    const key = args[0];
    if (!key) {
      console.error("usage: docket exec ORG/REPO#NUM");
      return Promise.resolve(1);
    }
    const onSignal = () => {
      ctx.current.child?.kill("SIGTERM");
      if (ctx.current.key) {
        setStatus(
          ctx.paths.statePath,
          ctx.current.key,
          "canceled",
          "run interrupted",
        );
        ctx.log(
          `CANCELED ${ctx.current.key} (interrupted) — retry with: docket retry ${ctx.current.key}`,
        );
      }
      process.exit(130);
    };
    return withSignals(onSignal, () => execReview(ctx, key));
  });

const sync: Command = () => withCtx(syncLocked);

const poll: Command = (args) =>
  withCtx((ctx) => pollLocked(ctx, args.includes("--dry-run")));

const dismiss: Command = (args) =>
  withCtx(async (ctx) => {
    const key = keyArg(args[0], "usage: docket dismiss ORG/REPO#NUM");
    if (!key) return 1;
    if (!loadState(ctx.paths.statePath)[key]) {
      console.error(`unknown key: ${key}`);
      return 1;
    }
    console.log(dismissKey(ctx, key));
    return 0;
  });

const doctor: Command = () => doctorCommand();
const prompt: Command = () => promptCommand();
const status: Command = () => withCtx((ctx) => statusCommand(ctx));
const log: Command = (args) => {
  const n = Number(args[0] ?? 20);
  return withCtx((ctx) =>
    logCommand(ctx, Number.isFinite(n) && n >= 1 ? n : 20),
  );
};
const watch: Command = (args) =>
  withCtx(async (ctx) => {
    if (args[0] === undefined) return watchCommand(ctx);
    const key = keyArg(args[0], "usage: docket watch [ORG/REPO#NUM|URL]");
    if (!key) return 1;
    return watchCommand(ctx, key);
  });
const on: Command = () => withCtx((ctx) => onCommand(ctx));
const off: Command = async () => offCommand();

const commands: Record<string, Command> = {
  help,
  review,
  retry,
  exec,
  sync,
  poll,
  dismiss,
  doctor,
  prompt,
  status,
  log,
  watch,
  on,
  off,
};

async function main(): Promise<number> {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === undefined)
    return withCtx((ctx) =>
      runTui(ctx, {
        retry: (key) => retryKey(ctx, key),
        poll: () => pollLocked(ctx, false),
        sync: () => syncLocked(ctx),
        dismiss: (key) => dismissKey(ctx, key),
        kill: (key) => killEntry(ctx, key).message,
      }),
    );
  if (cmd === "-h" || cmd === "--help") return help([]);
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown subcommand: ${cmd} (try: docket help)`);
    return 1;
  }
  return fn(rest);
}

process.exit(await main());
