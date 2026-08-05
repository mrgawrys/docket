import { expect, test } from "bun:test";
import { wrapText } from "../src/tui/preview";

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
