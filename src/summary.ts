// The triage summary every review is asked to end its final message with. The
// queue renders this; the prose behind it is only a fallback.
export type Risk = "low" | "medium" | "high";

// Every field is optional on purpose: `review_prompt` is configurable, so a
// prompt that never hunts for issues must still be able to answer honestly
// rather than inventing a count.
export interface Summary {
  headline?: string;
  issues?: number;
  risk?: Risk;
}

export interface Split {
  summary?: Summary;
  prose: string;
}

// Anchored at the end of the message: reviews quote json in their evidence, and
// a block picked from the middle would put a code sample in the queue. The
// leading group is greedy on purpose — a lazy one starts at the *first* fence in
// the message and swallows everything up to the final one.
const TRAILING_BLOCK = /^([\s\S]*)\n?```(?:json)?[ \t]*\n([\s\S]*?)\n?```\s*$/;

const RISKS: Risk[] = ["low", "medium", "high"];

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // state.json holds this forever; the UI truncates to the pane, but an agent
  // that ignores the length hint shouldn't be able to grow the file unbounded.
  const text = value.replace(/\s+/g, " ").trim().slice(0, 200);
  return text || undefined;
}

function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  return Math.trunc(value);
}

function risk(value: unknown): Risk | undefined {
  if (typeof value !== "string") return undefined;
  const r = value.trim().toLowerCase();
  return RISKS.find((x) => x === r);
}

// A block that parses but carries nothing we recognise is not a summary — the
// prose keeps it, because it is more likely a code sample than a failed answer.
function validate(raw: unknown): Summary | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const o = raw as Record<string, unknown>;
  const s: Summary = {};
  const headline = clean(o.headline);
  const issues = count(o.issues);
  const r = risk(o.risk);
  if (headline !== undefined) s.headline = headline;
  if (issues !== undefined) s.issues = issues;
  if (r !== undefined) s.risk = r;
  return Object.keys(s).length ? s : undefined;
}

// Split a review's final message into its triage summary and the prose before
// it. The block is removed only when it was accepted, so a review that ignored
// the instruction reads exactly as it did before.
export function splitSummary(result: string): Split {
  const m = TRAILING_BLOCK.exec(result);
  if (!m) return { prose: result };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[2] ?? "");
  } catch {
    return { prose: result };
  }
  const summary = validate(parsed);
  if (!summary) return { prose: result };
  return { summary, prose: (m[1] ?? "").trimEnd() };
}

export interface Chip {
  text: string;
  color?: string;
}

// The issue count as one scannable token. Absent means the prompt wasn't
// looking for issues, which is different from finding none.
export function issueChip(summary?: Summary): Chip | undefined {
  const n = summary?.issues;
  if (n === undefined) return undefined;
  if (n === 0) return { text: "✓ clean", color: "green" };
  return {
    text: `⚠ ${n} issue${n === 1 ? "" : "s"}`,
    color: summary?.risk === "high" ? "red" : "yellow",
  };
}

const RISK_CHIP: Record<Risk, Chip> = {
  low: { text: "LOW", color: "green" },
  medium: { text: "MED", color: "yellow" },
  high: { text: "HIGH", color: "red" },
};

export const riskChip = (summary?: Summary): Chip | undefined =>
  summary?.risk ? RISK_CHIP[summary.risk] : undefined;
