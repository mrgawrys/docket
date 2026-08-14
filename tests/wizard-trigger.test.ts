import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import {
  type Config,
  ConfigError,
  type Paths,
  paths as resolvePaths,
} from "../src/config";
import type { StepResult } from "../src/reviewtask";
import { claudeWizardPrompt, runClaudeWizard } from "../src/wizard/claude";
import type { WizardOutcome } from "../src/wizard/flow";
import {
  type PromptOptions,
  firstRunAction,
  offerFirstRun,
  promptCommand,
  resolveConfig,
} from "../src/wizard/trigger";

const VALID: Config = { orgs: ["acme"], repos: { "acme/thing": "/tmp/thing" } };
const STARTER: Config = {
  orgs: ["your-github-org"],
  repos: { "your-github-org/some-repo": "/absolute/path/to/your/local/clone" },
};
const missing = () => new ConfigError("no config at /x/config.json", true);

function freshPaths(): Paths {
  const root = mkdtempSync(join(tmpdir(), "dk-trigger-"));
  return resolvePaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_STATE_HOME: join(root, "st"),
  } as NodeJS.ProcessEnv);
}

// ------------------------------------------------------------- the decision --

test("no config offers the wizard on a TTY and seeds-and-fails headlessly", () => {
  expect(firstRunAction(missing(), true)).toBe("offer-wizard");
  expect(firstRunAction(missing(), false)).toBe("seed-and-fail");
});

test("a config still holding starter placeholders offers the wizard on a TTY only", () => {
  expect(firstRunAction(STARTER, true)).toBe("offer-wizard");
  expect(firstRunAction(STARTER, false)).toBe("proceed");
});

test("a usable config proceeds, TTY or not", () => {
  expect(firstRunAction(VALID, true)).toBe("proceed");
  expect(firstRunAction(VALID, false)).toBe("proceed");
});

test("a config that exists but is wrong is reported, never seeded over", () => {
  const broken = new ConfigError("invalid JSON in /x/config.json: oops");
  expect(firstRunAction(broken, true)).toBe("report-error");
  expect(firstRunAction(broken, false)).toBe("report-error");
});

// --------------------------------------------------------- what withCtx does --

interface Fakes {
  offers: number;
  seeds: number;
  errors: string[];
}

function fakes(): Fakes {
  return { offers: 0, seeds: 0, errors: [] };
}

// loadConfig, staged: each call answers with the next state of the config.
const staged = (states: Array<Config | ConfigError>) => {
  let i = 0;
  return async (): Promise<Config> => {
    const s = states[Math.min(i++, states.length - 1)]!;
    if (s instanceof ConfigError) throw s;
    return s;
  };
};

const deps = (f: Fakes, states: Array<Config | ConfigError>, offer = true) => ({
  load: staged(states),
  seed: async () => {
    f.seeds++;
    return "seeded message";
  },
  offer: async () => {
    f.offers++;
    return (offer ? "completed" : "declined") as WizardOutcome | "declined";
  },
  report: (msg: string) => f.errors.push(msg),
});

test("a wizard that writes a config continues into the command with it, flagged", async () => {
  const f = fakes();
  const r = await resolveConfig(
    freshPaths(),
    true,
    deps(f, [missing(), VALID]),
  );
  expect(f.offers).toBe(1);
  expect(r).toEqual({ cfg: VALID, wizardRan: true });
  expect(f.seeds).toBe(0);
});

test("declining with no config does exactly what a headless run does", async () => {
  const f = fakes();
  const r = await resolveConfig(
    freshPaths(),
    true,
    deps(f, [missing()], false),
  );
  expect(r).toEqual({ code: 1 });
  expect(f.seeds).toBe(1);
  expect(f.errors).toEqual(["seeded message"]);
});

test("declining a placeholder config runs the command with it as it is", async () => {
  const f = fakes();
  const r = await resolveConfig(freshPaths(), true, deps(f, [STARTER], false));
  // still flagged: the offer path ran, so setup was just offered and turned
  // down — `docket prompt` has nothing sensible to ask on top of that
  expect(r).toEqual({ cfg: STARTER, wizardRan: true });
  expect(f.seeds).toBe(0);
});

test("a headless run never reaches the offer", async () => {
  const f = fakes();
  expect(
    await resolveConfig(freshPaths(), false, deps(f, [missing()])),
  ).toEqual({ code: 1 });
  expect(await resolveConfig(freshPaths(), false, deps(f, [STARTER]))).toEqual({
    cfg: STARTER,
  });
  expect(f.offers).toBe(0);
  expect(f.seeds).toBe(1);
});

test("a wizard that leaves a broken config reports that, and seeds nothing over it", async () => {
  const f = fakes();
  const broken = new ConfigError("invalid JSON in /x/config.json: oops");
  const r = await resolveConfig(
    freshPaths(),
    true,
    deps(f, [missing(), broken]),
  );
  expect(r).toEqual({ code: 1 });
  expect(f.seeds).toBe(0);
  expect(f.errors).toEqual([broken.message]);
});

// ---------------------------------------------------------------- the offer --

interface Offered {
  outcome: WizardOutcome | "declined";
  out: string;
  ran: string[];
}

