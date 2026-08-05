import { expect, test } from "bun:test";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function cli(...args: string[]) {
  const p = Bun.spawnSync(["bun", MAIN, ...args]);
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

test("help prints usage and exits 0", () => {
  const r = cli("help");
  expect(r.code).toBe(0);
  expect(r.out).toContain("docket poll");
  expect(r.out).toContain("docket on | off");
});

test("unknown subcommand exits 1", () => {
  const r = cli("frobnicate");
  expect(r.code).toBe(1);
  expect(r.err).toContain("unknown subcommand: frobnicate");
});
