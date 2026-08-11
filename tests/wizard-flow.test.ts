import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import {
  loadConfig,
  paths as resolvePaths,
  placeholderEntries,
} from "../src/config";
import { type WizardOutcome, runNativeWizard } from "../src/wizard/flow";
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
  config(): Record<string, unknown>;
}

async function drive(
  sb: Sandbox,
  script: string[],
  extraEnv: Record<string, string> = {},
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
  const p = resolvePaths(sb.env);
  let doctorRuns = 0;
  let configAtDoctor: string | null = null;
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
  });
  return {
    outcome,
    out: chunks.join(""),
    doctorRuns,
    configAtDoctor,
    configPath: p.configPath,
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
  const r = await drive(sb, ["2", "1", "1", "", ""], {
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

test("the written config is 2-space indented and ends with a newline", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["2", "1", "1", "", ""], {
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
  await drive(sb, ["2", "1", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: TWO_ACCOUNTS,
    GH_ORG_LIST: "acme",
  });
  const calls = sb.ghCalls();
  expect(calls.some((c) => c.startsWith("auth switch"))).toBe(false);
  expect(calls).toContain("org list token=tok-mrgawrys-work");
});

test("a single gh account is used silently and writes no gh_account key", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, ["1", "1", "", ""], {
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
  const r = await drive(sb, ["1", "1", "", ""], {
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
  const r = await drive(sb, ["acme, beta", "1", "", ""], {
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
  const r = await drive(sb, ["acme", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST_FAIL: "1",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme"]);
});

test("ending with no orgs comes up short but still leaves a config behind", async () => {
  const sb = fresh();
  const home = homeWithClones();
  const r = await drive(sb, [""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "",
  });
  expect(r.outcome).toBe("came-up-short");
  expect(r.config()).toEqual({ orgs: [], repos: {} });
  expect(r.doctorRuns).toBe(1);
});

test("a scan that finds nothing, with nothing added by hand, comes up short", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  mkdirSync(join(home, "Development"));
  const r = await drive(sb, ["1", "1", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("came-up-short");
  expect(r.config()).toEqual({ orgs: ["acme"], repos: {} });
});

test("a projects root that does not exist skips the scan instead of failing", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  const r = await drive(sb, ["1", "/no/such/root", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.out).toContain("/no/such/root does not exist");
  expect(r.outcome).toBe("came-up-short");
  expect(r.config()).toEqual({ orgs: ["acme"], repos: {} });
});

test("repos added by hand are recorded and count as a real result", async () => {
  const sb = fresh();
  const home = mkdtempSync(join(tmpdir(), "dk-home-"));
  const clone = mkClone(join(home, "elsewhere"), "git@github.com:acme/x.git");
  const r = await drive(sb, ["1", "1", "acme/manual", clone, ""], {
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
  const r = await drive(sb, ["1", "1", "none", ""], {
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

  const r = await drive(sb, ["1", "1", "", ""], {
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
  const r = await drive(sb, ["9", "2", "1", "", ""], {
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
  const r = await drive(sb, ["1", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme"]);
});

test("the starter placeholder config is replaced without asking", async () => {
  const sb = makeSandbox();
  sb.writeConfig(
    JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config.example.json"), "utf8"),
    ),
  );
  const home = homeWithClones();
  const r = await drive(sb, ["1", "1", "", ""], {
    HOME: home,
    GH_AUTH_STATUS_TEXT: ONE_ACCOUNT,
    GH_ORG_LIST: "acme",
  });
  expect(r.outcome).toBe("completed");
  expect(r.config().orgs).toEqual(["acme"]);
});
