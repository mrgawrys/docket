import { existsSync, readFileSync, watchFile } from "node:fs";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function toolLine(name: string, input: Record<string, unknown> = {}): string {
  const arg =
    input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.prompt ?? "";
  const s = typeof arg === "string" ? arg.replace(/\s+/g, " ").trim() : JSON.stringify(arg);
  const short = s.length > 100 ? s.slice(0, 100) + "…" : s;
  return short ? `→ ${name}: ${short}` : `→ ${name}`;
}

// One stream-json line -> human-readable line(s); null for noise.
export function renderRunEvent(line: string): string | null {
  let ev: {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: ContentBlock[] };
  };
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === "system" && ev.subtype === "init") {
    return `session started (${ev.session_id ?? "?"})`;
  }
  if (ev.type === "assistant") {
    const parts = (ev.message?.content ?? [])
      .map((b) =>
        b.type === "text" ? (b.text ?? "").trim()
        : b.type === "tool_use" ? toolLine(b.name ?? "?", b.input)
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

// Print the rendered log so far, then follow it until Ctrl+C.
export function followRunLog(path: string): Promise<number> {
  let seen = 0;
  let carry = ""; // partial line the runner hasn't finished writing yet
  const emit = (text: string) => {
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const l of lines) {
      const rendered = renderRunEvent(l);
      if (rendered !== null) console.log(rendered);
    }
  };
  const read = () => {
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf8");
    if (content.length < seen) {
      seen = 0; // truncated: a retry restarted the run log
      carry = "";
    }
    if (content.length > seen) {
      emit(content.slice(seen));
      seen = content.length;
    }
  };
  if (!existsSync(path)) console.log(`waiting for review output (${path}) …`);
  read();
  watchFile(path, { interval: 500 }, read);
  return new Promise(() => {}); // runs until Ctrl+C
}
