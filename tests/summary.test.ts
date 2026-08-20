import { expect, test } from "bun:test";
import {
  issueChip,
  receiveChip,
  riskChip,
  splitSummary,
  threadChip,
} from "../src/summary";

const fenced = (json: string) => "```json\n" + json + "\n```";

test("takes the trailing block as the summary and keeps it out of the prose", () => {
  const { summary, prose } = splitSummary(
    "# Code review — PR #6487\n\nOne issue cleared the bar.\n\n" +
      fenced(
        '{"headline": "choice questions render as Text", "issues": 1, "risk": "low"}',
      ),
  );
  expect(summary).toEqual({
    headline: "choice questions render as Text",
    issues: 1,
    risk: "low",
  });
  expect(prose).toBe("# Code review — PR #6487\n\nOne issue cleared the bar.");
});

test("a json sample inside the review is not mistaken for the summary", () => {
  // The block a reviewer quotes as evidence sits mid-document, and the prose
  // continues after it — taking it would put a code sample in the queue.
  const review =
    "The type it switches on:\n\n" +
    fenced('{"type": "single_choice", "issues": 99}') +
    "\n\nThat premise is what the render function breaks.";
  expect(splitSummary(review)).toEqual({ prose: review });
});

test("evidence quoted above the summary does not swallow it", () => {
  // The shape of a real review: a snippet in the prose, the answer at the end.
  const { summary, prose } = splitSummary(
    "The type it switches on:\n\n" +
      fenced('{"type": "single_choice"}') +
      "\n\nThat premise is what breaks.\n\n" +
      fenced('{"headline": "choice questions render as Text", "issues": 2}'),
  );
  expect(summary).toEqual({
    headline: "choice questions render as Text",
    issues: 2,
  });
  expect(prose).toBe(
    "The type it switches on:\n\n" +
      fenced('{"type": "single_choice"}') +
      "\n\nThat premise is what breaks.",
  );
});

test("a fenced code sample above the summary does not swallow it", () => {
  // Not just json: the closing fence of any block opens one for the regex.
  const { summary } = splitSummary(
    "```ts\nconst x = 1;\n```\n\n" + fenced('{"risk": "high"}'),
  );
  expect(summary).toEqual({ risk: "high" });
});

test("a trailing block carrying none of our fields stays in the prose", () => {
  // A review may legitimately end by suggesting a config; it is not an answer.
  const review = "Add this to tsconfig:\n\n" + fenced('{"strict": true}');
  expect(splitSummary(review)).toEqual({ prose: review });
});

test("fields a custom prompt could not answer are absent, not zero", () => {
  // "explain this PR" never counts issues — reporting 0 would read as "clean".
  const { summary } = splitSummary(
    "It adds survey opening times.\n\n" +
      fenced('{"headline": "adds pulse survey opening times"}'),
  );
  expect(summary).toEqual({ headline: "adds pulse survey opening times" });
});

test("values outside the contract are dropped, not rendered", () => {
  const { summary } = splitSummary(
    "x\n\n" +
      fenced(
        '{"headline": 42, "issues": -3, "risk": "critical", "extra": "ignored"}',
      ),
  );
  expect(summary).toBeUndefined();
});

test("risk is matched case- and space-insensitively", () => {
  const { summary } = splitSummary("x\n\n" + fenced('{"risk": "  MEDIUM "}'));
  expect(summary).toEqual({ risk: "medium" });
});

test("a headline is collapsed to one line and bounded", () => {
  const { summary } = splitSummary(
    "x\n\n" + fenced(`{"headline": "  a\\n  b ${"z".repeat(400)}"}`),
  );
  const headline = summary?.headline ?? "";
  expect(headline.length).toBe(200);
  expect(headline.startsWith("a b zzz")).toBe(true);
});

test("malformed json leaves the message untouched", () => {
  const review = "verdict\n\n" + fenced('{"headline": "unterminated');
  expect(splitSummary(review)).toEqual({ prose: review });
});

test("a message with no block at all is returned as-is", () => {
  expect(splitSummary("plain verdict")).toEqual({ prose: "plain verdict" });
});

test("no issue count means no chip — silence is not a clean bill of health", () => {
  expect(issueChip(undefined)).toBeUndefined();
  expect(issueChip({ headline: "x", risk: "low" })).toBeUndefined();
  expect(issueChip({ issues: 0 })).toEqual({ text: "✓ clean", color: "green" });
});

test("issues are pluralised, and high risk reddens the count", () => {
  expect(issueChip({ issues: 1 })).toEqual({
    text: "⚠ 1 issue",
    color: "yellow",
  });
  expect(issueChip({ issues: 3 })).toEqual({
    text: "⚠ 3 issues",
    color: "yellow",
  });
  expect(issueChip({ issues: 3, risk: "high" })).toEqual({
    text: "⚠ 3 issues",
    color: "red",
  });
});

test("risk renders its own chip, and nothing when unassessed", () => {
  expect(riskChip({ risk: "medium" })).toEqual({
    text: "MED",
    color: "yellow",
  });
  expect(riskChip({ risk: "high" })).toEqual({ text: "HIGH", color: "red" });
  expect(riskChip({ headline: "x" })).toBeUndefined();
});

test("threadChip: unresolved count, all-resolved mark, nothing before a sync", () => {
  expect(threadChip(undefined)).toBeUndefined();
  expect(threadChip({ unresolved: 0, total: 0 })).toBeUndefined();
  expect(threadChip({ unresolved: 0, total: 2 })).toEqual({
    text: "✓ resolved",
    color: "green",
  });
  expect(threadChip({ unresolved: 3, total: 4 })).toEqual({
    text: "3 unresolved",
    color: "yellow",
  });
});

test("splitSummary: a receive run's addressed/deferred counts are kept", () => {
  const r = splitSummary(
    'done\n```json\n{"headline":"two nits taken","addressed":2,"deferred":1}\n```',
  );
  expect(r.summary).toEqual({ headline: "two nits taken", addressed: 2, deferred: 1 });
  expect(r.prose).toBe("done");
});

// The chip says what the run did, and stays silent when it never got to count.
test("receiveChip: counts, or nothing when neither count was reported", () => {
  expect(receiveChip({ addressed: 3, deferred: 0 })).toEqual({
    text: "3 addressed",
    color: "green",
  });
  expect(receiveChip({ addressed: 3, deferred: 1 })).toEqual({
    text: "3 addressed · 1 deferred",
    color: "yellow",
  });
  expect(receiveChip({ headline: "feedback unreadable" })).toBeUndefined();
  expect(receiveChip(undefined)).toBeUndefined();
});
