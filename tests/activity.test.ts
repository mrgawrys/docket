import { expect, test } from "bun:test";
import { makeFeed, runLogged, splitLines, windowLines } from "../src/activity";

test("splitLines: only terminated lines are complete, CR is stripped", () => {
  expect(splitLines("a\r\nb\nc")).toEqual({ lines: ["a", "b"], rest: "c" });
  expect(splitLines("")).toEqual({ lines: [], rest: "" });
  expect(splitLines("x\n")).toEqual({ lines: ["x"], rest: "" });
});

test("windowLines: scroll 0 follows the tail, and the top is the limit", () => {
  const lines = ["1", "2", "3", "4", "5"];
  expect(windowLines(lines, 2, 0)).toEqual({ lines: ["4", "5"], maxScroll: 3 });
  expect(windowLines(lines, 2, 1).lines).toEqual(["3", "4"]);
  expect(windowLines(lines, 2, 99).lines).toEqual(["1", "2"]);
  expect(windowLines([], 3, 0)).toEqual({ lines: [], maxScroll: 0 });
});

test("feed: keeps the newest lines under the cap and wakes subscribers", () => {
  const feed = makeFeed(3);
  let woke = 0;
  const off = feed.subscribe(() => {
    woke++;
  });
  for (const l of ["a", "b", "c", "d"]) feed.push(l);
  expect([...feed.lines]).toEqual(["b", "c", "d"]);
  feed.setJob({ name: "poll", verb: "polling", running: true });
  expect(woke).toBe(5);
  off();
  feed.push("e");
  expect(woke).toBe(5);
});

test("runLogged: both streams arrive as lines, in order within a stream", async () => {
  const got: string[] = [];
  const code = await runLogged(
    ["/bin/sh", "-c", 'printf "one\\ntwo"; echo err >&2; exit 3'],
    (l) => got.push(l),
  );
  expect(code).toBe(3);
  expect(got.filter((l) => l !== "err")).toEqual(["one", "two"]);
  expect(got).toContain("err");
});
