import { expect, test } from "bun:test";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAssessment } from "../src/assessment";

let n = 0;
const logPath = (lines: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "assessment-"));
  const p = join(dir, `run-${n++}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
};

const assistant = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "looking at the diff" }] },
});
const result = (text: string) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "s1",
  });

test("reads the assessment from the final result event", () => {
  const p = logPath([assistant, result("# Code review\n\nOne issue.")]);
  expect(readAssessment(p)).toEqual({
    kind: "text",
    text: "# Code review\n\nOne issue.",
  });
});

test("the triage block is cut off the prose the panel falls back to", () => {
  const p = logPath([
    result(
      '# Code review\n\nOne issue.\n\n```json\n{"headline": "x", "issues": 1}\n```',
    ),
  ]);
  expect(readAssessment(p)).toEqual({
    kind: "text",
    text: "# Code review\n\nOne issue.",
  });
});

test("a missing run log and a log with no result each explain themselves", () => {
  const missing = readAssessment(join(tmpdir(), "definitely-not-here.jsonl"));
  expect(missing.kind).toBe("none");
  expect((missing as { reason: string }).reason).toContain("not been reviewed");

  const running = readAssessment(logPath([assistant, assistant]));
  expect(running.kind).toBe("none");
  expect((running as { reason: string }).reason).toContain("still running");
});

test("finds a result event that sits beyond the tail window", () => {
  // 200 KB of noise ahead of it: a whole-file read is the only way to see it
  const noise = Array.from({ length: 400 }, () =>
    JSON.stringify({ type: "assistant", pad: "x".repeat(500) }),
  );
  const p = logPath([...noise, result("late verdict"), ...noise]);
  expect(statSync(p).size).toBeGreaterThan(200_000);
  expect(readAssessment(p)).toEqual({ kind: "text", text: "late verdict" });
});

test("the last result wins when a retry appended a second one", () => {
  const p = logPath([result("first run"), assistant, result("second run")]);
  expect(readAssessment(p)).toEqual({ kind: "text", text: "second run" });
});

test("memoizes on (path, mtime, size): identical stats skip the re-read", () => {
  const p = logPath([result("verdict one")]);
  const pinned = new Date(1_700_000_000_000);
  utimesSync(p, pinned, pinned);
  expect(readAssessment(p)).toEqual({ kind: "text", text: "verdict one" });

  const size = statSync(p).size;
  writeFileSync(p, `${result("verdict two")}\n`); // same length by construction
  utimesSync(p, pinned, pinned);
  expect(statSync(p).size).toBe(size);

  expect(readAssessment(p)).toEqual({ kind: "text", text: "verdict one" });
});

test("a rewritten log is re-read once its mtime moves", () => {
  const p = logPath([result("before")]);
  expect(readAssessment(p)).toEqual({ kind: "text", text: "before" });
  writeFileSync(p, `${result("after")}\n`);
  utimesSync(p, new Date(), new Date(Date.now() + 1000));
  expect(readAssessment(p)).toEqual({ kind: "text", text: "after" });
});
