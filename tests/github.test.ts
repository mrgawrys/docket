import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ghUser,
  myTeams,
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
