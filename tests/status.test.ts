import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("log command clamps a negative n to the default instead of slicing the head", () => {
  const sb = makeSandbox();
  sb.run(["poll", "--dry-run"]);
  sb.run(["poll", "--dry-run"]);
  const negative = sb.run(["log", "-1"]).out;
  const zero = sb.run(["log", "0"]).out;
  const def = sb.run(["log"]).out;
  expect(negative).toBe(def);
  expect(zero).toBe(def);
});

test("status exits 0 and shows state counts even without launchd", () => {
  const sb = makeSandbox();
  sb.run(["poll", "--dry-run"]);
  const r = sb.run(["status"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("poller:");
  expect(r.out).toContain("state:");
});

test("watch <pr> renders that PR's run log", async () => {
  const sb = makeSandbox();
  mkdirSync(join(sb.stateDir, "runs"), { recursive: true });
  writeFileSync(
    join(sb.stateDir, "runs", "testorg-demo-7.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git fetch origin" } }] },
    }) + "\n" + JSON.stringify({ type: "result", subtype: "success" }) + "\n",
  );
  const proc = sb.runAsync(["watch", "testorg/demo#7"]);
  await Bun.sleep(2000); // follower prints existing content on startup
  proc.kill();
  const out = await new Response(proc.stdout).text();
  expect(out).toContain("→ Bash: git fetch origin");
  expect(out).toContain("✔ review finished");
});

test("watch with a garbage key errors", () => {
  const sb = makeSandbox();
  const r = sb.run(["watch", "total garbage"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("cannot parse");
});
