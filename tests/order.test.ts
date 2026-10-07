import { expect, test } from "bun:test";
import { nextSortMode, orderRows } from "../src/order";
import type { Entry, Status } from "../src/state";

const row = (
  key: string,
  status: Status,
  extra: Partial<Entry> = {},
): { key: string; entry: Entry } => ({
  key,
  entry: { status, updated_at: "2026-01-01T00:00:00Z", ...extra },
});

test("triage puts the user's own PRs in need order, drafts last whatever their state", () => {
  const rows = orderRows(
    [
      row("mine:o/a#1", "open"),
      row("mine:o/a#2", "changes-requested", { flags: ["draft"] }),
      row("mine:o/a#3", "commented"),
      row("mine:o/a#4", "reviewing"),
      row("mine:o/a#5", "ready"),
      row("mine:o/a#6", "approved"),
      row("mine:o/a#7", "failed"),
    ],
    "triage",
  );
  expect(rows.map((r) => r.key)).toEqual([
    "mine:o/a#6",
    "mine:o/a#5",
    "mine:o/a#3",
    "mine:o/a#7",
    "mine:o/a#4",
    "mine:o/a#1",
    "mine:o/a#2",
  ]);
});

test("triage puts broken review runs above prepped ones in the queue", () => {
  const rows = orderRows(
    [
      row("o/a#1", "skipped"),
      row("o/a#2", "ready"),
      row("o/a#3", "approved"),
      row("o/a#4", "canceled"),
    ],
    "triage",
  );
  expect(rows.map((r) => r.key)).toEqual(["o/a#4", "o/a#2", "o/a#3", "o/a#1"]);
});

test("within a status the most recent GitHub activity leads, docket's stamp as the fallback", () => {
  const rows = orderRows(
    [
      row("mine:o/a#1", "open", { pr_updated_at: "2026-10-01T00:00:00Z" }),
      row("mine:o/a#2", "open", { updated_at: "2026-10-03T00:00:00Z" }),
      row("mine:o/a#3", "open", { pr_updated_at: "2026-10-02T00:00:00Z" }),
    ],
    "triage",
  );
  expect(rows.map((r) => r.key)).toEqual([
    "mine:o/a#2",
    "mine:o/a#3",
    "mine:o/a#1",
  ]);
});

test("the other modes ignore state: newest activity first, or repo then PR number", () => {
  const input = [
    row("o/b#9", "ready", { pr_updated_at: "2026-10-01T00:00:00Z" }),
    row("o/a#10", "open", { pr_updated_at: "2026-10-03T00:00:00Z" }),
    row("o/a#9", "failed", { pr_updated_at: "2026-10-02T00:00:00Z" }),
  ];
  expect(orderRows(input, "updated").map((r) => r.key)).toEqual([
    "o/a#10",
    "o/a#9",
    "o/b#9",
  ]);
  // numeric, not string: #9 before #10
  expect(orderRows(input, "repo").map((r) => r.key)).toEqual([
    "o/a#9",
    "o/a#10",
    "o/b#9",
  ]);
});

test("nextSortMode cycles back to triage", () => {
  expect(nextSortMode("triage")).toBe("updated");
  expect(nextSortMode("updated")).toBe("repo");
  expect(nextSortMode("repo")).toBe("triage");
});
