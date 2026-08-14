// The interactive first-run wizard (spec §1). The pure logic it drives lives
// in ./core; this module owns the prompts, the subprocesses and the config
// write. Ported from the validated prototype
// (prototypes/first-run-wizard/native-wizard/wizard.ts).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type Paths,
  ghBin,
  placeholderEntries,
  paths as resolvePaths,
  writeConfigText,
} from "../config";
import { doctorCommand } from "../doctor";
import { ghAccountToken } from "../github";
import {
  SCAN_MAX_DEPTH,
  completePath,
  expandHome,
  parseAccounts,
  parseOrigin,
  parseSelection,
  scanForRepos,
} from "./core";

// What the first-run trigger acts on. "came-up-short" is the load-bearing
// one: the wizard ran, but the native path could not produce something worth
// polling — no orgs, or no clones it could map — which is where the caller
// offers the claude-guided wizard instead.
export type WizardOutcome = "completed" | "aborted" | "came-up-short";

export interface WizardOptions {
  paths?: Paths;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  // Real callers ask git for a checkout's origin; tests answer directly.
  getOrigin?: (dir: string) => string | null;
  runDoctor?: (p: Paths) => Promise<number>;
}

const ROOT_SUGGESTIONS = ["Development", "Work", "Projects", "code"];

// Thrown when stdin ends mid-question, so a piped or closed stdin ends the
// wizard with a message instead of hanging on a read that will never answer.
class InputEnded extends Error {}

// ------------------------------------------------------------- subprocess --

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  missing: boolean; // the binary itself isn't there, vs. it ran and failed
}

// Bun rejects an env with undefined values, and NodeJS.ProcessEnv is full of
// optionals — drop the holes rather than passing "undefined" through.
export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function run(cmd: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    const p = Bun.spawnSync(cmd, {
      env: cleanEnv(env),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: p.exitCode === 0,
      out: p.stdout.toString().trim(),
      err: p.stderr.toString().trim(),
      missing: false,
    };
  } catch (e) {
    return { ok: false, out: "", err: String(e), missing: true };
  }
}

// ---------------------------------------------------------------- terminal --

interface Ui {
  say(s?: string): void;
  step(n: number, title: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  multiSelect(items: string[], prompt: string): Promise<number[]>;
  bold(s: string): string;
  dim(s: string): string;
  close(): void;
}

function makeUi(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  home: string,
): Ui {
  const rl = createInterface({
    input,
    output,
    completer: (line: string) => completePath(line, home),
  });
  // Pulled one line at a time rather than rl.question(), which only captures
  // input while a question is pending — piped stdin delivers every line at
  // once and the ones arriving between questions are dropped.
  const lines = rl[Symbol.asyncIterator]();
  const tty = Boolean((input as { isTTY?: boolean }).isTTY);
  const paint = (code: string) => (s: string) =>
    tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  const bold = paint("1");
  const dim = paint("2");
  const say = (s = "") => {
    output.write(`${s}\n`);
  };
  const ask = async (question: string, fallback = ""): Promise<string> => {
    // setPrompt, not a bare write: readline repaints the line from its own
    // prompt on tab-completion and line edits, and would otherwise replace
    // the question with its default "> ".
    rl.setPrompt(question);
    rl.prompt();
    const { value, done } = await lines.next();
    if (done) throw new InputEnded("stdin closed");
    if (!tty) say(String(value)); // piped input isn't echoed; keep a transcript
    return String(value).trim() || fallback;
  };
  const multiSelect = async (
    items: string[],
    prompt: string,
  ): Promise<number[]> => {
    items.forEach((item, i) => say(`  ${String(i + 1).padStart(2)}) ${item}`));
    for (;;) {
      const picked = parseSelection(await ask(`${prompt} `), items.length);
      if (picked) return picked;
      say(dim(`  not a valid choice — use numbers 1-${items.length}`));
    }
  };
  return {
    say,
    step: (n, title) => {
      say();
      say(bold(`${n}. ${title}`));
    },
    ask,
    multiSelect,
    bold,
    dim,
    close: () => rl.close(),
  };
}

// --------------------------------------------------------- step 1: account --

type AccountStep =
  // `login` is who gh is acting as either way; `account` is only set when the
  // user chose between accounts, and only that gets pinned in the config.
  | { ok: true; login: string; account?: string; env: NodeJS.ProcessEnv }
  | { ok: false; message: string };

async function chooseAccount(
  ui: Ui,
  gh: string,
  env: NodeJS.ProcessEnv,
): Promise<AccountStep> {
  ui.step(1, "GitHub account");
  const status = run([gh, "auth", "status"], env);
  if (status.missing) {
    return {
      ok: false,
      message: `${gh} is not installed — install the GitHub CLI: https://cli.github.com`,
    };
  }
  // gh has moved this text between stdout and stderr across versions.
  const accounts = parseAccounts(`${status.out}\n${status.err}`);
  if (accounts.length === 0) {
    return {
      ok: false,
      message: "gh is not logged in to GitHub — run: gh auth login",
    };
  }

  let chosen = accounts[0]!;
  // Only a deliberate pick is worth pinning in the config: a single-account
  // machine that later renames its login would fail a pin it never asked for.
  let explicit = false;
  if (accounts.length === 1) {
    ui.say(
      `   using ${ui.bold(chosen.name)} (the only account gh is logged in as)`,
    );
  } else {
    ui.say("   gh is logged in as several accounts:");
    accounts.forEach((a, i) =>
      ui.say(`  ${i + 1}) ${a.name}${a.active ? ui.dim(" (active)") : ""}`),
    );
    const activeIndex = Math.max(
      0,
      accounts.findIndex((a) => a.active),
    );
    for (;;) {
      const answer = await ui.ask(
        `   which one? [1-${accounts.length}, default ${activeIndex + 1}] `,
        String(activeIndex + 1),
      );
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= accounts.length) {
        chosen = accounts[n - 1]!;
        explicit = true;
        break;
      }
      ui.say(ui.dim("   not a valid choice"));
    }
    ui.say(`   using ${ui.bold(chosen.name)}`);
  }

