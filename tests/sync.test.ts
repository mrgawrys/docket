import { expect, test } from "bun:test";
import type { PrMineInfo } from "../src/github";
import type { Entry } from "../src/state";
import { decideMineSync, decideSync } from "../src/sync";
import { makeSandbox } from "./harness";

test("decideSync: merged/closed/no-review/verdicts/flags", () => {
  expect(decideSync({ state: "MERGED" }, "me")).toEqual({
    kind: "done",
    reason: "merged",
  });
  expect(decideSync({ state: "CLOSED" }, "me")).toEqual({
    kind: "done",
    reason: "closed",
  });
  expect(decideSync({ state: "OPEN" }, "me")).toEqual({ kind: "unchanged" });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [
          { author: { login: "other" }, state: "APPROVED", submittedAt: "t" },
        ],
      },
      "me",
    ),
  ).toEqual({ kind: "unchanged" });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [
          {
            author: { login: "me" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-07-19T10:00:00Z",
          },
        ],
        reviewRequests: [{ login: "me" }],
        commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
      },
      "me",
    ),
  ).toEqual({
    kind: "reviewed",
    verdict: "changes-requested",
    reviewedAt: "2026-07-19T10:00:00Z",
    flags: ["re-requested", "new-commits"],
  });
  expect(
    decideSync(
      {
        state: "OPEN",
        latestReviews: [
          {
            author: { login: "me" },
            state: "APPROVED",
            submittedAt: "2026-07-19T13:00:00Z",
          },
        ],
        reviewRequests: [],
        commits: [{ committedDate: "2026-07-19T12:00:00Z" }],
      },
      "me",
    ),
  ).toEqual({
    kind: "reviewed",
    verdict: "approved",
    reviewedAt: "2026-07-19T13:00:00Z",
    flags: [],
  });
});

