import { entryKind, splitKey, type Entry, type Status } from "./state";

export type SortMode = "triage" | "updated" | "repo";

export const SORT_MODES: SortMode[] = ["triage", "updated", "repo"];

export function nextSortMode(mode: SortMode): SortMode {
  return SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length]!;
}

interface Band {
  label: string;
  statuses: Status[];
}

// Top to bottom is most to least in need of the user. Within a band the
// listed order of statuses is the order of rows.
const MINE_BANDS: Band[] = [
  { label: "ready to merge", statuses: ["approved"] },
  {
    label: "needs you",
    statuses: ["ready", "changes-requested", "commented", "failed", "canceled"],
  },
  { label: "in flight", statuses: ["reviewing"] },
  { label: "waiting on reviewers", statuses: ["open", "skipped"] },
];

const QUEUE_BANDS: Band[] = [
  { label: "needs you", statuses: ["failed", "canceled", "ready"] },
  {
    label: "you reviewed",
    statuses: ["approved", "commented", "changes-requested"],
  },
  { label: "in flight", statuses: ["reviewing"] },
  { label: "not run", statuses: ["open", "skipped"] },
];

// A draft is parked whatever its review state says.
const DRAFTS = "drafts";

export interface Ordered<R> {
  rows: R[];
  // Each band's label and the index of its first row; empty outside triage.
  bands: { label: string; start: number }[];
}

type Placed = { band: number; rank: number; label: string };

function place(key: string, entry: Entry): Placed {
  const bands = entryKind(key) === "mine" ? MINE_BANDS : QUEUE_BANDS;
  if (entry.flags?.includes("draft")) {
    return { band: bands.length, rank: 0, label: DRAFTS };
  }
  for (const [band, b] of bands.entries()) {
    const rank = b.statuses.indexOf(entry.status);
    if (rank >= 0) return { band, rank, label: b.label };
  }
  return { band: bands.length + 1, rank: 0, label: "other" };
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
): Ordered<R> {
  if (mode === "updated")
    return { rows: [...rows].sort(byActivity), bands: [] };
  if (mode === "repo") {
    const sorted = [...rows].sort((a, b) => {
      const x = splitKey(a.key);
      const y = splitKey(b.key);
      return (
        x.repo.localeCompare(y.repo) || Number(x.number) - Number(y.number)
      );
    });
    return { rows: sorted, bands: [] };
  }
  const placed = rows.map((row) => ({ row, at: place(row.key, row.entry) }));
  placed.sort(
    (a, b) =>
      a.at.band - b.at.band ||
      a.at.rank - b.at.rank ||
      byActivity(a.row, b.row),
  );
  const bands: Ordered<R>["bands"] = [];
  placed.forEach(({ at }, i) => {
    if (bands.at(-1)?.label !== at.label)
      bands.push({ label: at.label, start: i });
  });
  return { rows: placed.map((p) => p.row), bands };
}
