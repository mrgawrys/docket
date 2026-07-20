#!/usr/bin/env bun

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

async function main(): Promise<number> {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === undefined || cmd === "-h" || cmd === "--help") {
    // bare `reviews` becomes the interactive list in Task 9
    return commands["help"]!([]);
  }
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown subcommand: ${cmd} (try: reviews help)`);
    return 1;
  }
  return fn(rest);
}

process.exit(await main());