test("sync command: scenarios 13-15", () => {
  const sb = makeSandbox();
  const ready = {
    "testorg/demo#7": {
      status: "ready",
      session_id: "sess-1234",
      title: "Demo PR",
      url: "u",
      local_path: sb.demoRepo,
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
  sb.writeState(ready);

  // scenario 13: verdict recorded, both flags, session kept, claude never called
  const before = sb.claudeCalls();
  let r = sb.run(["sync"], {
    GH_PR_STATUS_JSON: JSON.stringify({
      state: "OPEN",
      latestReviews: [
        {
          author: { login: "testuser" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-07-19T10:00:00Z",
        },
      ],
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
      latestReviews: [
        {
          author: { login: "testuser" },
          state: "APPROVED",
          submittedAt: "2026-07-19T13:00:00Z",
        },
      ],
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

// --- mine kind ---

type Review = PrMineInfo["reviews"][number];
const rev = (over: Partial<Review>): Review => ({
  author: "other",
  state: "COMMENTED",
  body: "some feedback",
  submittedAt: "2026-02-01T00:00:00Z",
  ...over,
});
const mineInfo = (
  reviews: Review[],
  over: Partial<PrMineInfo> = {},
): PrMineInfo => ({
  state: "OPEN",
  isDraft: false,
  headRefOid: "sha1",
  headRefName: "feature",
  reviews,
  ...over,
});
const mineEntry = (over: Partial<Entry> = {}): Entry => ({
  status: "open",
  review_at: "2026-01-01T00:00:00Z",
  updated_at: "t",
  ...over,
});

test("decideMineSync: merged/closed win over everything", () => {
  expect(
    decideMineSync(mineInfo([rev({})], { state: "MERGED" }), "me", mineEntry()),
  ).toEqual({ kind: "done" });
  expect(
    decideMineSync(mineInfo([], { state: "CLOSED" }), "me", mineEntry()),
  ).toEqual({ kind: "done" });
});

test("decideMineSync: actionable review states, bare vs with-body", () => {
  const fb = (r: Review) => decideMineSync(mineInfo([r]), "me", mineEntry());
  expect(fb(rev({ state: "CHANGES_REQUESTED", body: "" }))).toEqual({
    kind: "feedback",
    at: "2026-02-01T00:00:00Z",
    verdict: "changes-requested",
    reviewer: "other",
  });
  expect(fb(rev({ state: "COMMENTED", body: "" }))).toMatchObject({
    kind: "feedback",
    verdict: "commented",
  });
  // a bare comment-less approval is not feedback
  expect(fb(rev({ state: "APPROVED", body: "" }))).toEqual({ kind: "none" });
  expect(fb(rev({ state: "APPROVED", body: "   " }))).toEqual({ kind: "none" });
  expect(fb(rev({ state: "APPROVED", body: "nice, one nit" }))).toMatchObject({
    kind: "feedback",
    verdict: "approved",
  });
});

test("decideMineSync: my own reviews never trigger", () => {
  expect(
    decideMineSync(
      mineInfo([rev({ author: "me", state: "CHANGES_REQUESTED" })]),
      "me",
      mineEntry(),
    ),
  ).toEqual({ kind: "none" });
});

test("decideMineSync: only reviews after the cursor count", () => {
  const before = rev({ submittedAt: "2020-01-01T00:00:00Z" });
  expect(decideMineSync(mineInfo([before]), "me", mineEntry())).toEqual({
    kind: "none",
  });
  // equal to the cursor: already accounted for
  const atCursor = rev({ submittedAt: "2026-01-01T00:00:00Z" });
  expect(decideMineSync(mineInfo([atCursor]), "me", mineEntry())).toEqual({
    kind: "none",
  });
  // no cursor yet: everything counts
  expect(
    decideMineSync(
      mineInfo([before]),
      "me",
      mineEntry({ review_at: undefined }),
    ),
  ).toMatchObject({ kind: "feedback" });
});

test("decideMineSync: verdict and reviewer agree — both from the worst review", () => {
  // carol requested changes, dave approved with a nit afterwards: the entry
  // must say "changes-requested by carol", never "by dave" — dave approved.
  const older = rev({
    state: "CHANGES_REQUESTED",
    author: "carol",
    submittedAt: "2026-02-01T00:00:00Z",
  });
  const newer = rev({
    state: "APPROVED",
    body: "lgtm with a nit",
    author: "dave",
    submittedAt: "2026-02-02T00:00:00Z",
  });
  expect(decideMineSync(mineInfo([newer, older]), "me", mineEntry())).toEqual({
    kind: "feedback",
    verdict: "changes-requested",
    at: "2026-02-02T00:00:00Z", // the cursor still passes dave's review
    reviewer: "carol",
  });
});

test("decideMineSync: equal verdicts — the newest of the worst is the reviewer", () => {
  const carol = rev({
    state: "CHANGES_REQUESTED",
    author: "carol",
    submittedAt: "2026-02-01T00:00:00Z",
  });
  const erin = rev({
    state: "CHANGES_REQUESTED",
    author: "erin",
    submittedAt: "2026-02-03T00:00:00Z",
  });
  expect(decideMineSync(mineInfo([carol, erin]), "me", mineEntry())).toEqual({
    kind: "feedback",
    verdict: "changes-requested",
    at: "2026-02-03T00:00:00Z",
    reviewer: "erin",
  });
});

test("sync: mine entry — feedback records verdict/cursor/reviewer, no run starts", () => {
  const sb = makeSandbox();
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      title: "My PR",
      url: "u",
      branch: "old-branch",
      local_path: sb.demoRepo,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const feedbackJson = JSON.stringify({
    state: "OPEN",
    isDraft: false,
    headRefOid: "sha1",
    headRefName: "feature",
    reviews: [
      {
        author: { login: "colleague" },
        state: "CHANGES_REQUESTED",
        body: "",
        submittedAt: "2026-07-19T10:00:00Z",
      },
    ],
  });
  const before = sb.claudeCalls();
  const r = sb.run(["sync"], { GH_PR_MINE_JSON: feedbackJson });
  expect(r.code).toBe(0);
  const e = sb.state()["mine:testorg/demo#7"];
  expect(e.status).toBe("changes-requested");
  expect(e.review_at).toBe("2026-07-19T10:00:00Z");
  expect(e.reviewer).toBe("colleague");
  expect(e.branch).toBe("feature"); // refreshed from gh
  expect(sb.claudeCalls()).toBe(before);

  // the same review never re-triggers: a second sync is a no-op
  const r2 = sb.run(["sync"], { GH_PR_MINE_JSON: feedbackJson });
  expect(r2.code).toBe(0);
  expect(sb.state()["mine:testorg/demo#7"].review_at).toBe(
    "2026-07-19T10:00:00Z",
  );
});

test("sync: mine entry — draft flag refreshed, merged goes done, gh failure leaves as-is", () => {
  const sb = makeSandbox();
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      flags: ["draft"],
      local_path: sb.demoRepo,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  // draft flipped to ready-for-review
  let r = sb.run(["sync"]); // default GH_PR_MINE_JSON: open, not draft
  expect(r.code).toBe(0);
  expect(sb.state()["mine:testorg/demo#7"].flags).toEqual([]);

  // gh failure: untouched
  r = sb.run(["sync"], { GH_PR_VIEW_FAIL: "1" });
  expect(r.code).toBe(0);
  expect(sb.state()["mine:testorg/demo#7"].status).toBe("open");

  // merged: done
  r = sb.run(["sync"], {
    GH_PR_MINE_JSON: JSON.stringify({ state: "MERGED", reviews: [] }),
  });
  expect(r.code).toBe(0);
  const e = sb.state()["mine:testorg/demo#7"];
  expect(e.status).toBe("done");
  expect(e.done_reason).toBe("merged");
});
