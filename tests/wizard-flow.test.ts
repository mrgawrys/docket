import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import {
  type Config,
  type Paths,
  loadConfig,
  paths as resolvePaths,
  placeholderEntries,
} from "../src/config";
import type { StepResult } from "../src/reviewtask";
import { type WizardOutcome, runNativeWizard } from "../src/wizard/flow";
import type { ReviewTaskOptions } from "../src/wizard/reviewtask";
import { type Sandbox, makeSandbox } from "./harness";

const TWO_ACCOUNTS = [
  "github.com",
  "  ✓ Logged in to github.com account mrgawrys (keyring)",
  "  - Active account: true",
  "  ✓ Logged in to github.com account mrgawrys-work (keyring)",
  "  - Active account: false",
].join("\n");

const ONE_ACCOUNT = [
  "github.com",
  "  ✓ Logged in to github.com account mrgawrys (keyring)",
  "  - Active account: true",
].join("\n");

// A sandbox with no config yet — the state the first-run wizard runs in.
function fresh(): Sandbox {
  const sb = makeSandbox();
  rmSync(join(sb.configDir, "config.json"));
  return sb;
}

// A real clone, so the scan's default getOrigin (a git spawn) is what runs.
function mkClone(dir: string, origin: string): string {
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) =>
    Bun.spawnSync(["git", "-C", dir, ...a], {
      env: process.env as Record<string, string>,
    });
  g("init", "-q");
  g("remote", "add", "origin", origin);
  return dir;
}

interface Driven {
  outcome: WizardOutcome;
  out: string;
  doctorRuns: number;
  configAtDoctor: string | null;
  configPath: string;
  // what the flow handed the review-task step, when it reached it
  stepOptions: ReviewTaskOptions | undefined;
  // whatever the wizard wrote — read loosely, like harness.state()
  config(): Record<string, any>;
}

async function drive(
  sb: Sandbox,
  script: string[],
  extraEnv: Record<string, string> = {},
  override?: Paths,
  // the step's dialogue is tests/wizard-reviewtask.test.ts's job; flow tests
  // inject its result and check what the wizard does with it
  stepResult: StepResult = { task: "default" },
): Promise<Driven> {
  const input = new PassThrough();
  for (const line of script) input.write(`${line}\n`);
  input.end();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const p = override ?? resolvePaths(sb.env);
  let doctorRuns = 0;
  let configAtDoctor: string | null = null;
  let stepOptions: ReviewTaskOptions | undefined;
  const outcome = await runNativeWizard({
    paths: p,
    env: { ...process.env, ...sb.env, ...extraEnv },
    input,
    output,
    runDoctor: async () => {
      doctorRuns++;
      configAtDoctor = readFileSync(p.configPath, "utf8");
      return 0;
    },
    reviewTask: async (o) => {
      stepOptions = o;
      return stepResult;
    },
  });
  return {
    outcome,
    out: chunks.join(""),
    doctorRuns,
    configAtDoctor,
    configPath: p.configPath,
    stepOptions,
    config: () => JSON.parse(readFileSync(p.configPath, "utf8")),
  };
}

// A home with two clones of the picked org under ~/Development.
function homeWithClones(): string {
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  mkClone(join(home, "Development", "thing"), "git@github.com:acme/thing.git");
  mkClone(
    join(home, "Development", "other"),
    "https://github.com/acme/other.git",
  );
  return home;
}

test("the wizard writes a config loadConfig accepts, with the picked account and the scanned clones", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: TWO_ACCOUNTS,
    GH_ORG_LIST: "acme\nbeta",
  });

  expect(r.outcome).toBe("completed");
  expect(r.config()).toEqual({
    orgs: ["acme"],
    repos: {
      "acme/thing": join(home, "Development", "thing"),
      "acme/other": join(home, "Development", "other"),
    },
    gh_account: "mrgawrys-work",
  });
  const cfg = await loadConfig(resolvePaths(sb.env));
  expect(placeholderEntries(cfg)).toEqual([]);
});

