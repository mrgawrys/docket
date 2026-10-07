import { entryKind, splitKey, type Entry, type Status } from "./state";

export type SortMode = "triage" | "updated" | "repo";

export const SORT_MODES: SortMode[] = ["triage", "updated", "repo"];

export function nextSortMode(mode: SortMode): SortMode {
  return SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length]!;
}

// Most to least in need of the user, top to bottom. Failed and canceled
// share a rank, as do the three verdicts on a review the user already left.
const MINE_RANKS: Status[][] = [
  ["approved"],
  ["ready"],
  ["changes-requested"],
  ["commented"],
  ["failed", "canceled"],
  ["reviewing"],
  ["open"],
  ["skipped"],
];

const QUEUE_RANKS: Status[][] = [
  ["failed", "canceled"],
  ["ready"],
  ["approved", "commented", "changes-requested"],
  ["reviewing"],
  ["open"],
  ["skipped"],
];

function rank(key: string, entry: Entry): number {
  const ranks = entryKind(key) === "mine" ? MINE_RANKS : QUEUE_RANKS;
  // a draft is parked whatever its review state says
  if (entry.flags?.includes("draft")) return ranks.length + 1;
  const i = ranks.findIndex((r) => r.includes(entry.status));
  return i >= 0 ? i : ranks.length;
}

const activity = (e: Entry) => e.pr_updated_at ?? e.updated_at;

function byActivity(
  a: { key: string; entry: Entry },
  b: { key: string; entry: Entry },
): number {
  return (
    activity(b.entry).localeCompare(activity(a.entry)) ||
    a.key.localeCompare(b.key)
  );
}

export function orderRows<R extends { key: string; entry: Entry }>(
  rows: R[],
  mode: SortMode,
): R[] {
  if (mode === "updated") return [...rows].sort(byActivity);
  if (mode === "repo") {
    return [...rows].sort((a, b) => {
      const x = splitKey(a.key);
      const y = splitKey(b.key);
      return (
        x.repo.localeCompare(y.repo) || Number(x.number) - Number(y.number)
      );
    });
  }
  return [...rows].sort(
    (a, b) => rank(a.key, a.entry) - rank(b.key, b.entry) || byActivity(a, b),
  );
}
