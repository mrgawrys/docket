import type { Assessment } from "./assessment";
import type { Config } from "./config";
import type { DenialGroup } from "./denials";
import { denialTeaser, TEASER_HEIGHT } from "./denialview";
import type { EntryKind } from "./state";
import type { Summary } from "./summary";

// Wrap here rather than letting the terminal do it: the panel is bounded, and a
// line it never counted would push the rest of the frame down.
export function wrapText(text: string, rawWidth: number): string[] {
  // A pane can be narrower than a single column. At width 0 the slicing below
  // never shortens the word, and the loop spins on the render thread forever.
  const width = Math.max(1, rawWidth);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    // Assessments are markdown: leading spaces are what tell a nested bullet
    // from its parent and a quoted snippet from the prose around it. Wrap
    // inside the indent and re-apply it, rather than letting split(" ") eat it.
    const indent = /^ */.exec(para)?.[0] ?? "";
    const avail = Math.max(1, width - indent.length);
    const push = (s: string) => out.push(indent + s);
    let line = "";
    for (const word of para.slice(indent.length).split(" ")) {
      let w = word;
      while (w.length > avail) {
        if (line) {
          push(line);
          line = "";
        }
        push(w.slice(0, avail));
        w = w.slice(avail);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= avail) line += ` ${w}`;
      else {
        push(line);
        line = w;
      }
    }
    push(line);
  }
  return out;
}

export interface PanelLine {
  text: string;
  color?: string;
  dim?: boolean;
}

// Small on purpose. The queue answers "which PR next"; this answers "what did
// the review conclude" in a glance, and `enter` is how the review gets read.
export const PANEL_HEIGHT = 4;

export interface PanelInput {
  summary?: Summary;
  assessment: Assessment;
  // The run's denials and the config to judge them against. The teaser they
  // render into is where this feature is discovered, so it sits with the rest
  // of the detail rather than waiting behind a key nobody knows about.
  denials?: DenialGroup[];
  cfg?: Config;
  // Which world the entry belongs to — the teaser judges denials against the
  // matching allowlist.
  kind?: EntryKind;
  // Passed to the teaser: whether enter on this row resolves the denials.
  enterResolves?: boolean;
  width: number;
  height?: number;
}

export function panelLines({
  summary,
  assessment,
  denials,
  cfg,
  kind,
  enterResolves,
  width,
  height = PANEL_HEIGHT,
}: PanelInput): PanelLine[] {
  const out: PanelLine[] = [];
  if (denials?.length && cfg) {
    // The two rows held back are the blank and the headline: the denials are
    // new here, not the reason the panel exists.
    const teaser = denialTeaser({
      groups: denials,
      cfg,
      kind,
      enterResolves,
      width,
      height: Math.min(TEASER_HEIGHT, height - out.length - 2),
    });
    if (teaser.length) out.push(...teaser, { text: " " });
  }
  const room = height - out.length;
  if (room <= 0) return out;

  // The headline is the whole point: one line the review wrote for this moment.
  if (summary?.headline) {
    for (const text of wrapText(summary.headline, width).slice(0, room))
      out.push({ text });
    return out;
  }
  // Fallback for a review that predates summaries, or ignored the instruction.
  // Blank lines are what give markdown its shape over a page; across three
  // rows they only cost content.
  const body =
    assessment.kind === "text"
      ? wrapText(assessment.text, width).filter((l) => l.trim())
      : [assessment.reason];
  const shown = body.slice(0, room);
  if (body.length > shown.length && shown.length) {
    // The rest is not lost, it is one keypress away — say so rather than
    // ending mid-sentence as if that were the whole verdict.
    shown[shown.length - 1] = `${shown[shown.length - 1]} …`;
  }
  for (const text of shown) out.push({ text, dim: true });
  return out;
}
