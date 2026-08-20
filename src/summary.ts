// The triage summary every review is asked to end its final message with. The
// queue renders this; the prose behind it is only a fallback.
export type Risk = "low" | "medium" | "high";

// What every run is asked to end with. Fixed rather than configurable so the
// queue keeps a triage signal whatever the task body asks for; a prompt that
// cannot answer a field omits it (see splitSummary).
export const SUMMARY_INSTRUCTION =
  `Finally, end your last message with a fenced json block — a triage summary ` +
  `for the review queue — and write nothing after it:\n\n` +
  "```json\n" +
  `{"headline": "one line, at most 80 characters, the first thing the ` +
  `reviewer should know", "issues": <how many you would flag — omit the key ` +
  `entirely if finding issues was not your task>, "risk": "low" | "medium" | ` +
  `"high" — omit the key if you did not assess risk}\n` +
  "```";

// A receive run's counterpart: it is not looking for issues or weighing risk,
// it is working through asks — so it reports how many it took and how many it
// left, each with a reason the author can read in the session.
export const RECEIVE_SUMMARY_INSTRUCTION =
  `Finally, end your last message with a fenced json block — a summary for ` +
  `the author's queue — and write nothing after it:\n\n` +
  "```json\n" +
  `{"headline": "one line, at most 80 characters, the first thing the ` +
  `author should know", "addressed": <how many review points you ` +
  `implemented>, "deferred": <how many you left alone, each with a reason in ` +
  `your message — omit either key if the feedback could not be read at all>}\n` +
  "```";

// Every field is optional on purpose: `review_prompt` is configurable, so a
// prompt that never hunts for issues must still be able to answer honestly
// rather than inventing a count. `addressed`/`deferred` are the receive run's
// fields; a review never writes them.
export interface Summary {
  headline?: string;
  issues?: number;
  risk?: Risk;
  addressed?: number;
  deferred?: number;
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
  const addressed = count(o.addressed);
  const deferred = count(o.deferred);
  if (headline !== undefined) s.headline = headline;
  if (issues !== undefined) s.issues = issues;
  if (r !== undefined) s.risk = r;
  if (addressed !== undefined) s.addressed = addressed;
  if (deferred !== undefined) s.deferred = deferred;
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

// A mine row's counterpart to the issue chip: what is still open on the
// user's own PR. Absent until a sync has looked.
export function threadChip(threads?: {
  unresolved: number;
  total: number;
}): Chip | undefined {
  if (!threads) return undefined;
  if (threads.unresolved > 0)
    return { text: `${threads.unresolved} unresolved`, color: "yellow" };
  if (threads.total > 0) return { text: "✓ resolved", color: "green" };
  return undefined;
}

const RISK_CHIP: Record<Risk, Chip> = {
  low: { text: "LOW", color: "green" },
  medium: { text: "MED", color: "yellow" },
  high: { text: "HIGH", color: "red" },
};

export const riskChip = (summary?: Summary): Chip | undefined =>
  summary?.risk ? RISK_CHIP[summary.risk] : undefined;

// What a receive run did with the feedback, where a review row shows risk.
// Absent when the run never got to count — no feedback readable, or a run
// that ignored the contract — rather than a reassuring "0 deferred".
export function receiveChip(summary?: Summary): Chip | undefined {
  const a = summary?.addressed;
  const d = summary?.deferred;
  if (a === undefined && d === undefined) return undefined;
  const parts: string[] = [];
  if (a !== undefined) parts.push(`${a} addressed`);
  if (d) parts.push(`${d} deferred`);
  return { text: parts.join(" · "), color: d ? "yellow" : "green" };
}
