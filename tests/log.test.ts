import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogger } from "../src/log";

test("logger appends timestamped lines", () => {
  const p = join(mkdtempSync(join(tmpdir(), "rv-log-")), "x.log");
  const log = makeLogger(p);
  log("hello");
  log("world");
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hello$/);
});
