import { expect, test } from "bun:test";
import type { Assessment } from "../src/assessment";
import { panelLines, wrapText } from "../src/panel";

const none: Assessment = { kind: "none", reason: "no run log" };
const prose = (text: string): Assessment => ({ kind: "text", text });

test("the recorded headline is what the panel shows, in full weight", () => {
  expect(
    panelLines({
      summary: { headline: "choice questions render as Text", issues: 1 },
      assessment: prose("a whole review nobody asked to read here"),
      notes: [],
      width: 60,
    }),
  ).toEqual([{ text: "choice questions render as Text" }]);
});

test("without a headline it falls back to the prose, dimmed and marked short", () => {
  const lines = panelLines({
    assessment: prose("one\ntwo\nthree\nfour\nfive\nsix"),
    notes: [],
    width: 60,
    height: 3,
  });
  expect(lines.map((l) => l.text)).toEqual(["one", "two", "three …"]);
  expect(lines.every((l) => l.dim)).toBe(true);
});

test("prose that fits is not marked as truncated", () => {
  const lines = panelLines({
    assessment: prose("all of it"),
    notes: [],
    width: 60,
    height: 4,
  });
  expect(lines.map((l) => l.text)).toEqual(["all of it"]);
});

test("a verb the machine cannot run leads, and costs the panel a row", () => {
  // Losing the reason a key is dead is worse than losing a line of verdict.
  const lines = panelLines({
    summary: { headline: "aaa bbb ccc ddd" },
    assessment: none,
    notes: ["shell/diff: worktree is gone"],
    width: 5,
    height: 2,
  });
  expect(lines).toEqual([
    { text: "shell/diff: worktree is gone", color: "yellow" },
    { text: "aaa" },
  ]);
});

test("the panel never outgrows its height, whatever it is filled with", () => {
  for (const height of [1, 2, 4]) {
    const lines = panelLines({
      assessment: prose("x ".repeat(400)),
      notes: ["a", "b", "c", "d", "e"],
      width: 10,
      height,
    });
    expect(lines.length).toBe(height);
  }
});

test("an entry with no review at all says so rather than showing blank", () => {
  expect(panelLines({ assessment: none, notes: [], width: 60 })).toEqual([
    { text: "no run log", dim: true },
  ]);
});

test("wrapText terminates on a pane too narrow to hold a column", () => {
  // width 0 used to slice nothing off the word each pass: the render thread
  // spun forever and the TUI stopped answering q or Ctrl+C
  for (const width of [0, -1]) {
    expect(wrapText("hello world", width)).toEqual([
      "h",
      "e",
      "l",
      "l",
      "o",
      "w",
      "o",
      "r",
      "l",
      "d",
    ]);
  }
});

test("wrapText keeps the indentation that gives markdown its structure", () => {
  expect(wrapText("- top\n  - nested\n    code line", 40)).toEqual([
    "- top",
    "  - nested",
    "    code line",
  ]);
});

test("wrapText wraps inside the indent rather than past the pane", () => {
  const lines = wrapText("    four indented words here", 12);
  expect(lines).toEqual(["    four", "    indented", "    words", "    here"]);
  expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(12);
});
