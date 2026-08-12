import type { Config } from "./config";
import { isAllowed, type DenialGroup } from "./denials";
import { wrapText, type PanelLine } from "./panel";
import type { Chip } from "./summary";

// How a run's denials read in the queue and in the denials view. Everything
// here works off `Entry.denials` and the live config — nothing re-reads a log.

// One token in an already-crowded row: the review's denied calls, summed across
// its groups. The view behind `D` is where the detail lives.
export function denialChip(denials?: DenialGroup[]): Chip | undefined {
  if (!denials?.length) return undefined;
  const total = denials.reduce((n, g) => n + g.count, 0);
  return { text: `⊘ ${total}`, color: "yellow" };
}

export interface DenialViewInput {
  groups: DenialGroup[];
  // Re-checked against here rather than trusting `alreadyAllowed`: the flag was
  // frozen when the run finished, and an apply since then has made it a lie.
  cfg: Config;
  // Suggestions `a` wrote during this view's life. The config re-check above
  // cannot tell an apply that just landed from a rule that was there all along
  // and missed — only the caller who pressed the key knows which.
  applied?: ReadonlySet<string>;
  selected: number;
  width: number;
  height?: number;
}

// Which group is selected, given how many there are. The list can shrink under
// an open view — a retry finishing rewrites the entry — so this is the one
// definition: what the view highlights and what a verb acts on must be the
// same index, and an empty list selects 0, never -1.
export const clampGroup = (selected: number, count: number): number =>
  Math.min(Math.max(0, selected), Math.max(0, count - 1));

const INDENT = "    ";

function groupLines(
  group: DenialGroup,
  cfg: Config,
  applied: ReadonlySet<string> | undefined,
  selected: boolean,
  width: number,
): PanelLine[] {
  const head = `${selected ? "▸ " : "  "}${group.suggestion} — ${group.count} denied`;
  const out: PanelLine[] = wrapText(head, width).map((text) => ({
    text,
    color: selected ? "cyan" : undefined,
  }));
  const detail = (text: string, line: Partial<PanelLine>) => {
    for (const t of wrapText(INDENT + text, width))
      out.push({ text: t, ...line });
  };
  if (group.writeShaped) {
    detail(
      "conflicts with docket's read-only stance — add manually or hand to claude",
      { color: "yellow" },
    );
  }
  if (applied?.has(group.suggestion)) {
    detail("applied — takes effect next run", { color: "green" });
  } else if (isAllowed(group.suggestion, cfg)) {
    detail("rule exists but didn't match", { color: "yellow" });
  }
  for (const example of group.examples) detail(example, { dim: true });
  return out;
}

// The denials view, one block per group. Bounded like the panel is: a review
// with eight groups would otherwise push the frame off the terminal.
export function denialLines({
  groups,
  cfg,
  applied,
  selected,
  width,
  height,
}: DenialViewInput): PanelLine[] {
  if (!groups.length)
    return [{ text: "no denials recorded for this review", dim: true }];
  const cursor = clampGroup(selected, groups.length);
  const blocks = groups.map((g, i) =>
    groupLines(g, cfg, applied, i === cursor, width),
  );
  const lines = blocks.flat();
  if (!height || lines.length <= height) return lines;
  // Scroll by whole blocks: show the selected group's head, and as much of the
  // rest of it as fits below.
  const start = blocks.slice(0, cursor).reduce((n, b) => n + b.length, 0);
  const end = start + (blocks[cursor]?.length ?? 0);
  const top = Math.min(start, Math.max(0, end - height));
  return lines.slice(top, top + height);
}
