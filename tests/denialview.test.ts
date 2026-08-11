import { expect, test } from "bun:test";
import type { Config } from "../src/config";
import type { DenialGroup } from "../src/denials";
import { denialChip, denialLines } from "../src/denialview";

const cfg: Config = { orgs: [], repos: {} };

const group = (over: Partial<DenialGroup> = {}): DenialGroup => ({
  tool: "Bash",
  suggestion: "Bash(rg:*)",
  count: 1,
  examples: [],
  writeShaped: false,
  alreadyAllowed: false,
  ...over,
});

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

test("the chip counts every denied call, not the groups they fall into", () => {
  const chip = denialChip([
    group({ count: 3 }),
    group({ suggestion: "WebFetch", count: 4 }),
  ]);
  expect(chip?.text).toBe("⊘ 7");
});

test("a review with no denials gets no chip", () => {
  expect(denialChip(undefined)).toBeUndefined();
  expect(denialChip([])).toBeUndefined();
});

test("each group leads with the allowlist line it would add and how often it bit", () => {
  const lines = denialLines({
    groups: [
      group({ suggestion: "Bash(rg:*)", count: 3 }),
      group({ suggestion: "WebFetch", tool: "WebFetch", count: 1 }),
    ],
    cfg,
    selected: 0,
    width: 80,
  });
  // order is the grouping's, not re-sorted by the view
  expect(texts(lines)).toEqual([
    "▸ Bash(rg:*) — 3 denied",
    "  WebFetch — 1 denied",
  ]);
});

test("the cursor marks the selected group and nothing else", () => {
  const lines = denialLines({
    groups: [group({ suggestion: "A" }), group({ suggestion: "B" })],
    cfg,
    selected: 1,
    width: 80,
  });
  expect(texts(lines)).toEqual(["  A — 1 denied", "▸ B — 1 denied"]);
});

test("a write-shaped group says it conflicts with the read-only stance", () => {
  const lines = denialLines({
    groups: [group({ suggestion: "Bash(git push:*)", writeShaped: true })],
    cfg,
    selected: 0,
    width: 80,
  });
  expect(texts(lines)).toEqual([
    "▸ Bash(git push:*) — 1 denied",
    "    conflicts with docket's read-only stance — add manually or hand to claude",
  ]);
});

test("a suggestion already in the config is labelled rather than offered again", () => {
  // the flag on the entry is stale on purpose: it was written before the rule
  // was added, and only a re-check against the live config can see that
  const lines = denialLines({
    groups: [group({ suggestion: "Bash(rg:*)", alreadyAllowed: false })],
    cfg: { ...cfg, extra_allowed_tools: ["Bash(rg:*)"] },
    selected: 0,
    width: 80,
  });
  expect(texts(lines)).toContain("    rule exists but didn't match");
});

test("a stale already-allowed flag does not label a group the config no longer covers", () => {
  const lines = denialLines({
    groups: [group({ suggestion: "Bash(rg:*)", alreadyAllowed: true })],
    cfg,
    selected: 0,
    width: 80,
  });
  expect(texts(lines)).toEqual(["▸ Bash(rg:*) — 1 denied"]);
});

test("example commands follow their group, dimmed", () => {
  const lines = denialLines({
    groups: [
      group({ examples: ["cd /wt && git fetch origin", "git fetch --all"] }),
    ],
    cfg,
    selected: 0,
    width: 80,
  });
  expect(texts(lines).slice(1)).toEqual([
    "    cd /wt && git fetch origin",
    "    git fetch --all",
  ]);
  expect(lines.slice(1).every((l) => l.dim)).toBe(true);
});

test("long lines wrap inside the view rather than past it", () => {
  const lines = denialLines({
    groups: [group({ examples: ["one two three four five six seven eight"] })],
    cfg,
    selected: 0,
    width: 24,
  });
  expect(lines.length).toBeGreaterThan(2);
  expect(Math.max(...lines.map((l) => l.text.length))).toBeLessThanOrEqual(24);
});

test("the view scrolls to the selected group instead of overflowing the frame", () => {
  const groups = ["A", "B", "C", "D", "E"].map((s) =>
    group({ suggestion: s, examples: [`${s} example`] }),
  );
  const lines = denialLines({ groups, cfg, selected: 4, width: 80, height: 4 });
  expect(lines.length).toBe(4);
  expect(texts(lines)).toContain("▸ E — 1 denied");
});

test("an entry whose denials vanished says so rather than rendering blank", () => {
  expect(denialLines({ groups: [], cfg, selected: 0, width: 80 })).toEqual([
    { text: "no denials recorded for this review", dim: true },
  ]);
});
