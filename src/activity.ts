// The session log the TUI shows in its log pane: every line the logger
// writes in this process, and every line a poll or sync child prints. It
// lives outside React because a suspend remounts the App — the pane must
// come back with its lines, and a job must keep reporting across the gap.

export interface Job {
  name: "poll" | "sync";
  verb: string; // "polling" / "syncing" — the footer's word while it runs
  running: boolean;
  code?: number;
}

export interface Feed {
  readonly lines: readonly string[];
  job?: Job;
  push(line: string): void;
  // Fires on every change — a new line or a job starting or ending.
  subscribe(fn: () => void): () => void;
  setJob(job: Job | undefined): void;
}

// Enough to scroll back through a long poll, bounded so a day-long session
// does not grow without limit.
export const FEED_CAP = 1000;

export function makeFeed(cap = FEED_CAP): Feed {
  const lines: string[] = [];
  const subs = new Set<() => void>();
  const notify = () => {
    for (const fn of subs) fn();
  };
  const feed: Feed = {
    lines,
    push(line) {
      lines.push(line);
      if (lines.length > cap) lines.splice(0, lines.length - cap);
      notify();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    setJob(job) {
      feed.job = job;
      notify();
    },
  };
  return feed;
}

// Complete lines out of a stream chunk; the unterminated tail waits for more.
export function splitLines(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.replace(/\r$/, "")), rest };
}

// The pane's window onto the lines: `scroll` counts up from the bottom, so 0
// follows the newest line as they arrive.
export function windowLines(
  lines: readonly string[],
  height: number,
  scroll: number,
): { lines: string[]; maxScroll: number } {
  const maxScroll = Math.max(0, lines.length - height);
  const s = Math.min(maxScroll, Math.max(0, scroll));
  const end = lines.length - s;
  return { lines: lines.slice(Math.max(0, end - height), end), maxScroll };
}

// Run a child with both its streams piped, a line at a time into `onLine`.
// stdin is closed: the child must not read the terminal from under Ink.
export async function runLogged(
  argv: string[],
  onLine: (line: string) => void,
  env: Record<string, string> = {},
): Promise<number> {
  const p = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      const r = splitLines(rest + dec.decode(chunk, { stream: true }));
      rest = r.rest;
      for (const line of r.lines) onLine(line);
    }
    if (rest.trim()) onLine(rest);
  };
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  return await p.exited;
}
