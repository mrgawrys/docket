import { expect, test } from "bun:test";
import { parseReport } from "../src/report";
import { makeSandbox } from "./harness";

const KEY = "mine:testorg/demo#7";

const approved = JSON.stringify({
  state: "OPEN",
  isDraft: false,
  headRefOid: "sha1",
  headRefName: "feature",
  reviews: [
    {
      author: { login: "colleague" },
      state: "APPROVED",
      body: "",
      submittedAt: "2026-07-19T10:00:00Z",
    },
  ],
});

const mineEntry = (status: string) => ({
  status,
  title: "My PR",
  url: "u",
  branch: "feature",
  review_at: "2026-08-01T00:00:00Z",
  summary: { headline: "old" },
  updated_at: "2026-08-01T00:00:00Z",
});

test("parseReport: flags in both spellings, validated like the old json block", () => {
  expect(
    parseReport([
      "--headline",
      "  two  fixes ",
      "--addressed=2",
      "--deferred",
      "0",
    ]),
  ).toEqual({ headline: "two fixes", addressed: 2, deferred: 0 });
  expect(parseReport(["--risk", "HIGH"])).toEqual({ risk: "high" });
});

test("parseReport: every rejection names what to fix", () => {
  expect(parseReport([])).toEqual({
    error: expect.stringContaining("nothing to report"),
  });
  expect(parseReport(["--severity", "x"])).toEqual({
    error: "unknown flag: --severity",
  });
  expect(parseReport(["--headline"])).toEqual({
    error: "--headline needs a value",
  });
  expect(parseReport(["--issues", "many"])).toEqual({
    error: "bad value for --issues: NaN",
  });
  expect(parseReport(["--risk", "huge"])).toEqual({
    error: "bad value for --risk: huge",
  });
});

test("report: replaces the summary; a bad call leaves state untouched", () => {
  const sb = makeSandbox();
  sb.writeState({ [KEY]: mineEntry("reviewing") });
  let r = sb.run(["report", KEY, "--headline", "fixed it", "--addressed", "1"]);
  expect(r.code).toBe(0);
  expect(sb.state()[KEY].summary).toEqual({
    headline: "fixed it",
    addressed: 1,
  });

  r = sb.run(["report", KEY, "--addressed", "-1"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("bad value for --addressed");
  expect(sb.state()[KEY].summary).toEqual({
    headline: "fixed it",
    addressed: 1,
  });

  r = sb.run(["report", "mine:testorg/demo#99", "--headline", "x"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("unknown key");
});

test("handled: a ready row lands on the reviewers' standing", () => {
  const sb = makeSandbox();
  sb.writeState({ [KEY]: mineEntry("ready") });
  const r = sb.run(["handled", KEY], { GH_PR_MINE_JSON: approved });
  expect(r.code).toBe(0);
  expect(r.out).toContain("now approved");
  const e = sb.state()[KEY];
  expect(e.status).toBe("approved");
  expect(e.reviewer).toBe("colleague");
});

test("handled: GitHub unreadable — the row is open, the call still succeeds", () => {
  const sb = makeSandbox();
  sb.writeState({ [KEY]: mineEntry("ready") });
  const r = sb.run(["handled", KEY], { GH_PR_VIEW_FAIL: "1" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("next poll");
  expect(sb.state()[KEY].status).toBe("open");
});

test("handled: refuses anything but a ready mine row, state untouched", () => {
  const sb = makeSandbox();
  sb.writeState({
    [KEY]: mineEntry("reviewing"),
    "testorg/demo#8": { ...mineEntry("ready") },
  });
  let r = sb.run(["handled", KEY]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("is reviewing, not ready");
  expect(sb.state()[KEY].status).toBe("reviewing");

  r = sb.run(["handled", "testorg/demo#8"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("not one of your PRs");
  expect(sb.state()["testorg/demo#8"].status).toBe("ready");
});
