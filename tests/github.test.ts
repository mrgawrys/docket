import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ghUser,
  myTeams,
  prMineInfo,
  prView,
  reviewRequesters,
  searchReviewRequests,
  type GhCtx,
} from "../src/github";
import { makeSandbox } from "./harness";

const sb = makeSandbox();
const ctx: GhCtx = {
  gh: sb.env.GH_BIN!,
  log: () => {},
  logPath: join(sb.tmp, "gh.log"),
  env: process.env as Record<string, string>,
};

afterEach(() => {
  delete process.env.GH_PR_VIEW_FAIL;
  delete process.env.GH_PR_STATUS_JSON;
  delete process.env.GH_REVIEW_REQUESTS_JSON;
  delete process.env.GH_USER_TEAMS;
  delete process.env.GH_TEAMS_FAIL;
  delete process.env.GH_PR_MINE_JSON;
  delete process.env.GH_REVIEW_COMMENTS_JSON;
});

test("ghUser returns the login", () => {
  expect(ghUser(ctx)).toBe("testuser");
});

test("searchReviewRequests returns non-draft candidates only", () => {
  const c = searchReviewRequests(ctx, "testorg");
  expect(c).toEqual([
    {
      repo: "testorg/demo",
      number: 7,
      title: "Demo PR",
      url: "https://example.test/pr/7",
    },
  ]);
});

test("prView parses JSON; returns null on gh failure", () => {
  const info = prView<{ state: string }>(
    ctx,
    "testorg/demo",
    "7",
    "state,latestReviews,reviewRequests,commits",
  );
  expect(info).toEqual({ state: "OPEN" });
  process.env.GH_PR_VIEW_FAIL = "1";
  expect(
    prView(
      ctx,
      "testorg/demo",
      "7",
      "state,latestReviews,reviewRequests,commits",
    ),
  ).toBeNull();
});

test("reviewRequesters splits users and teams; null on gh failure", () => {
  process.env.GH_REVIEW_REQUESTS_JSON = JSON.stringify({
    reviewRequests: [
      { __typename: "User", login: "alice" },
      { __typename: "Team", name: "Some Team", slug: "acme/some-team" },
      { __typename: "Team", name: "Other", slug: "acme/other-team" },
    ],
  });
  expect(reviewRequesters(ctx, "testorg/demo", "7")).toEqual({
    users: ["alice"],
    teams: ["acme/some-team", "acme/other-team"],
  });
  process.env.GH_PR_VIEW_FAIL = "1";
  expect(reviewRequesters(ctx, "testorg/demo", "7")).toBeNull();
});

test("myTeams parses org/slug lines; empty when none; null on failure", () => {
  process.env.GH_USER_TEAMS = "acme/some-team\nacme/dev";
  expect(myTeams(ctx)).toEqual(["acme/some-team", "acme/dev"]);
  delete process.env.GH_USER_TEAMS;
  expect(myTeams(ctx)).toEqual([]);
  process.env.GH_TEAMS_FAIL = "1";
  expect(myTeams(ctx)).toBeNull();
});

test("prMineInfo counts inline comments only for blank approvals", () => {
  const review = (id: string, state: string, body: string) => ({
    id,
    author: { login: "colleague" },
    state,
    body,
    submittedAt: "2026-09-28T12:56:27Z",
  });
  process.env.GH_REVIEW_COMMENTS_JSON = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [
              { id: "PRR_a", comments: { totalCount: 3 } },
              { id: "PRR_b", comments: { totalCount: 2 } },
            ],
          },
        },
      },
    },
  });
  const mine = (reviews: unknown[]) => {
    process.env.GH_PR_MINE_JSON = JSON.stringify({
      state: "OPEN",
      isDraft: false,
      headRefOid: "sha",
      headRefName: "feature",
      reviews,
    });
    return prMineInfo(ctx, "testorg/demo", "7")?.reviews.map((r) => r.comments);
  };
  expect(
    mine([review("PRR_a", "APPROVED", ""), review("PRR_b", "COMMENTED", "x")]),
  ).toEqual([3, 2]);
  // no blank approval: the second call is skipped, counts stay 0
  expect(mine([review("PRR_b", "COMMENTED", "x")])).toEqual([0]);
});
