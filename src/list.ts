import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { claudeBin, type Config } from "./config";
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
): { action: "resume" | "dismiss" | "retry"; index: number } | "quit" | null {
  const t = input.trim();
  if (t === "" || t === "q") return "quit";
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

function lockPid(ctx: Ctx): number | null {
  try {
    const pid = Number(readFileSync(join(ctx.paths.lockDir, "pid"), "utf8").trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function interactiveList(
  ctx: Ctx,
  retry: (key: string) => Promise<number>,
): Promise<number> {
  const state = loadState(ctx.paths.statePath);

  const pid = lockPid(ctx);
  if (pid !== null) {
    const current = Object.entries(state)
      .filter(([, e]) => e.status === "reviewing")
      .map(([k]) => k);
    console.log(
      current.length
        ? `⏳ poll running (pid ${pid}) — reviewing: ${current.join(", ")}`
        : `⏳ poll running (pid ${pid})`,
    );
  }

  const { keys, lines } = renderList(state);
  if (keys.length === 0) {
    console.log("No pending reviews.");
    return 0;
  }
  for (const line of lines) console.log(line);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("resume #  (d# dismiss, r# retry, q quit): ");
  rl.close();

  const choice = parseChoice(answer, keys.length);
  if (choice === "quit") return 0;
  if (choice === null) {
    console.error("bad choice");
    return 1;
  }
  const key = keys[choice.index]!;

  switch (choice.action) {
    case "dismiss":
      dismissKey(ctx, key);
      return 0;
    case "retry":
      return retry(key);
    case "resume": {
      const entry = loadState(ctx.paths.statePath)[key]!;
      const r = buildResume(entry, ctx.cfg);
      if ("error" in r) {
        console.error(`${key} ${r.error}`);
        return 1;
      }
      const p = Bun.spawn(r.argv, {
        cwd: r.cwd,
        env: { ...process.env, ...r.env } as Record<string, string>,
        stdio: ["inherit", "inherit", "inherit"],
      });
      return await p.exited;
    }
  }
}
