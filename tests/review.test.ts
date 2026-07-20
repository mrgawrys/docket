import { expect, test } from "bun:test";
import { makeSandbox } from "./harness";

test("review + retry command family", () => {
  const sb = makeSandbox();

  // scenario 7: force-review with a note
  let r = sb.run(["review", "testorg/demo#42", "author pushed changes, focus on the delta"]);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#42"].status).toBe("ready");
  expect(sb.state()["testorg/demo#42"].session_id).toBe("sess-1234");
  expect(sb.state()["testorg/demo#42"].title).toBe("Manual PR");
  expect(sb.promptCapture()).toContain("worktree for PR #42 at .worktrees/pr-42");
  expect(sb.promptCapture()).toContain("/code-review 42");
  expect(sb.promptCapture()).toContain("focus on the delta");

  // scenario 8: URL input normalizes; garbage is rejected
  r = sb.run(["review", "https://github.com/testorg/demo/pull/43"]);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#43"].status).toBe("ready");
  expect(Object.keys(sb.state()).some((k) => k.startsWith("http"))).toBe(false);
  r = sb.run(["review", "total garbage"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("cannot parse");

  // scenario 4 via review: claude failure -> failed + error recorded
  r = sb.run(["review", "testorg/demo#50"], { CLAUDE_FAIL: "1" });
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#50"].status).toBe("failed");
  expect(sb.state()["testorg/demo#50"].error).toBeTruthy();

  // scenario 5: retry flips failed -> ready; unknown key exits non-zero
  r = sb.run(["retry", "testorg/demo#50"]);
  expect(r.code).toBe(0);
  expect(sb.state()["testorg/demo#50"].status).toBe("ready");
  expect(sb.state()["testorg/demo#50"].session_id).toBe("sess-1234");
  expect(sb.run(["retry", "nope/nope#1"]).code).not.toBe(0);
});

test("scenario 9: missing config errors, pointing at config.example.json", () => {
  const sb = makeSandbox();
  const r = sb.run(["review", "testorg/demo#1"], { AUTO_REVIEW_CONFIG_DIR: sb.tmp + "/nonexistent" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("config.example.json");
});

test("scenario 10: claude_config_dir reaches claude as CLAUDE_CONFIG_DIR", () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo },
    claude_config_dir: sb.tmp + "/claude-home",
  });
  expect(sb.run(["review", "testorg/demo#44"]).code).toBe(0);
  expect(sb.cfgdirCapture()).toBe(sb.tmp + "/claude-home");
});

test("scenario 11: claude_bin from config used when CLAUDE_BIN unset", () => {
  const sb = makeSandbox();
  const shim2 = sb.env.CLAUDE_BIN + "2";
  Bun.spawnSync(["cp", sb.env.CLAUDE_BIN!, shim2]);
  sb.writeConfig({ orgs: ["testorg"], repos: { "testorg/demo": sb.demoRepo }, claude_bin: shim2 });
  const before = sb.claudeCalls();
  expect(sb.run(["review", "testorg/demo#45"], { CLAUDE_BIN: undefined }).code).toBe(0);
  expect(sb.claudeCalls()).toBe(before + 1); // the copied shim appends to the same CLAUDE_CALLS file
  expect(sb.state()["testorg/demo#45"].status).toBe("ready");
});

test("skipped: unmapped repo -> status skipped, no local_path (scenario 12 core)", () => {
  const sb = makeSandbox();
  sb.writeConfig({ orgs: ["testorg"], repos: {} });
  expect(sb.run(["review", "testorg/demo#46"]).code).toBe(0);
  const e = sb.state()["testorg/demo#46"];
  expect(e.status).toBe("skipped");
  expect("local_path" in e).toBe(false);
});
