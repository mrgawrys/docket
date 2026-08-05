import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { parseRunEvent } from "./runlog";
import { splitSummary } from "./summary";

// Claude's review of a PR: the prose it ended the run with, or why there is none.
export type Assessment =
  | { kind: "text"; text: string }
  | { kind: "none"; reason: string };

// Run logs reach 1.5 MB; the result event is ~8 KB. Reading the whole file on
// every cursor move would be wasteful, so only the tail is read.
const WINDOW = 64 * 1024;

interface Cached {
  mtimeMs: number;
  size: number;
  value: Assessment;
}
const cache = new Map<string, Cached>();

function readTail(path: string, from: number, length: number): string {
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buf, 0, length, from);
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

// The assessment is the `result` field of the last result event. ReportFindings
// is not a usable source: a real run called it with an empty array while the
// review itself went into the prose.
function findResult(chunk: string): string | undefined {
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // a window that starts mid-line just fails to parse, which is the right answer
    const ev = parseRunEvent(lines[i] ?? "");
    if (ev?.type === "result" && ev.result?.trim()) return ev.result;
  }
  return undefined;
}

export function readAssessment(path: string): Assessment {
  if (!existsSync(path)) {
    return {
      kind: "none",
      reason: "no run log — this PR has not been reviewed",
    };
  }
  let text: string | undefined;
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
      return hit.value;
    if (st.size > 0) {
      const start = Math.max(0, st.size - WINDOW);
      text = findResult(readTail(path, start, st.size - start));
      // a long result line can straddle the window edge; pay for the whole file only then
      if (text === undefined && start > 0)
        text = findResult(readTail(path, 0, st.size));
    }
  } catch {
    return { kind: "none", reason: "run log could not be read" };
  }
  const value = ((): Assessment => {
    if (text === undefined)
      return {
        kind: "none",
        reason:
          "no result in the run log — the review is still running or it failed",
      };
    // The triage block is the queue's job; here it would just be raw JSON at
    // the end of the prose the panel falls back to.
    const prose = splitSummary(text).prose.trim();
    if (!prose)
      // A run whose whole final message was the block leaves the fallback
      // nothing to show, and a blank pane reads as a failed read.
      return {
        kind: "none",
        reason: "the review left only its triage summary",
      };
    return { kind: "text", text: prose };
  })();
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}
