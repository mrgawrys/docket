import { existsSync, readFileSync, watchFile } from "node:fs";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function toolLine(name: string, input: Record<string, unknown> = {}): string {
  const arg =
    input.command ??
    input.file_path ??
    input.pattern ??
    input.description ??
    input.prompt ??
    "";
  const s =
    typeof arg === "string"
      ? arg.replace(/\s+/g, " ").trim()
      : JSON.stringify(arg);
  const short = s.length > 100 ? s.slice(0, 100) + "…" : s;
  return short ? `→ ${name}: ${short}` : `→ ${name}`;
}

export interface RunEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
}

// One line of a claude stream-json run log; null for non-JSON.
export function parseRunEvent(line: string): RunEvent | null {
  try {
    return JSON.parse(line) as RunEvent;
  } catch {
    return null;
  }
}

export function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .slice(-n);
}

// One stream-json line -> human-readable line(s); null for noise.
export function renderRunEvent(line: string): string | null {
  const ev = parseRunEvent(line);
  if (ev === null) return null;
  if (ev.type === "system" && ev.subtype === "init") {
    return `session started (${ev.session_id ?? "?"})`;
  }
  if (ev.type === "assistant") {
    const parts = (ev.message?.content ?? [])
      .map((b) =>
        b.type === "text"
          ? (b.text ?? "").trim()
          : b.type === "tool_use"
            ? toolLine(b.name ?? "?", b.input)
            : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  if (ev.type === "result") {
    return ev.subtype === "success"
      ? "✔ review finished"
      : `✖ review failed (${ev.subtype ?? "error"})`;
  }
  return null;
}

// Follow a growing file until Ctrl+C, reporting new content as it appears.
// `truncated` marks a shrink since the last chunk (a retry rewrote the file).
// fromEnd starts at the current end instead of replaying existing content.
export function followFile(
  path: string,
  onChunk: (text: string, truncated: boolean) => void,
  opts: { fromEnd?: boolean } = {},
): Promise<number> {
  let seen =
    opts.fromEnd && existsSync(path) ? readFileSync(path, "utf8").length : 0;
  let truncated = false;
  const read = () => {
    if (!existsSync(path)) return; // watchFile fires even for a missing file
    const content = readFileSync(path, "utf8");
    if (content.length < seen) {
      seen = 0;
      truncated = true;
    }
    if (content.length > seen) {
      onChunk(content.slice(seen), truncated);
      truncated = false;
      seen = content.length;
    }
  };
  read();
  watchFile(path, { interval: 500 }, read);
  return new Promise(() => {}); // runs until Ctrl+C
}

// Print the rendered run log so far, then follow it until Ctrl+C.
export function followRunLog(path: string): Promise<number> {
  let carry = ""; // partial line the runner hasn't finished writing yet
  if (!existsSync(path)) console.log(`waiting for review output (${path}) …`);
  return followFile(path, (text, truncated) => {
    if (truncated) carry = "";
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const l of lines) {
      const rendered = renderRunEvent(l);
      if (rendered !== null) console.log(rendered);
    }
  });
}
