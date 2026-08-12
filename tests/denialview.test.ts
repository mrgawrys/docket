import { expect, test } from "bun:test";
import type { Config } from "../src/config";
import type { DenialGroup } from "../src/denials";
import {
  addable,
  addedNow,
  denialChip,
  denialTeaser,
  denialTitle,
  denialView,
  type DenialViewInput,
} from "../src/denialview";
import type { PanelLine } from "../src/panel";

const cfg: Config = { orgs: [], repos: {} };
const withRules = (...rules: string[]): Config => ({
  ...cfg,
  extra_allowed_tools: rules,
});

const group = (over: Partial<DenialGroup> = {}): DenialGroup => ({
  tool: "Bash",
  suggestion: "Bash(rg:*)",
  count: 1,
  examples: [],
  writeShaped: false,
  alreadyAllowed: false,
  ...over,
});

const texts = (lines: PanelLine[]) => lines.map((l) => l.text);
const view = (over: Partial<DenialViewInput> & { groups: DenialGroup[] }) =>
  denialView({ cfg, scroll: 0, width: 100, ...over });

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

test("the title counts both the rules and the calls behind them", () => {
  expect(denialTitle([group({ count: 24 }), group({ count: 1 })])).toBe(
    "2 rules, 25 blocked calls",
  );
  expect(denialTitle([group()])).toBe("1 rule, 1 blocked call");
});

test("addable takes the rules docket may add and names why it left the rest", () => {
  const safe = group({ suggestion: "Bash(rg:*)" });
  const frozen = group({ suggestion: "Bash(git push:*)", writeShaped: true });
  // the entry froze before npx joined the blocklist: the live classifier, not
  // the flag, is what keeps this one out
  const nowWriteShaped = group({ suggestion: "Bash(npx:*)" });
  // stale the other way: allowed when the run ended, gone from the config since
  const stale = group({ suggestion: "Bash(fd:*)", alreadyAllowed: true });
  const present = group({ suggestion: "Bash(ls:*)" });
  const a = addable(
    [safe, frozen, nowWriteShaped, stale, present],
    withRules("Bash(ls:*)"),
  );
  expect(a.add).toEqual([safe, stale]);
  expect(a.writeShaped).toEqual([frozen, nowWriteShaped]);
  expect(a.present).toEqual([present]);
});

test("a rule the config gained since the run reads as added, a rule it always had does not", () => {
  const added = group({ suggestion: "Bash(rg:*)", alreadyAllowed: false });
  const old = group({ suggestion: "Bash(ls:*)", alreadyAllowed: true });
  const missing = group({ suggestion: "Bash(fd:*)" });
  expect(
    addedNow([added, old, missing], withRules("Bash(rg:*)", "Bash(ls:*)")),
  ).toEqual([added]);
});

test("the teaser shows three groups at most and counts the rest", () => {
  const groups = [
    group({ suggestion: "Bash(rg:*)", count: 24 }),
    group({ suggestion: "Bash(gh pr comment:*)", count: 8 }),
    group({ suggestion: "Bash(git push:*)", count: 4 }),
    group({ suggestion: "Bash(sed:*)", count: 1 }),
    group({ suggestion: "Bash(gh pr diff:*)", count: 1 }),
    group({ suggestion: "Write", tool: "Write", count: 1 }),
  ];
  const lines = texts(denialTeaser({ groups, cfg, width: 100 }));
  expect(lines[0]).toBe(
    "39 calls were blocked — the review worked around them.",
  );
  expect(lines).toHaveLength(5);
  expect(lines[1]).toContain("Bash(rg:*)");
  expect(lines[1]).toContain("×24");
  // the write-shaped ones say so here too, where the row chip cannot
  expect(lines[2]).toContain("⚠ write-shaped");
  expect(lines[4]).toBe("+ 3 more · D works through them");
});

test("a teaser showing every group names the key without a remainder", () => {
  const lines = texts(
    denialTeaser({ groups: [group({ count: 1 })], cfg, width: 100 }),
  );
  expect(lines[0]).toBe("1 call was blocked — the review worked around it.");
  expect(lines[2]).toBe("D works through them");
});

test("a short teaser drops groups rather than the line naming the key", () => {
  const groups = ["A", "B", "C"].map((s) => group({ suggestion: s }));
  const lines = texts(denialTeaser({ groups, cfg, width: 100, height: 3 }));
  expect(lines).toHaveLength(3);
  expect(lines[2]).toBe("+ 2 more · D works through them");
  expect(denialTeaser({ groups, cfg, width: 100, height: 1 })).toEqual([]);
});

test("each group leads with the rule it would add and how often it bit", () => {
  const lines = view({
    groups: [
      group({ suggestion: "Bash(rg:*)", count: 3 }),
      group({ suggestion: "WebFetch", tool: "WebFetch", count: 1 }),
    ],
  }).lines;
  // order is the grouping's, not re-sorted by the view; the counts share a
  // column, so the padding follows the longest suggestion
  expect(texts(lines).slice(0, 2)).toEqual([
    "Bash(rg:*)  ×3",
    "WebFetch    ×1",
  ]);
});

