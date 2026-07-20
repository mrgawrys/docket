import { expect, test } from "bun:test";
import { decideSync } from "../src/sync";
import { makeSandbox } from "./harness";

test("decideSync: merged/closed/no-review/verdicts/flags", () => {
  expect(decideSync({ state: "MERGED" }, "me")).toEqual({ kind: "done", reason: "merged" });
  expect(decideSync({ state: "CLOSED" }, "me")).toEqual({ kind: "done", reason: "closed" });
  expect(decideSync({ state: "OPEN" }, "me")).toEqual({ kind: "unchanged" });
  expect(
    decideSync(
      { state: "OPEN", latestReviews: [{ author: { login: "other" }, state: "APPROVED", submittedAt: "t" }] },
      "me",
    ),
  ).toEqual({ kind: "unchanged" });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [{ author: { login: "me" }, state: "CHANGES_REQUESTED", submittedAt: "2026-07-19T10:00:00Z" }],
        reviewRequests: [{ login: "me" }],
        commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
      },
      "me",
    ),
  ).toEqual({
    kind: "reviewed", verdict: "changes-requested",
    reviewedAt: "2026-07-19T10:00:00Z", flags: ["re-requested", "new-commits"],
  });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [{ author: { login: "me" }, state: "APPROVED", submittedAt: "2026-07-19T13:00:00Z" }],
        reviewRequests: [],
        commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
      },
      "me",
    ),
  ).toEqual({ kind: "reviewed", verdict: "approved", reviewedAt: "2026-07-19T13:00:00Z", flags: [] });
});

test("sync command: scenarios 13-15", () => {
  const sb = makeSandbox();
  const ready = {
    "testorg/demo#7": {
      status: "ready", session_id: "sess-1234", title: "Demo PR", url: "u",
      local_path: sb.demoRepo, updated_at: "2026-01-01T00:00:00Z",
    },
  };
  sb.writeState(ready);

  // scenario 13: verdict recorded, both flags, session kept, claude never called
  const before = sb.claudeCalls();
  let r = sb.run(["sync"], {
    GH_PR_STATUS_JSON: JSON.stringify({
      state: "OPEN",
      latestReviews: [{ author: { login: "testuser" }, state: "CHANGES_REQUESTED", submittedAt: "2026-07-19T10:00:00Z" }],
      reviewRequests: [{ login: "testuser" }],
      commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
    }),
  });
  expect(r.code).toBe(0);
  let e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("changes-requested");
  expect(e.flags).toEqual(["re-requested", "new-commits"]);
  expect(e.session_id).toBe("sess-1234");
  expect(sb.claudeCalls()).toBe(before);

  // scenario 14: plain approval clears flags
  r = sb.run(["sync"], {
    GH_PR_STATUS_JSON: JSON.stringify({
      state: "OPEN",
      latestReviews: [{ author: { login: "testuser" }, state: "APPROVED", submittedAt: "2026-07-19T13:00:00Z" }],
      reviewRequests: [],
      commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
    }),
  });
  expect(r.code).toBe(0);
  e = sb.state()["testorg/demo#7"];
  expect(e.status).toBe("approved");
  expect(e.flags).toEqual([]);

  // scenario 15: gh failure leaves the entry untouched
  r = sb.run(["sync"], { GH_PR_VIEW_FAIL: "1" });
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#7"].status).toBe("approved");
});
