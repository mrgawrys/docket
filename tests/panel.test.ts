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
      width: 60,
    }),
  ).toEqual([{ text: "choice questions render as Text" }]);
});

test("without a headline it falls back to the prose, dimmed and marked short", () => {
  const lines = panelLines({
    assessment: prose("one\ntwo\nthree\nfour\nfive\nsix"),
    width: 60,
    height: 3,
  });
  expect(lines.map((l) => l.text)).toEqual(["one", "two", "three …"]);
  expect(lines.every((l) => l.dim)).toBe(true);
});

test("markdown blank lines do not eat rows the fallback needs for content", () => {
  const lines = panelLines({
    assessment: prose(
      "# Code review\n\nTwo findings.\n\nBoth in the migration.",
    ),
    width: 60,
    height: 3,
  });
  expect(lines.map((l) => l.text)).toEqual([
    "# Code review",
    "Two findings.",
    "Both in the migration.",
  ]);
});

test("prose that fits is not marked as truncated", () => {
  const lines = panelLines({
    assessment: prose("all of it"),
    width: 60,
    height: 4,
  });
  expect(lines.map((l) => l.text)).toEqual(["all of it"]);
});

test("the panel never outgrows its height, whatever it is filled with", () => {
  for (const height of [1, 2, 4]) {
    const lines = panelLines({
      assessment: prose("x ".repeat(400)),
      width: 10,
      height,
    });
    expect(lines.length).toBe(height);
  }
});

test("the denials teaser leads the panel, and never at the headline's expense", () => {
  const denials = [
    {
      tool: "Bash",
      suggestion: "Bash(rg:*)",
      count: 24,
      examples: [],
      writeShaped: false,
      alreadyAllowed: false,
    },
  ];
  const lines = panelLines({
    summary: { headline: "the verdict", issues: 1 },
    assessment: none,
    denials,
    cfg: { orgs: [], repos: {} },
    width: 60,
    height: 10,
  }).map((l) => l.text);
  expect(lines[0]).toContain("24 calls were blocked");
  expect(lines).toContain("D works through them");
  expect(lines.at(-1)).toBe("the verdict");
});

test("a panel with no room for both keeps the headline over the teaser", () => {
  const lines = panelLines({
    summary: { headline: "the verdict", issues: 1 },
    assessment: none,
    denials: [
      {
        tool: "Bash",
        suggestion: "Bash(rg:*)",
        count: 1,
        examples: [],
        writeShaped: false,
        alreadyAllowed: false,
      },
    ],
    cfg: { orgs: [], repos: {} },
    width: 60,
    height: 3,
  }).map((l) => l.text);
  expect(lines).toEqual(["the verdict"]);
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