test("example commands follow their group, dimmed", () => {
  const lines = view({
    groups: [
      group({ examples: ["cd /wt && git fetch origin", "git fetch --all"] }),
    ],
  }).lines;
  expect(texts(lines).slice(1, 3)).toEqual([
    "    cd /wt && git fetch origin",
    "    git fetch --all",
  ]);
  expect(lines.slice(1, 3).every((l) => l.dim)).toBe(true);
});

test("a write-shaped group is marked, whichever said so", () => {
  const frozen = view({
    groups: [group({ suggestion: "Bash(git push:*)", writeShaped: true })],
  }).lines;
  expect(texts(frozen)[0]).toContain("⚠ write-shaped");
  // the flag froze before npx joined the blocklist
  const live = view({ groups: [group({ suggestion: "Bash(npx:*)" })] }).lines;
  expect(texts(live)[0]).toContain("⚠ write-shaped");
});

test("a rule in the config is marked as already there, or as just added", () => {
  const old = view({
    groups: [group({ suggestion: "Bash(rg:*)", alreadyAllowed: true })],
    cfg: withRules("Bash(rg:*)"),
  }).lines;
  expect(texts(old)[0]).toContain("✓ already in your config");
  const fresh = view({
    groups: [group({ suggestion: "Bash(rg:*)", alreadyAllowed: false })],
    cfg: withRules("Bash(rg:*)"),
  }).lines;
  expect(texts(fresh)[0]).toContain("✓ added just now");
});

test("a stale already-allowed flag does not mark a group the config no longer covers", () => {
  const lines = view({
    groups: [group({ suggestion: "Bash(rg:*)", alreadyAllowed: true })],
  }).lines;
  expect(texts(lines)[0]).toBe("Bash(rg:*)  ×1");
});

test("the action block offers the batch add and says what it skips", () => {
  const lines = texts(
    view({
      groups: [
        group({ suggestion: "Bash(rg:*)" }),
        group({ suggestion: "Bash(git push:*)", writeShaped: true }),
        group({ suggestion: "Bash(sed:*)" }),
        group({ suggestion: "Bash(npx:*)" }),
        group({ suggestion: "Bash(rm:*)" }),
        group({ suggestion: "Bash(ls:*)", alreadyAllowed: true }),
      ],
      cfg: withRules("Bash(ls:*)"),
    }).lines,
  );
  expect(lines).toContain("⏎  hand all of this to claude");
  expect(lines).toContain(
    "a  add the 1 safe rule to your config (5 skipped: 4 write-shaped, 1 already there)",
  );
  expect(lines).toContain("esc back to the queue · j/k scroll");
});

test("with nothing safe to add the line says so rather than accepting the key", () => {
  const lines = texts(
    view({
      groups: [
        group({ suggestion: "Bash(git push:*)", writeShaped: true }),
        group({ suggestion: "Bash(npx:*)" }),
        group({ suggestion: "Bash(rm:*)" }),
        group({ suggestion: "Bash(ls:*)", alreadyAllowed: true }),
      ],
      cfg: withRules("Bash(ls:*)"),
    }).lines,
  );
  expect(lines).toContain(
    "a  nothing to add — 3 write-shaped, 1 already in your config",
  );
  expect(lines.some((l) => l.startsWith("a  add"))).toBe(false);
});

test("nothing skipped, nothing to explain", () => {
  const lines = texts(view({ groups: [group()] }).lines);
  expect(lines).toContain("a  add the 1 safe rule to your config");
});

test("once a rule has landed the block reports it and offers the re-run", () => {
  const lines = texts(
    view({
      groups: [
        group({ suggestion: "Bash(rg:*)" }),
        group({ suggestion: "Bash(git push:*)", writeShaped: true }),
      ],
      cfg: withRules("Bash(rg:*)"),
    }).lines,
  );
  expect(lines).toContain(
    "1 rule added — it applies to the next run of this review.",
  );
  expect(lines).toContain(
    "r  re-run the review now       ⏎  hand the rest to claude",
  );
  // the batch add is spent, and the line reporting it does not double as a
  // refusal
  expect(lines.some((l) => l.startsWith("a  "))).toBe(false);
});

test("long lines wrap inside the view rather than past it", () => {
  const lines = view({
    groups: [group({ examples: ["one two three four five six seven eight"] })],
    width: 24,
  }).lines;
  expect(Math.max(...lines.map((l) => l.text.length))).toBeLessThanOrEqual(24);
});

test("the view scrolls by line and keeps the action block in sight", () => {
  const groups = ["A", "B", "C", "D", "E"].map((s) =>
    group({ suggestion: s, examples: [`${s} example`] }),
  );
  const height = 8; // 10 body lines, 4 action lines: 4 rows of body fit
  const top = view({ groups, height });
  expect(top.maxScroll).toBe(6);
  expect(texts(top.lines).slice(0, 4)).toEqual([
    "A  ×1",
    "    A example",
    "B  ×1",
    "    B example",
  ]);
  expect(texts(top.lines)).toContain("esc back to the queue · j/k scroll");

  const down = view({ groups, height, scroll: 3 });
  expect(texts(down.lines)[0]).toBe("    B example");
  // and a scroll past the end lands on the end, not past it
  expect(texts(view({ groups, height, scroll: 99 }).lines)[0]).toBe("D  ×1");
});

test("an entry whose denials vanished says so rather than rendering blank", () => {
  expect(view({ groups: [] }).lines).toEqual([
    { text: "no denials recorded for this review", dim: true },
  ]);
});
