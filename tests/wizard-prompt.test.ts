import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import { type Paths, paths as resolvePaths } from "../src/config";
import type { StepResult } from "../src/reviewtask";
import { type PromptOptions, promptCommand } from "../src/wizard/prompt";

function freshPaths(): Paths {
  const root = mkdtempSync(join(tmpdir(), "dk-prompt-"));
  return resolvePaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_STATE_HOME: join(root, "st"),
  } as NodeJS.ProcessEnv);
}

interface Prompted {
  code: number;
  out: string;
  text: string; // the config file after the command
  stepRuns: number;
}

async function prompted(
  cfgOnDisk: unknown,
  stepResult: StepResult | (() => Promise<StepResult>),
  resolve?: PromptOptions["resolve"],
): Promise<Prompted> {
  const p = freshPaths();
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.configPath, JSON.stringify(cfgOnDisk));
  const input = new PassThrough();
  input.end();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  let stepRuns = 0;
  const code = await promptCommand({
    paths: p,
    env: { HOME: "/home/none" } as NodeJS.ProcessEnv,
    input,
    output,
    resolve,
    step: async () => {
      stepRuns++;
      return typeof stepResult === "function" ? stepResult() : stepResult;
    },
  });
  return {
    code,
    out: chunks.join(""),
    text: readFileSync(p.configPath, "utf8"),
    stepRuns,
  };
}

const ON_DISK = {
  orgs: ["acme"],
  repos: { "acme/thing": "/tmp/thing" },
  // a pinned account whose token nothing here can resolve — prompt must not care
  gh_account: "gone-stale",
  review_prompt: "Old custom task.",
  extra_allowed_tools: ["Bash(rg:*)"],
};

test("picking the default removes review_prompt and leaves the extras untouched", async () => {
  const r = await prompted(ON_DISK, { task: "default" });
  expect(r.code).toBe(0);
  const cfg = JSON.parse(r.text);
  expect("review_prompt" in cfg).toBe(false);
  expect(cfg.extra_allowed_tools).toEqual(["Bash(rg:*)"]);
  expect(cfg.gh_account).toBe("gone-stale");
});

test("a custom result writes both keys through writeConfigText", async () => {
  const r = await prompted(ON_DISK, {
    task: "custom",
    review_prompt: "New task.",
    extra_allowed_tools: ["Bash(rg:*)", "Bash(node:*)"],
  });
  expect(r.code).toBe(0);
  const cfg = JSON.parse(r.text);
  expect(cfg.review_prompt).toBe("New task.");
  expect(cfg.extra_allowed_tools).toEqual(["Bash(rg:*)", "Bash(node:*)"]);
  // the wizard's exact serialization
  expect(r.text.endsWith("}\n")).toBe(true);
  expect(r.text).toContain('  "orgs"');
});

test("aborting writes nothing and exits 1 — the file is byte-identical", async () => {
  const before = JSON.stringify(ON_DISK);
  const r = await prompted(ON_DISK, "aborted");
  expect(r.code).toBe(1);
  expect(r.text).toBe(before);
  expect(r.out).toContain("nothing was written");
});

test("a result that changes nothing skips the write entirely", async () => {
  const cfgOnDisk = { orgs: ["acme"], repos: {} }; // default task, no extras
  const r = await prompted(cfgOnDisk, { task: "default" });
  expect(r.code).toBe(0);
  // an actual write would reserialize with indentation
  expect(r.text).toBe(JSON.stringify(cfgOnDisk));
  expect(r.out).toContain("nothing changed");
});

test("keeping a custom task unchanged with no new extras also skips the write", async () => {
  const before = JSON.stringify(ON_DISK);
  const r = await prompted(ON_DISK, {
    task: "custom",
    review_prompt: "Old custom task.",
  });
  expect(r.code).toBe(0);
  expect(r.text).toBe(before);
});

test("when the wizard just ran, the step is not asked a second time", async () => {
  const r = await prompted(ON_DISK, { task: "default" }, async () => ({
    cfg: { orgs: [], repos: {} },
    wizardRan: true,
  }));
  expect(r.code).toBe(0);
  expect(r.stepRuns).toBe(0);
  expect(r.text).toBe(JSON.stringify(ON_DISK));
});

test("the command works over piped stdin with the real step", async () => {
  // the real dialogue, driven line by line: "1" picks the default. No editor
  // and no derivation subprocess are involved on this path.
  const p = freshPaths();
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.configPath, JSON.stringify(ON_DISK));
  const input = new PassThrough();
  input.write("1\n");
  input.end();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const code = await promptCommand({
    paths: p,
    env: { HOME: "/home/none", EDITOR: "" } as NodeJS.ProcessEnv,
    input,
    output,
  });
  expect(code).toBe(0);
  const cfg = JSON.parse(readFileSync(p.configPath, "utf8"));
  expect("review_prompt" in cfg).toBe(false);
  expect(chunks.join("")).toContain("current task:");
});
