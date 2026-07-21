import * as readline from "node:readline/promises";
import { claudeBin, type Config } from "./config";
import { pidAlive } from "./proc";
import { removeWorktree, type Ctx } from "./reviewer";
import {
  loadState, pendingEntries, timestamp, updateEntry, type Entry, type State,
} from "./state";

export function renderList(s: State): { keys: string[]; lines: string[] } {
  const pending = pendingEntries(s);
  const keys = pending.map(([k]) => k);
  const lines = pending.map(([key, e], i) => {
    const flags = (e.flags ?? []).map((f) => ` +${f}`).join("");
    const n = String(i + 1).padStart(2);
    return `${n}  ${key.padEnd(32)} [${e.status}${flags}]\t${e.title ?? ""}\t${e.updated_at}`;
  });
  return { keys, lines };
}

export function parseChoice(
  input: string,
  max: number,
):
  | { action: "resume" | "dismiss" | "retry"; index: number }
  | { action: "poll" | "sync" }
  | "quit"
  | null {
  const t = input.trim();
  if (t === "" || t === "q") return "quit";
  if (t === "p") return { action: "poll" };
  if (t === "s") return { action: "sync" };
  const action = t.startsWith("d") ? "dismiss" : t.startsWith("r") ? "retry" : "resume";
  const num = action === "resume" ? t : t.slice(1);
  if (!/^\d+$/.test(num)) return null;
  const n = Number(num);
  if (n < 1 || n > max) return null;
  return { action, index: n - 1 };
}

export function buildResume(
  entry: Entry,
  cfg: Config,
): { argv: string[]; cwd: string; env: Record<string, string> } | { error: string } {
  if (entry.status === "reviewing") {
    return { error: "still being reviewed — wait for the notification, then rerun reviews" };
  }
  if (!entry.session_id || !entry.local_path) {
    return { error: `no session (${entry.status}) — use r# to (re)run the review` };
  }
  const env: Record<string, string> = {};
  if (cfg.claude_config_dir) env.CLAUDE_CONFIG_DIR = cfg.claude_config_dir;
  return {
    argv: [claudeBin(cfg), "--resume", entry.session_id],
    cwd: entry.local_path,
    env,
  };
}

export function dismissKey(ctx: Ctx, key: string): void {
  updateEntry(ctx.paths.statePath, key, (e) => ({
    ...(e ?? { updated_at: "" }),
    status: "done",
    updated_at: timestamp(),
  }));
  removeWorktree(ctx, key, "DISMISS");
  console.log(`dismissed ${key}`);
}

export function liveRunners(state: State): string[] {
  return Object.entries(state)
    .filter(([, e]) => e.status === "reviewing" && e.pid !== undefined && pidAlive(e.pid))
    .map(([k]) => k);
}

export interface ListActions {
  retry(key: string): Promise<number>;
  poll(): Promise<number>;
  sync(): Promise<number>;
}

// Loops until resume or quit: poll/sync/dismiss/retry re-render the list, so
// the menu doubles as a live dashboard. Resume exits because it hands the
// terminal to a Claude session.
export async function interactiveList(
  ctx: Ctx,
  actions: ListActions,
  ask?: (prompt: string) => Promise<string>,
): Promise<number> {
  // one readline interface for the whole session — a per-question interface
  // would drop buffered input and hang forever on EOF (stdin closed = quit)
  let rl: readline.Interface | undefined;
  if (!ask) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const closed = new Promise<string>((res) => rl!.once("close", () => res("q")));
    ask = (prompt) => Promise.race([rl!.question(prompt), closed]);
  }
  try {
    return await listLoop(ctx, actions, ask, () => rl?.close());
  } finally {
    rl?.close();
  }
}

async function listLoop(
  ctx: Ctx,
  actions: ListActions,
  ask: (prompt: string) => Promise<string>,
  releaseStdin: () => void,
): Promise<number> {
  for (;;) {
    const state = loadState(ctx.paths.statePath);

    const current = liveRunners(state);
    if (current.length) console.log(`⏳ reviewing now: ${current.join(", ")}`);

    const { keys, lines } = renderList(state);
    if (keys.length === 0) console.log("No pending reviews.");
    for (const line of lines) console.log(line);

    const answer = await ask("resume #  (d# dismiss, r# retry, p poll, s sync, q quit): ");

    const choice = parseChoice(answer, keys.length);
    if (choice === "quit") return 0;
    if (choice === null) {
      console.error("bad choice");
      continue;
    }

    switch (choice.action) {
      case "poll":
        await actions.poll();
        continue;
      case "sync":
        await actions.sync();
        continue;
      case "dismiss":
        dismissKey(ctx, keys[choice.index]!);
        continue;
      case "retry":
        await actions.retry(keys[choice.index]!);
        continue;
      case "resume": {
        const key = keys[choice.index]!;
        const entry = loadState(ctx.paths.statePath)[key]!;
        const r = buildResume(entry, ctx.cfg);
        if ("error" in r) {
          console.error(`${key} ${r.error}`);
          continue;
        }
        releaseStdin(); // the resumed claude session owns the terminal now
        const p = Bun.spawn(r.argv, {
          cwd: r.cwd,
          env: { ...process.env, ...r.env } as Record<string, string>,
          stdio: ["inherit", "inherit", "inherit"],
        });
        return await p.exited;
      }
    }
  }
}