test("the account's own login is offered alongside the orgs gh lists, and can be picked", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  const mine = mkClone(
    join(home, "Development", "docket"),
    "git@github.com:mrgawrys/docket.git",
  );
  const r = await drive(sb, ["1", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme\nbeta",
  });
  expect(r.out).toContain("mrgawrys (your account)");
  expect(r.out).toContain("acme");
  expect(r.config().orgs).toEqual(["mrgawrys"]);
  expect(r.config().repos).toEqual({ "mrgawrys/docket": mine });
});

test("an empty gh org list still offers the login before falling back to typing", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  mkClone(
    join(home, "Development", "docket"),
    "git@github.com:mrgawrys/docket.git",
  );
  const r = await drive(sb, ["1", "beta", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "",
  });
  expect(r.out).toContain("mrgawrys (your account)");
  expect(r.config().orgs).toEqual(["mrgawrys", "beta"]);
});

test("the written config is 2-space indented and ends with a newline", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: TWO_ACCOUNTS,
    GH_ORG_LIST: "acme",
  });
  const text = readFileSync(r.configPath, "utf8");
  expect(text.startsWith('{\n  "orgs": [\n    "acme"\n  ]')).toBe(true);
  expect(text.endsWith("}\n")).toBe(true);
});

test("the wizard scopes gh to the chosen account by token and never runs gh auth switch", async () => {
  const sb = fresh();
  const home = homeWithClones();
  await drive(sb, ["2", "2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: TWO_ACCOUNTS,
    GH_ORG_LIST: "acme",
  });
  const calls = sb.ghCalls();
  expect(calls.some((c) => c.startsWith("auth switch"))).toBe(false);
  // gh caps the listing at 30 without --limit, and an org past the cap is
  // unselectable: the type-by-hand fallback only appears when gh listed none
  expect(calls).toContain("org list --limit 100 token=tok-mrgawrys-work");
});

test("a single gh account is used silently and writes no gh_account key", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect("gh_account" in r.config()).toBe(false);
  expect(r.config().orgs).toEqual(["acme"]);
});

test("doctor runs after the config is on disk", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.doctorRuns).toBe(1);
  expect(JSON.parse(r.configAtDoctor ?? "{}").orgs).toEqual(["acme"]);
});

test("an empty gh org list falls back to org names typed by hand", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["none", "acme, beta", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme", "beta"]);
});

test("a failed gh org list falls back to org names typed by hand", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["none", "acme", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST_FAIL: "1",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme"]);
  expect(r.out).toContain("gh could not list organizations: boom");
});

test("ending with no orgs writes nothing, so the next run offers setup again", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["none", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "",
  });
  expect(r.outcome).toBe("came-up-short");
  expect(existsSync(r.configPath)).toBe(false);
  expect(r.doctorRuns).toBe(0);
});

test("orgs with no repos mapped is still written — the poller works without them", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  mkdirSync(join(home, "Development"));
  const r = await drive(sb, ["2", "1", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("came-up-short-wrote");
  expect(existsSync(r.configPath)).toBe(true);
  expect(r.config()).toEqual({ orgs: ["acme"], repos: {} });
});

test("a projects root that does not exist skips the scan instead of failing", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  const r = await drive(sb, ["2", "/no/such/root", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.out).toContain("/no/such/root does not exist");
  expect(r.outcome).toBe("came-up-short-wrote");
  expect(r.config()).toEqual({ orgs: ["acme"], repos: {} });
});

test("repos added by hand are recorded and count as a real result", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  const clone = mkClone(join(home, "elsewhere"), "git@github.com:acme/x.git");
  const r = await drive(sb, ["2", "1", "acme/manual", clone, ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().repos).toEqual({ "acme/manual": clone });
});

test("declining every clone the scan found is a deliberate skip, not a shortfall", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "none", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().repos).toEqual({});
});

test("a second checkout of the same repo is collapsed, reported, and the clone wins", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  const clone = mkClone(
    join(home, "Development", "thing"),
    "git@github.com:acme/thing.git",
  );
  Bun.spawnSync([
    "git",
    "-C",
    clone,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  const worktree = join(home, "Development", "wt", "thing-pr-1");
  Bun.spawnSync([
    "git",
    "-C",
    clone,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
  ]);

  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.out).toContain("left out: 1 extra checkout(s)");
  expect(r.config().repos).toEqual({ "acme/thing": clone });
});

