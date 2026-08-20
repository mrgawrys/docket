import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, runLogPath } from "../src/config";
import {
  bareKey,
  entryKind,
  statusLabel,
  loadState,
  markDone,
  markReviewed,
  normalizeKey,
  pendingEntries,
  saveState,
  setStatus,
  splitKey,
  timestamp,
} from "../src/state";

const statePath = () =>
  join(mkdtempSync(join(tmpdir(), "rv-state-")), "state.json");

test("normalizeKey accepts org/repo#N and PR URLs, rejects garbage", () => {
  expect(normalizeKey("acme/widgets#12")).toBe("acme/widgets#12");
  expect(normalizeKey("https://github.com/acme/widgets/pull/12")).toBe(
    "acme/widgets#12",
  );
  expect(() => normalizeKey("total garbage")).toThrow(/cannot parse/);
  expect(() => normalizeKey("acme/widgets")).toThrow(/cannot parse/);
});

test("normalizeKey accepts mine: keys and mine: URLs, rejects other colons", () => {
  expect(normalizeKey("mine:acme/widgets#12")).toBe("mine:acme/widgets#12");
  expect(normalizeKey("mine:https://github.com/acme/widgets/pull/12")).toBe(
    "mine:acme/widgets#12",
  );
  // today this would silently parse with "mine:org" as the org — must reject
  expect(() => normalizeKey("theirs:acme/widgets#12")).toThrow(/cannot parse/);
  expect(() => normalizeKey("acme:widgets/x#12")).toThrow(/cannot parse/);
});

test("entryKind and bareKey derive kind from the prefix", () => {
  expect(entryKind("acme/widgets#12")).toBe("review");
  expect(entryKind("mine:acme/widgets#12")).toBe("mine");
  expect(bareKey("mine:acme/widgets#12")).toBe("acme/widgets#12");
  expect(bareKey("acme/widgets#12")).toBe("acme/widgets#12");
});

test("splitKey strips the mine: prefix — gh never sees it", () => {
  expect(splitKey("mine:acme/widgets#12")).toEqual({
    repo: "acme/widgets",
    number: "12",
  });
});

test("runLogPath slugs the mine: prefix like / and #", () => {
  const p = paths({ DOCKET_CONFIG_DIR: "/c", DOCKET_STATE_DIR: "/s" });
  expect(runLogPath(p, "mine:acme/widgets#12")).toBe(
    "/s/runs/mine-acme-widgets-12.jsonl",
  );
});

test("loadState migrates my_review_at to review_at on read", () => {
  const p = statePath();
  writeFileSync(
    p,
    JSON.stringify({
      "a/b#1": {
        status: "approved",
        my_review_at: "2026-01-01T00:00:00Z",
        updated_at: "t",
      },
    }),
  );
  const e = loadState(p)["a/b#1"]!;
  expect(e.review_at).toBe("2026-01-01T00:00:00Z");
  expect("my_review_at" in e).toBe(false);
});

test("pendingEntries filters by kind when asked, all kinds otherwise", () => {
  const s = {
    "a/b#1": { status: "ready" as const, updated_at: "2026-01-01T00:00:00Z" },
    "mine:a/b#2": {
      status: "open" as const,
      updated_at: "2026-01-02T00:00:00Z",
    },
  };
  expect(pendingEntries(s).map(([k]) => k)).toEqual(["a/b#1", "mine:a/b#2"]);
  expect(pendingEntries(s, "review").map(([k]) => k)).toEqual(["a/b#1"]);
  expect(pendingEntries(s, "mine").map(([k]) => k)).toEqual(["mine:a/b#2"]);
});

test("splitKey splits on the last #", () => {
  expect(splitKey("acme/widgets#12")).toEqual({
    repo: "acme/widgets",
    number: "12",
  });
});

test("timestamp is second-precision UTC", () => {
  expect(timestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("load bootstraps {}, save round-trips", () => {
  const p = statePath();
  expect(loadState(p)).toEqual({});
  saveState(p, { "a/b#1": { status: "ready", updated_at: "t" } });
  expect(loadState(p)["a/b#1"]!.status).toBe("ready");
});

test("load heals an empty (0-byte) state.json instead of crashing on JSON.parse", () => {
  const p = statePath();
  writeFileSync(p, "");
  expect(loadState(p)).toEqual({});
  expect(readFileSync(p, "utf8")).toBe("{}\n");
});

test("setStatus updates status + updated_at, records error only when given", () => {
  const p = statePath();
  saveState(p, {
    "a/b#1": { status: "reviewing", updated_at: "2020-01-01T00:00:00Z" },
  });
  setStatus(p, "a/b#1", "failed", "boom");
  const e = loadState(p)["a/b#1"]!;
  expect(e.status).toBe("failed");
  expect(e.error).toBe("boom");
  expect(e.updated_at).not.toBe("2020-01-01T00:00:00Z");
  setStatus(p, "a/b#1", "ready");
  expect(loadState(p)["a/b#1"]!.error).toBe("boom"); // untouched when not given
});

test("markDone and markReviewed", () => {
  const p = statePath();
  saveState(p, {
    "a/b#1": { status: "ready", session_id: "s", updated_at: "t" },
  });
  markReviewed(p, "a/b#1", "changes-requested", "2026-07-19T10:00:00Z", [
    "re-requested",
  ]);
  let e = loadState(p)["a/b#1"]!;
  expect(e.status).toBe("changes-requested");
  expect(e.flags).toEqual(["re-requested"]);
  expect(e.session_id).toBe("s"); // must stay resumable (scenario 13)
  markDone(p, "a/b#1", "merged");
  e = loadState(p)["a/b#1"]!;
  expect(e.status).toBe("done");
  expect(e.done_reason).toBe("merged");
});

test("pendingEntries excludes done, sorts by updated_at ascending", () => {
  const s = {
    "a/b#3": { status: "done" as const, updated_at: "2026-01-03T00:00:00Z" },
    "a/b#2": { status: "ready" as const, updated_at: "2026-01-02T00:00:00Z" },
    "a/b#1": { status: "failed" as const, updated_at: "2026-01-01T00:00:00Z" },
  };
  expect(pendingEntries(s).map(([k]) => k)).toEqual(["a/b#1", "a/b#2"]);
});

// A mine row never "reviews": the stored status is shared, the word is not.
test("statusLabel renames the run states for mine entries only", () => {
  expect(statusLabel("mine:o/r#1", "reviewing")).toBe("addressing");
  expect(statusLabel("mine:o/r#1", "ready")).toBe("fixes ready");
  expect(statusLabel("mine:o/r#1", "approved")).toBe("approved");
  expect(statusLabel("o/r#1", "reviewing")).toBe("reviewing");
  expect(statusLabel("o/r#1", "ready")).toBe("ready");
});
