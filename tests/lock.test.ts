import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock";

const noop = () => {};

test("acquire writes our pid; live lock is not stolen; release frees it", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rv-lock-")), "lock");
  const release = acquireLock(dir, noop);
  expect(release).not.toBeNull();
  expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
  expect(acquireLock(dir, noop)).toBeNull(); // our own pid is alive
  release!();
  const again = acquireLock(dir, noop);
  expect(again).not.toBeNull();
  again!();
});

test("stale lock (dead pid) is taken over", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rv-lock-")), "lock");
  const child = Bun.spawn(["true"]);
  await child.exited; // child.pid is now guaranteed dead
  mkdirSync(dir);
  writeFileSync(join(dir, "pid"), String(child.pid));
  const release = acquireLock(dir, noop);
  expect(release).not.toBeNull();
  expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
  release!();
});