test("an out-of-range pick is re-asked rather than accepted", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["9", "3", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme\nbeta",
  });
  expect(r.out).toContain("not a valid choice");
  expect(r.config().orgs).toEqual(["beta"]);
});

test("stdin closing mid-question aborts without writing anything", async () => {
  const sb = fresh();
  const r = await drive(sb, [], {
    HOME: mkdtempSync(join(tmpdir(), "dk-home-")),
    GH_AUTH_STATUS_TEXT: TWO_ACCOUNTS,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("aborted");
  expect(existsSync(r.configPath)).toBe(false);
  expect(r.doctorRuns).toBe(0);
  expect(r.out).toContain("input ended");
});

test("gh not logged in comes up short without writing a config", async () => {
  const sb = fresh();
  const r = await drive(sb, [], {
    HOME: mkdtempSync(join(tmpdir(), "dk-home-")),
    GH_AUTH_STATUS_FAIL: "1",
  });
  expect(r.outcome).toBe("came-up-short");
  expect(r.out).toContain("gh auth login");
  expect(existsSync(r.configPath)).toBe(false);
});

test("a missing gh binary comes up short without writing a config", async () => {
  const sb = fresh();
  const r = await drive(sb, [], {
    HOME: mkdtempSync(join(tmpdir(), "dk-home-")),
    GH_BIN: join(sb.tmp, "no-such-gh"),
  });
  expect(r.outcome).toBe("came-up-short");
  expect(r.out).toContain("cli.github.com");
  expect(existsSync(r.configPath)).toBe(false);
});

test("a config with real orgs and repos is not overwritten without consent", async () => {
  const sb = makeSandbox(); // keeps its own config: orgs testorg, repos demo
  const before = readFileSync(join(sb.configDir, "config.json"), "utf8");
  const r = await drive(sb, ["n"], {
    HOME: mkdtempSync(join(tmpdir(), "dk-home-")),
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("aborted");
  expect(readFileSync(r.configPath, "utf8")).toBe(before);
  expect(r.doctorRuns).toBe(0);
});

test("a config of the wrong shape is replaced without asking, not crashed on", async () => {
  const sb = makeSandbox();
  sb.writeConfig({ orgs: "acme", repos: [] });
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme"]);
});

test("the starter placeholder config is replaced without asking, but its other keys survive", async () => {
  const sb = makeSandbox();
  const example = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "config.example.json"), "utf8"),
  );
  // placeholder orgs, but an opener the user has already customized
  example.openers.diff = [{ cmd: ["my-differ", "{base}", "{head}"] }];
  example.extra_allowed_tools = ["Bash(rg:*)"];
  sb.writeConfig(example);

  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  const cfg = r.config();
  expect(cfg.orgs).toEqual(["acme"]);
  expect(placeholderEntries(cfg as Config)).toEqual([]);
  expect(cfg.openers.diff).toEqual([
    { cmd: ["my-differ", "{base}", "{head}"] },
  ]);
  expect(cfg.extra_allowed_tools).toEqual(["Bash(rg:*)"]);
  expect(cfg.poll_interval_minutes).toBe(15);
});

test("a consented overwrite keeps the keys the wizard does not own", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["old-org"],
    repos: { "old-org/thing": "/somewhere" },
    extra_allowed_tools: ["Bash(rg:*)"],
    notifications: false,
  });
  const home = homeWithClones();
  const r = await drive(sb, ["y", "2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme"]);
  expect(r.config().extra_allowed_tools).toEqual(["Bash(rg:*)"]);
  expect(r.config().notifications).toBe(false);
});

test("an account pin the wizard is not using does not survive the write", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["your-github-org"], // placeholder, so no overwrite prompt
    repos: {},
    gh_account: "someone-else",
  });
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT, // one account: nothing to pin
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect("gh_account" in r.config()).toBe(false);
});