  const login = chosen.name;
  const account = explicit ? login : undefined;
  // Pin the token per command so org listing reflects the chosen account.
  // `gh auth switch` would do it by mutating the user's global gh state.
  const token = ghAccountToken(gh, login, cleanEnv(env));
  if ("error" in token) {
    ui.say(
      ui.dim(
        `   (couldn't read a token for ${login}; using gh's active account)`,
      ),
    );
    return { ok: true, login, account, env };
  }
  return { ok: true, login, account, env: { ...env, GH_TOKEN: token.token } };
}

// ------------------------------------------------------------ step 2: orgs --

const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function chooseOrgs(
  ui: Ui,
  gh: string,
  env: NodeJS.ProcessEnv,
  login: string,
): Promise<string[]> {
  ui.step(2, "Organizations");
  // gh pages at 30 silently, and the type-by-hand fallback below only shows up
  // when gh listed nothing — an org past the cap would be unreachable.
  const listed = run([gh, "org", "list", "--limit", "100"], env);
  const orgs = listed.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const listedAny = listed.ok && orgs.length > 0;
  if (!listed.ok) {
    // an org list that failed is not an account with no orgs — SSO and scope
    // errors both land here, and only gh's own words say which
    const why = listed.err.split("\n").find(Boolean) ?? "no reason given";
    ui.say(ui.dim(`   gh could not list organizations: ${why}`));
  } else if (orgs.length === 0) {
    ui.say(ui.dim("   gh listed no organizations for this account."));
  }
  // The account's own login is a candidate in its own right: `gh org list`
  // never returns it, and personal repos are a mainstream case (docket's own
  // PRs live under one).
  const owners = [login, ...orgs.filter((o) => !sameOwner(o, login))];
  ui.say("   whose PRs should docket watch?");
  const picked = await ui.multiSelect(
    owners.map((o) => (o === login ? `${o} ${ui.dim("(your account)")}` : o)),
    "   numbers, comma separated [empty = all]:",
  );
  const chosen = picked.map((i) => owners[i]!);
  // Only when gh had nothing to offer: an org it cannot see (SSO, or someone
  // else's) still has to be reachable.
  if (listedAny) return chosen;
  const typed = await ui.ask(
    "   any others? type org names by hand (comma separated): ",
  );
  const all = [...chosen];
  for (const o of typed.split(",").map((s) => s.trim())) {
    if (o && !all.some((held) => sameOwner(held, o))) all.push(o);
  }
  return all;
}

// ----------------------------------------------------------- step 3: repos --

interface RepoStep {
  repos: Record<string, string>;
  // The native path found nothing to map and the user added nothing either —
  // as opposed to a user who deliberately turned the found clones down.
  shortfall: boolean;
}

async function chooseRoot(ui: Ui, home: string): Promise<string> {
  const suggestions = ROOT_SUGGESTIONS.map((d) => join(home, d)).filter((d) =>
    existsSync(d),
  );
  const fallback = suggestions[0] ?? home;
  ui.say("   where do your clones live?");
  suggestions.forEach((d, i) => ui.say(`  ${i + 1}) ${d}`));
  const hint = suggestions.length > 0 ? "a number, or " : "";
  const answer = await ui.ask(
    `   ${hint}a path (tab completes) [${fallback}] `,
    fallback,
  );
  // A bare number picks one of the suggestions above; anything else is a path.
  const n = Number(answer);
  const chosen =
    Number.isInteger(n) && n >= 1 && n <= suggestions.length
      ? suggestions[n - 1]!
      : answer;
  return resolve(expandHome(chosen, home));
}

