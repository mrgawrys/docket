import { mkdtempSync } from "node:fs";
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
import { claudeWizardPrompt, runClaudeWizard } from "../src/wizard/claude";
import type { WizardOutcome } from "../src/wizard/flow";
import {
  firstRunAction,
  offerFirstRun,
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

test("a wizard that writes a config continues into the command with it", async () => {
  const f = fakes();
  const r = await resolveConfig(
    freshPaths(),
    true,
    deps(f, [missing(), VALID]),
  );
  expect(f.offers).toBe(1);
  expect(r).toEqual({ cfg: VALID });
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
  expect(r).toEqual({ cfg: STARTER });
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
