import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ghUser, prView, searchReviewRequests, type GhCtx } from "../src/github";
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
});

test("ghUser returns the login", () => {
  expect(ghUser(ctx)).toBe("testuser");
});

test("searchReviewRequests returns non-draft candidates only", () => {
  const c = searchReviewRequests(ctx, "testorg");
  expect(c).toEqual([
    { repo: "testorg/demo", number: 7, title: "Demo PR", url: "https://example.test/pr/7" },
  ]);
});

test("prView parses JSON; returns null on gh failure", () => {
  const info = prView<{ state: string }>(ctx, "testorg/demo", "7", "state,latestReviews,reviewRequests,commits");
  expect(info).toEqual({ state: "OPEN" });
  process.env.GH_PR_VIEW_FAIL = "1";
  expect(prView(ctx, "testorg/demo", "7", "state,latestReviews,reviewRequests,commits")).toBeNull();
});