async function addByHand(
  ui: Ui,
  repos: Record<string, string>,
  home: string,
): Promise<void> {
  for (;;) {
    const slug = await ui.ask(
      '   add a repo by hand? "org/repo" (empty to finish): ',
    );
    if (!slug) return;
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
      ui.say(ui.dim('   that needs the "org/repo" form'));
      continue;
    }
    const typed = await ui.ask(`   clone path for ${slug} (tab completes): `);
    if (!typed) {
      ui.say(ui.dim(`   no path — ${slug} skipped`));
      continue;
    }
    const path = resolve(expandHome(typed, home));
    if (!existsSync(path)) {
      ui.say(
        ui.dim("   that path does not exist — recorded, doctor will flag it"),
      );
    }
    repos[slug] = path;
  }
}

async function chooseRepos(
  ui: Ui,
  orgs: string[],
  home: string,
  getOrigin: (dir: string) => string | null,
): Promise<RepoStep> {
  ui.step(3, "Local clones");
  const root = await chooseRoot(ui, home);
  const repos: Record<string, string> = {};
  let matches: Array<{ slug: string; path: string }> = [];
  if (!existsSync(root)) {
    ui.say(ui.dim(`   ${root} does not exist — skipping the repo scan.`));
  } else {
    ui.say(ui.dim(`   scanning ${root} (up to ${SCAN_MAX_DEPTH} levels)...`));
    // scanForRepos keeps one checkout per repo; count what it dropped on the
    // way through so the scan can report its own losses honestly.
    const wanted = new Set(orgs.map((o) => o.toLowerCase()));
    let inOrg = 0;
    let noOrigin = 0;
    matches = scanForRepos(root, orgs, SCAN_MAX_DEPTH, (dir) => {
      const origin = getOrigin(dir);
      if (!origin) {
        noOrigin++;
        return null;
      }
      const parsed = parseOrigin(origin);
      if (parsed && wanted.has(parsed.org.toLowerCase())) inOrg++;
      return origin;
    });
    const notes: string[] = [];
    const collapsed = inOrg - matches.length;
    if (collapsed > 0)
      notes.push(`${collapsed} extra checkout(s) of the same repos`);
    if (noOrigin > 0) notes.push(`${noOrigin} checkout(s) with no origin`);
    if (notes.length > 0) ui.say(ui.dim(`   (left out: ${notes.join(", ")})`));
  }

  let declined = false;
  if (matches.length > 0) {
    ui.say(`   found ${matches.length} clone(s) — keep which?`);
    const picked = await ui.multiSelect(
      matches.map((m) => `${m.slug} ${ui.dim("→")} ${m.path}`),
      '   numbers, comma separated [empty = all, "none" = skip]:',
    );
    for (const i of picked) repos[matches[i]!.slug] = matches[i]!.path;
    declined = picked.length === 0;
  } else if (existsSync(root)) {
    ui.say(ui.dim(`   no clones of ${orgs.join(", ")} found under ${root}.`));
  }

  await addByHand(ui, repos, home);
  return {
    repos,
    shortfall: Object.keys(repos).length === 0 && !declined,
  };
}

// ---------------------------------------------------------- step 4: finish --

interface OverwriteCheck {
  proceed: boolean;
  // what is on disk now, so the write can keep the keys the wizard doesn't own
  existing?: Record<string, unknown>;
}

