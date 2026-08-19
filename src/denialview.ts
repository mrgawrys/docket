import type { Config } from "./config";
import { isAllowed, isWriteShaped, type DenialGroup } from "./denials";
import { wrapText, type PanelLine } from "./panel";
import type { EntryKind } from "./state";
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

const calls = (groups: DenialGroup[]): number =>
  groups.reduce((n, g) => n + g.count, 0);

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

// What sits on the denials view's bar: the two numbers that say how much of
// the run this was.
export const denialTitle = (groups: DenialGroup[]): string =>
  `${plural(groups.length, "rule")}, ${plural(calls(groups), "blocked call")}`;

export interface Addable {
  add: DenialGroup[];
  writeShaped: DenialGroup[]; // docket never adds these
  present: DenialGroup[]; // adding them again fixes nothing
}

// The groups `a` will write, and why each of the rest was left out. One place
// decides it, so the count in the action line and the rules that reach config
// cannot disagree. Both checks the per-group keystroke used to make survive:
// the flag frozen when the run ended, and the live classifier, so a rule the
// blocklist has since grown still gets turned away.
export function addable(
  groups: DenialGroup[],
  cfg: Config,
  kind: EntryKind = "review",
): Addable {
  const out: Addable = { add: [], writeShaped: [], present: [] };
  for (const g of groups) {
    if (g.writeShaped || isWriteShaped(g.suggestion)) out.writeShaped.push(g);
    else if (isAllowed(g.suggestion, cfg, kind)) out.present.push(g);
    else out.add.push(g);
  }
  return out;
}

// Added since the run ended — in practice, by `a` a moment ago. Derived rather
// than remembered: a set held in the view resets on every suspend, while the
// config the run was judged against does not change under it.
export const addedNow = (
  groups: DenialGroup[],
  cfg: Config,
  kind: EntryKind = "review",
): DenialGroup[] =>
  groups.filter((g) => !g.alreadyAllowed && isAllowed(g.suggestion, cfg, kind));

function marker(
  g: DenialGroup,
  cfg: Config,
  kind: EntryKind,
): { text: string; color?: string } | undefined {
  if (g.writeShaped || isWriteShaped(g.suggestion)) {
    // On a receive run a denied write-shaped call is the no-push/no-GitHub
    // guarantee doing its job, not a rule waiting to be added.
    return kind === "mine"
      ? { text: "✓ blocked by design", color: "green" }
      : { text: "⚠ write-shaped", color: "yellow" };
  }
  if (!isAllowed(g.suggestion, cfg, kind)) return undefined;
  return g.alreadyAllowed
    ? { text: "✓ already in your config" }
    : { text: "✓ added just now", color: "green" };
}

// `Bash(rg:*)   ×24   ⚠ write-shaped`, in a column so the counts line up.
function groupRow(
  g: DenialGroup,
  cfg: Config,
  kind: EntryKind,
  indent: string,
  pad: number,
  width: number,
): PanelLine[] {
  const m = marker(g, cfg, kind);
  const text = `${indent}${g.suggestion.padEnd(pad)}  ×${g.count}${
    m ? `    ${m.text}` : ""
  }`;
  return wrapText(text, width).map((t) => ({ text: t, color: m?.color }));
}

const widest = (groups: DenialGroup[]): number =>
  Math.max(0, ...groups.map((g) => g.suggestion.length));

// head, up to three groups, and the line naming the key.
export const TEASER_HEIGHT = 5;
const TEASER_GROUPS = 3;

export interface TeaserInput {
  groups: DenialGroup[];
  cfg: Config;
  kind?: EntryKind;
  width: number;
  height?: number;
  // Whether enter on this row resolves the denials rather than resuming a
  // session. The teaser names the key that acts, so it has to know which.
  enterResolves?: boolean;
}

