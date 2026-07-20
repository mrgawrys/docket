import { expect, test } from "bun:test";
import { stateCounts } from "../src/status";
import { makeSandbox } from "./harness";

test("stateCounts groups and sorts statuses", () => {
  expect(stateCounts({})).toBe("empty");
  expect(
    stateCounts({
      "a#1": { status: "ready", updated_at: "t" },
      "a#2": { status: "ready", updated_at: "t" },
      "a#3": { status: "failed", updated_at: "t" },
    }),
  ).toBe("1 failed, 2 ready");
});

test("log command prints the last n lines", () => {
  const sb = makeSandbox();
  sb.run(["poll", "--dry-run"]); // generates a few log lines
  sb.run(["poll", "--dry-run"]);
  const all = sb.run(["log", "50"]).out.trimEnd().split("\n");
  const two = sb.run(["log", "2"]).out.trimEnd().split("\n");
  expect(two).toHaveLength(2);
  expect(two).toEqual(all.slice(-2));
  expect(sb.run(["log"]).code).toBe(0); // default 20
});

test("status exits 0 and shows state counts even without launchd", () => {
  const sb = makeSandbox();
  sb.run(["poll", "--dry-run"]);
  const r = sb.run(["status"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("poller:");
  expect(r.out).toContain("state:");
});