async function offer(
  script: string[],
  outcomes: Partial<Record<"native" | "claude", WizardOutcome>> = {},
  reason: "no-config" | "placeholders" = "no-config",
): Promise<Offered> {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const ran: string[] = [];
  // Answers arrive as they would from a person: the next line is typed only
  // once the question asking for it has been (and its readline closed).
  const answer = () => {
    const next = script.shift();
    if (next !== undefined) input.write(`${next}\n`);
    else input.end();
  };
  answer();
  const outcome = await offerFirstRun({
    paths: freshPaths(),
    reason,
    input,
    output,
    runNative: async () => {
      ran.push("native");
      answer();
      return outcomes.native ?? "completed";
    },
    runClaude: async () => {
      ran.push("claude");
      answer();
      return outcomes.claude ?? "completed";
    },
  });
  return { outcome, out: chunks.join(""), ran };
}

test("the offer runs the wizard the user picked", async () => {
  expect((await offer(["1"])).ran).toEqual(["native"]);
  expect((await offer(["2"])).ran).toEqual(["claude"]);
});

test("quitting the offer runs no wizard", async () => {
  const r = await offer(["3"]);
  expect(r.ran).toEqual([]);
  expect(r.outcome).toBe("declined");
});

test("closed stdin declines the offer instead of hanging", async () => {
  const r = await offer([]);
  expect(r.ran).toEqual([]);
  expect(r.outcome).toBe("declined");
});

test("a native wizard that comes up short offers the claude one as the fallback", async () => {
  const r = await offer(["1", "y"], { native: "came-up-short" });
  expect(r.ran).toEqual(["native", "claude"]);
  expect(r.outcome).toBe("completed");
});

test("the came-up-short fallback can be turned down", async () => {
  const r = await offer(["1", "n"], { native: "came-up-short" });
  expect(r.ran).toEqual(["native"]);
  expect(r.outcome).toBe("came-up-short");
});

test("an aborted native wizard is a decline, not a fallback", async () => {
  const r = await offer(["1"], { native: "aborted" });
  expect(r.ran).toEqual(["native"]);
  expect(r.outcome).toBe("aborted");
});

test("the placeholder offer says the config is the untouched starter", async () => {
  const r = await offer(["3"], {}, "placeholders");
  expect(r.out).toMatch(/starter/i);
});

// -------------------------------------------------------- docket prompt --

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

// -------------------------------------------------------- the claude wizard --

test("the wizard prompt carries the real config path and no sandbox rules", () => {
  const p = resolvePaths({
    DOCKET_CONFIG_DIR: "/c/docket",
  } as NodeJS.ProcessEnv);
  const prompt = claudeWizardPrompt(p, "docket doctor");
  expect(prompt).toContain("/c/docket/config.json");
  expect(prompt).toContain("docket doctor");
  expect(prompt).not.toContain("{{");
  expect(prompt.toLowerCase()).not.toContain("sandbox");
  // the behaviors the prototype validated
  expect(prompt).toContain("gh auth token -u");
  expect(prompt).toContain("gh auth switch");
  // a `find -type d -name .git` misses linked worktrees, which carry a file
  expect(prompt).not.toContain("-type d -name .git");
});

test("the claude wizard reports back whether a config actually appeared", async () => {
  const p = freshPaths();
  const out = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  expect(
    await runClaudeWizard({ paths: p, output: out, session: async () => 0 }),
  ).toBe("came-up-short");
  expect(
    await runClaudeWizard({
      paths: p,
      output: out,
      session: async () => {
        await Bun.write(
          p.configPath,
          JSON.stringify({ orgs: ["acme"], repos: {} }),
        );
        return 0;
      },
    }),
  ).toBe("completed");
});

test("the claude wizard runs the claude an existing config points at", async () => {
  // the placeholders trigger reaches here with a real config on disk, which
  // may name a different install or carry env every claude run needs
  const p = freshPaths();
  const out = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  await Bun.write(
    p.configPath,
    JSON.stringify({
      orgs: ["your-github-org"],
      repos: {},
      claude_bin: "/x/claude",
      claude_env: { DOCKET_TEST: "1" },
      claude_config_dir: "/x/home",
    }),
  );
  let seen: { bin: string; env: Record<string, string> } | undefined;
  await runClaudeWizard({
    paths: p,
    env: { PATH: "/usr/bin", EMPTY: undefined } as NodeJS.ProcessEnv,
    output: out,
    session: async (bin, _prompt, env) => {
      seen = { bin, env };
      return 0;
    },
  });
  expect(seen?.bin).toBe("/x/claude");
  expect(seen?.env.DOCKET_TEST).toBe("1");
  expect(seen?.env.CLAUDE_CONFIG_DIR).toBe("/x/home");
  expect(seen?.env.PATH).toBe("/usr/bin"); // the inherited environment survives
  expect("EMPTY" in (seen?.env ?? {})).toBe(false); // Bun.spawn rejects holes
});

test("a claude binary that will not start is reported, not thrown", async () => {
  const p = freshPaths();
  const chunks: string[] = [];
  const out = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  const outcome = await runClaudeWizard({
    paths: p,
    output: out,
    session: async () => {
      throw new Error("ENOENT");
    },
  });
  expect(outcome).toBe("came-up-short");
  expect(chunks.join("")).toContain("claude");
});