// The denials section of the queue's detail panel — the only place this
// feature has to be discoverable from, so it ends on the key that opens it.
export function denialTeaser({
  groups,
  cfg,
  kind = "review",
  width,
  height = TEASER_HEIGHT,
  enterResolves = false,
}: TeaserInput): PanelLine[] {
  if (!groups.length || height < 2) return [];
  const total = calls(groups);
  const head =
    total === 1
      ? "1 call was blocked — the review worked around it."
      : `${total} calls were blocked — the review worked around them.`;
  const shown = groups.slice(
    0,
    Math.max(0, Math.min(TEASER_GROUPS, height - 2)),
  );
  const rest = groups.length - shown.length;
  const more = rest ? `+ ${rest} more · ` : "";
  // When enter resolves, this is the call to action rather than a footnote:
  // it names the key first and stays undimmed, because it is the one line
  // that has to be read from across the panel.
  const tail = enterResolves
    ? `${more}⏎ resolves these with claude · D lists them first`
    : `${more}D works through them`;
  const pad = widest(shown);
  return [
    ...wrapText(head, width).map((text) => ({ text })),
    ...shown.flatMap((g) => groupRow(g, cfg, kind, "  ", pad, width)),
    ...wrapText(tail, width).map((text) => ({
      text,
      color: enterResolves ? "cyan" : undefined,
      dim: !enterResolves,
    })),
  ];
}

// Why `a` left rules behind — "4 write-shaped, 1 already there".
function skipped(a: Addable, long: boolean, kind: EntryKind): string {
  const parts: string[] = [];
  if (a.writeShaped.length)
    parts.push(
      `${a.writeShaped.length} ${kind === "mine" ? "blocked by design" : "write-shaped"}`,
    );
  if (a.present.length)
    parts.push(
      `${a.present.length} already ${long ? "in your config" : "there"}`,
    );
  return parts.join(", ");
}

// The verbs, as panel content rather than bar text: these lines wrap, and a
// narrow terminal truncates the bar first.
function actionLines(
  groups: DenialGroup[],
  cfg: Config,
  kind: EntryKind,
  width: number,
): PanelLine[] {
  const a = addable(groups, cfg, kind);
  const added = addedNow(groups, cfg, kind);
  // A space, not an empty string: ink gives a zero-length Text no row, and the
  // action block needs the gap to read as a foot rather than another group.
  const out: PanelLine[] = [{ text: " " }];
  const push = (text: string, line: Partial<PanelLine> = {}) => {
    for (const t of wrapText(text, width)) out.push({ text: t, ...line });
  };
  if (added.length) {
    push(
      added.length === 1
        ? "1 rule added — it applies to the next run of this review."
        : `${added.length} rules added — they apply to the next run of this review.`,
      { color: "green" },
    );
    push("r  re-run the review now       ⏎  hand the rest to claude");
  } else {
    push("⏎  hand all of this to claude");
  }
  const rest = skipped(a, false, kind);
  if (a.add.length) {
    const count = plural(a.add.length, "safe rule");
    const why = rest
      ? ` (${a.writeShaped.length + a.present.length} skipped: ${rest})`
      : "";
    push(`a  add the ${count} to your config${why}`);
  } else if (rest && !added.length) {
    // Say why rather than accept a key that then declines. Once an add has
    // landed the line above already accounts for the set — repeating it as a
    // refusal would read as if something had gone wrong.
    push(`a  nothing to add — ${skipped(a, true, kind)}`, { dim: true });
  }
  push("esc back to the queue · j/k scroll", { dim: true });
  return out;
}

export interface DenialViewInput {
  groups: DenialGroup[];
  kind?: EntryKind;
  // Re-checked against here rather than trusting `alreadyAllowed`: the flag was
  // frozen when the run finished, and an apply since then has made it a lie.
  cfg: Config;
  // First body line shown. Clamped here, so a `j` held down at the end of a
  // long list cannot walk the offset off into nowhere.
  scroll: number;
  width: number;
  height?: number;
}

export interface DenialView {
  lines: PanelLine[];
  maxScroll: number;
}

// The whole view: every group, then the action block pinned at the foot. Only
// the groups scroll — the verbs are the one thing that must never scroll away.
export function denialView({
  groups,
  kind = "review",
  cfg,
  scroll,
  width,
  height,
}: DenialViewInput): DenialView {
  if (!groups.length)
    return {
      lines: [{ text: "no denials recorded for this review", dim: true }],
      maxScroll: 0,
    };
  const pad = widest(groups);
  const body: PanelLine[] = [];
  for (const g of groups) {
    body.push(...groupRow(g, cfg, kind, "", pad, width));
    for (const example of g.examples)
      for (const text of wrapText(`    ${example}`, width))
        body.push({ text, dim: true });
  }
  const action = actionLines(groups, cfg, kind, width);
  const room = height ? Math.max(1, height - action.length) : body.length;
  const maxScroll = Math.max(0, body.length - room);
  const top = Math.min(Math.max(0, scroll), maxScroll);
  return { lines: [...body.slice(top, top + room), ...action], maxScroll };
}