test("a default step result writes neither review key and clears an inherited custom task", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["your-github-org"], // placeholder, so no overwrite prompt
    repos: {},
    review_prompt: "Old custom task.",
    extra_allowed_tools: ["Bash(rg:*)"],
  });
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect("review_prompt" in r.config()).toBe(false);
  // extra_allowed_tools is never deleted, whatever the task choice
  expect(r.config().extra_allowed_tools).toEqual(["Bash(rg:*)"]);
});

test("a custom step result writes both keys, and the step saw the existing extras", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["your-github-org"],
    repos: {},
    extra_allowed_tools: ["Bash(rg:*)"],
  });
  const home = homeWithClones();
  const r = await drive(
    sb,
    ["2", "1", "", ""],
    { HOME: home, GH_AUTH_STATUS_TEXT: ONE_ACCOUNT, GH_ORG_LIST: "acme" },
    undefined,
    {
      task: "custom",
      review_prompt: "Run the blast-radius skill.",
      extra_allowed_tools: ["Bash(rg:*)", "Bash(node:*)"],
    },
  );
  expect(r.outcome).toBe("completed");
  expect(r.config().review_prompt).toBe("Run the blast-radius skill.");
  // the step returns the full merged list, and that is what lands
  expect(r.config().extra_allowed_tools).toEqual([
    "Bash(rg:*)",
    "Bash(node:*)",
  ]);
  // the union lives in the step, so the flow must hand it what is on disk —
  // except the repos, which are the ones just chosen in step 3, so the
  // derivation prompt lists real clone paths on a fresh run
  expect(r.stepOptions?.cfg.extra_allowed_tools).toEqual(["Bash(rg:*)"]);
  expect(r.stepOptions?.cfg.repos).toEqual(r.config().repos);
});

test("a custom result without extras leaves the existing extras untouched", async () => {
  const sb = makeSandbox();
  sb.writeConfig({
    orgs: ["your-github-org"],
    repos: {},
    extra_allowed_tools: ["Bash(rg:*)"],
  });
  const home = homeWithClones();
  const r = await drive(
    sb,
    ["2", "1", "", ""],
    { HOME: home, GH_AUTH_STATUS_TEXT: ONE_ACCOUNT, GH_ORG_LIST: "acme" },
    undefined,
    { task: "custom", review_prompt: "My task." },
  );
  expect(r.config().review_prompt).toBe("My task.");
  expect(r.config().extra_allowed_tools).toEqual(["Bash(rg:*)"]);
});

test("an aborted step aborts the wizard through the input-ended path, writing nothing", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(
    sb,
    ["2", "1", "", ""],
    { HOME: home, GH_AUTH_STATUS_TEXT: ONE_ACCOUNT, GH_ORG_LIST: "acme" },
    undefined,
    "aborted",
  );
  expect(r.outcome).toBe("aborted");
  expect(r.out).toContain("input ended");
  expect(existsSync(r.configPath)).toBe(false);
  expect(r.doctorRuns).toBe(0);
});

test("the steps around the review task are renumbered", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.out).toContain("4. Review task");
  expect(r.out).toContain("5. Writing config");
  expect(r.out).toContain("6. Checking the setup");
});

test("a config the wizard cannot write is reported, not thrown at the user", async () => {
  const sb = fresh();
  const home = homeWithClones();
  // a regular file where the config directory has to go: the same failure an
  // unwritable directory gives, without a chmod that root would ignore
  const blocked = join(sb.tmp, "blocked");
  writeFileSync(blocked, "");
  const p = resolvePaths({
    DOCKET_CONFIG_DIR: join(blocked, "docket"),
    DOCKET_STATE_DIR: sb.stateDir,
  } as NodeJS.ProcessEnv);
  const r = await drive(
    sb,
    ["2", "1", "", ""],
    { HOME: home, GH_AUTH_STATUS_TEXT: ONE_ACCOUNT, GH_ORG_LIST: "acme" },
    p,
  );
  expect(r.outcome).toBe("came-up-short");
  expect(r.out).toContain("could not write");
  expect(r.out).toContain("DOCKET_CONFIG_DIR");
  // nothing was written, so checking the setup would only report its absence
  expect(r.doctorRuns).toBe(0);
  expect(existsSync(p.configPath)).toBe(false);
});