// The trigger only starts the wizard when there is no usable config, but a
// hand-run one must not silently overwrite a config someone has filled in.
async function mayOverwrite(ui: Ui, p: Paths): Promise<OverwriteCheck> {
  if (!existsSync(p.configPath)) return { proceed: true };
  // whatever is on disk, not a Config — read every field defensively
  let cfg: Record<string, unknown> | undefined;
  try {
    cfg = JSON.parse(readFileSync(p.configPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // unreadable: still the user's file, so still their call
  }
  if (cfg) {
    const orgs = Array.isArray(cfg.orgs) ? (cfg.orgs as string[]) : [];
    const repos =
      cfg.repos && typeof cfg.repos === "object" && !Array.isArray(cfg.repos)
        ? (cfg.repos as Record<string, string>)
        : {};
    const filled = orgs.length > 0 || Object.keys(repos).length > 0;
    // the seeded starter config is exactly what the wizard is here to replace
    if (!filled || placeholderEntries({ orgs, repos }).length > 0) {
      return { proceed: true, existing: cfg };
    }
    ui.say(ui.dim(`   ${p.configPath} already lists orgs and repos.`));
  } else {
    ui.say(ui.dim(`   ${p.configPath} is not valid JSON.`));
  }
  const answer = await ui.ask("   overwrite it? [y/N] ");
  return { proceed: answer.toLowerCase().startsWith("y"), existing: cfg };
}

// False when the config could not be written — the wizard asked every question
// for nothing, and saying so beats a stack trace over the last four steps.
function writeConfig(
  ui: Ui,
  p: Paths,
  existing: Record<string, unknown> | undefined,
  orgs: string[],
  repos: Record<string, string>,
  login: string,
  account: string | undefined,
): boolean {
  ui.step(4, "Writing config");
  // Everything the wizard doesn't own survives — openers, extra_allowed_tools
  // and friends are the user's, whether they seeded them or wrote them.
  const cfg: Record<string, unknown> = { ...existing, orgs, repos };
  if (account) cfg.gh_account = account;
  // A pin the wizard didn't set, naming an account it isn't using, resolves to
  // no token later; the empty one the starter config ships is harmless.
  else if (cfg.gh_account && cfg.gh_account !== login) delete cfg.gh_account;
  const text = `${JSON.stringify(cfg, null, 2)}\n`;
  try {
    mkdirSync(p.configDir, { recursive: true });
    // Synchronous on purpose: doctor reads this file moments later.
    writeConfigText(p.configPath, text);
  } catch (e) {
    ui.say(`   could not write ${p.configPath}: ${(e as Error).message}`);
    ui.say(
      "   point DOCKET_CONFIG_DIR at a writable directory, then run docket again.",
    );
    return false;
  }
  ui.say(`   wrote ${p.configPath}`);
  ui.say(
    ui.dim(
      text
        .trimEnd()
        .split("\n")
        .map((l) => `   ${l}`)
        .join("\n"),
    ),
  );
  return true;
}

// ------------------------------------------------------------------- flow --

export async function runNativeWizard(
  opts: WizardOptions = {},
): Promise<WizardOutcome> {
  const env = opts.env ?? process.env;
  const p = opts.paths ?? resolvePaths(env);
  const home = env.HOME || homedir();
  const gh = ghBin(env);
  const getOrigin =
    opts.getOrigin ??
    ((dir: string) => {
      const r = run(["git", "-C", dir, "remote", "get-url", "origin"], env);
      return r.ok && r.out ? r.out : null;
    });
  const runDoctor = opts.runDoctor ?? doctorCommand;
  const ui = makeUi(
    opts.input ?? process.stdin,
    opts.output ?? process.stdout,
    home,
  );

  let wrote = false;
  const flow = async (): Promise<WizardOutcome> => {
    ui.say(ui.bold("docket setup"));
    ui.say(ui.dim(`config → ${p.configPath}`));
    const { proceed, existing } = await mayOverwrite(ui, p);
    if (!proceed) {
      ui.say("   leaving it as it is — nothing was written.");
      return "aborted";
    }
    const account = await chooseAccount(ui, gh, env);
    if (!account.ok) {
      ui.say(`   ${account.message}`);
      return "came-up-short";
    }
    const orgs = await chooseOrgs(ui, gh, account.env, account.login);
    if (orgs.length === 0) {
      // Nothing to poll, so nothing worth writing: a config here would count
      // as configured and stop the first run from ever offering setup again.
      ui.say(ui.dim("   nothing to watch — no config written, so docket will"));
      ui.say(ui.dim("   offer setup again next time."));
      return "came-up-short";
    }
    const { repos, shortfall } = await chooseRepos(ui, orgs, home, getOrigin);
    // Written even with no repos mapped: that config is genuinely useful (the
    // poller works, unmapped repos skip at review time) and doctor says so.
    const ok = writeConfig(
      ui,
      p,
      existing,
      orgs,
      repos,
      account.login,
      account.account,
    );
    if (!ok) return "came-up-short";
    wrote = true;
    return shortfall ? "came-up-short" : "completed";
  };

  let outcome: WizardOutcome;
  try {
    outcome = await flow();
  } catch (e) {
    if (!(e instanceof InputEnded)) throw e;
    ui.say();
    ui.say("input ended — nothing was written.");
    outcome = "aborted";
  } finally {
    // doctor gets the terminal to itself, with no readline holding stdin
    ui.close();
  }

  if (wrote) {
    ui.step(5, "Checking the setup");
    const code = await runDoctor(p);
    ui.say();
    ui.say(
      code === 0
        ? ui.bold("Setup looks good.")
        : ui.dim(
            "doctor found problems above — fix those, then re-run: docket doctor",
          ),
    );
  }
  return outcome;
}
