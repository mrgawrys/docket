#!/usr/bin/env bun
//
// docket first-run wizard — prototype B (native prompts, no deps).
//
// Throwaway. Writes only into ./sandbox/{config,state} next to this file, and
// never touches ~/.config/docket. Run it with: bun run wizard.ts
//
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_CONFIG_DIR = join(HERE, "sandbox", "config");
const SANDBOX_STATE_DIR = join(HERE, "sandbox", "state");
const DOCKET_MAIN = "/Users/gawrys/Development/auto-review/src/main.ts";

const ROOT_SUGGESTIONS = ["Development", "Work", "Projects", "code"];
const SCAN_MAX_DEPTH = 3;
const SCAN_SKIP = new Set([
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "Library",
]);

// ---------------------------------------------------------------- terminal --

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const say = (s = "") => console.log(s);
const step = (n: number, title: string) => say(`\n${bold(`${n}. ${title}`)}`);

// Thrown when stdin ends mid-question, so a piped/closed stdin exits with a
// message instead of hanging or dumping a stack.
class InputEnded extends Error {}

const expandHome = (p: string) =>
  p.startsWith("~") ? join(homedir(), p.slice(1)) : p;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Tab-completes directory names for the clone-root prompt. Returns the hits as
// whole replacement lines paired with the whole line, which is what readline
// substitutes. Harmless at the other prompts: nothing there looks like a path,
// so nothing matches.
export function completePath(line: string): [string[], string] {
  if (line.trim() === "") return [[], line];
  const expanded = expandHome(line);
  const cut = expanded.lastIndexOf("/");
  const dir = cut === -1 ? "." : expanded.slice(0, cut + 1) || "/";
  const partial = cut === -1 ? expanded : expanded.slice(cut + 1);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [[], line];
  }
  const home = homedir();
  const hits = entries
    .filter((e) => {
      if (!e.name.startsWith(partial)) return false;
      // hidden directories only once the user commits to a leading dot
      if (e.name.startsWith(".") && !partial.startsWith(".")) return false;
      return e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name)));
    })
    .map((e) => `${dir === "." ? "" : dir}${e.name}/`)
    // keep the answer in the shape the user is typing it
    .map((p) => (line.startsWith("~") && p.startsWith(home) ? `~${p.slice(home.length)}` : p))
    .sort();
  return [hits, line];
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: completePath,
});
// Pulled one line at a time rather than rl.question(), which only captures
// input while a question is pending — piped stdin delivers every line at once
// and the ones arriving between questions are dropped.
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, fallback = ""): Promise<string> {
  // setPrompt, not a bare write: readline repaints the line from its own
  // prompt on tab-completion and line edits, and would otherwise replace the
  // question with its default "> ".
  rl.setPrompt(question);
  rl.prompt();
  const { value, done } = await lines.next();
  if (done) throw new InputEnded("stdin closed");
  if (!process.stdin.isTTY) process.stdout.write(`${value}\n`);
  return value.trim() || fallback;
}

// ------------------------------------------------------------- subprocess --

interface Run {
  ok: boolean;
  out: string;
  err: string;
  missing: boolean; // the binary itself isn't there, vs. it ran and failed
}

function run(cmd: string[], env: Record<string, string> = {}): Run {
  try {
    const p = Bun.spawnSync(cmd, {
      env: { ...process.env, ...env } as Record<string, string>,
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

// ------------------------------------------------------------- selection ---

// Numbered multi-select: empty picks everything, "none" picks nothing,
// otherwise comma/space separated 1-based numbers. Returns 0-based indices.
function parseSelection(input: string, count: number): number[] | null {
  const raw = input.trim().toLowerCase();
  if (raw === "" || raw === "a" || raw === "all") {
    return [...Array(count).keys()];
  }
  if (raw === "n" || raw === "none") return [];
  const picked: number[] = [];
  for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    if (!picked.includes(n - 1)) picked.push(n - 1);
  }
  return picked;
}

async function multiSelect(
  items: string[],
  prompt: string,
): Promise<number[]> {
  items.forEach((item, i) => say(`  ${String(i + 1).padStart(2)}) ${item}`));
  for (;;) {
    const answer = await ask(`${prompt} `);
    const picked = parseSelection(answer, items.length);
    if (picked) return picked;
    say(dim(`  not a valid choice — use numbers 1-${items.length}`));
  }
}

// --------------------------------------------------------- step 1: account --

interface Account {
  name: string;
  active: boolean;
}

// `gh auth status` is human-oriented text, roughly:
//
//   github.com
//     ✓ Logged in to github.com account mrgawrys (keyring)
//     - Active account: true
//     - Token scopes: 'gist', 'read:org', ...
//
// so we anchor on the "account <name>" phrase and treat everything after it as
// decoration, then attach the nearest following "Active account:" line.
function parseAccounts(text: string): Account[] {
  const accounts: Account[] = [];
  for (const line of text.split("\n")) {
    const login = line.match(/Logged in to \S+ account (\S+)/);
    if (login?.[1]) {
      accounts.push({ name: login[1], active: false });
      continue;
    }
    const active = line.match(/Active account:\s*(\S+)/);
    if (active && accounts.length > 0) {
      accounts[accounts.length - 1]!.active = active[1] === "true";
    }
  }
  return accounts;
}

interface AccountChoice {
  account?: string; // recorded in config only when explicitly picked
  env: Record<string, string>; // GH_TOKEN for later gh calls, when we have one
}

async function chooseAccount(): Promise<AccountChoice> {
  step(1, "GitHub account");
  const status = run(["gh", "auth", "status"]);
  if (status.missing) {
    throw new Error("gh is not installed — install it with: brew install gh");
  }
  const combined = `${status.out}\n${status.err}`;
  const accounts = parseAccounts(combined);
  if (accounts.length === 0) {
    throw new Error(
      "gh is not logged in to GitHub — run: gh auth login\n" +
        dim(combined.split("\n").slice(0, 4).join("\n")),
    );
  }

  let chosen: Account;
  let explicit = false;
  if (accounts.length === 1) {
    chosen = accounts[0]!;
    say(`   using ${bold(chosen.name)} (the only account gh is logged in as)`);
  } else {
    say("   gh is logged in as several accounts:");
    const labels = accounts.map(
      (a) => `${a.name}${a.active ? dim(" (active)") : ""}`,
    );
    labels.forEach((l, i) => say(`  ${i + 1}) ${l}`));
    const activeIndex = Math.max(
      0,
      accounts.findIndex((a) => a.active),
    );
    for (;;) {
      const answer = await ask(
        `   which one? [1-${accounts.length}, default ${activeIndex + 1}] `,
        String(activeIndex + 1),
      );
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= accounts.length) {
        chosen = accounts[n - 1]!;
        explicit = true;
        break;
      }
      say(dim("   not a valid choice"));
    }
    say(`   using ${bold(chosen.name)}`);
  }

  // Pin the token so org listing reflects the chosen account rather than
  // whichever one gh considers active.
  const token = run(["gh", "auth", "token", "-u", chosen.name]);
  if (!token.ok || !token.out) {
    say(dim(`   (couldn't read a token for ${chosen.name}; using gh's active account)`));
    return { account: explicit ? chosen.name : undefined, env: {} };
  }
  return {
    account: explicit ? chosen.name : undefined,
    env: { GH_TOKEN: token.out },
  };
}

// ------------------------------------------------------------ step 2: orgs --

async function chooseOrgs(env: Record<string, string>): Promise<string[]> {
  step(2, "Organizations");
  const listed = run(["gh", "org", "list"], env);
  const orgs = listed.out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!listed.ok || orgs.length === 0) {
    say(dim("   gh listed no organizations for this account."));
    const typed = await ask("   type org names by hand (comma separated): ");
    return typed.split(",").map((o) => o.trim()).filter(Boolean);
  }
  say("   which orgs should docket watch?");
  const picked = await multiSelect(
    orgs,
    `   numbers, comma separated [empty = all]:`,
  );
  return picked.map((i) => orgs[i]!);
}

// ----------------------------------------------------------- step 3: repos --

// git@github.com:org/repo.git, https://github.com/org/repo(.git),
// ssh://git@github.com/org/repo — all collapse to "org/repo".
function parseOrigin(url: string): { org: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) return null;
  return { org: m[1]!, repo: m[2]! };
}

interface Checkout {
  path: string;
  // A linked worktree carries a .git *file* pointing at the real repo, where a
  // clone has a .git directory. Several worktrees of one repo all report the
  // same origin, so this is what tells the main clone from its worktrees.
  linked: boolean;
}

function findGitRepos(root: string, maxDepth: number): Checkout[] {
  const found = new Map<string, Checkout>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it, not the whole scan
    }
    // A clone is worth recording and still worth descending into: a workspace
    // repo with the real project clones gitignored inside it is a normal
    // layout, and stopping here would hide every one of them.
    const git = entries.find((e) => e.name === ".git");
    if (git) found.set(dir, { path: dir, linked: !git.isDirectory() });
    for (const e of entries) {
      // the dot-prefix skip is what keeps us out of .git itself
      if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) {
        continue;
      }
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return [...found.values()];
}

async function chooseRepos(
  orgs: string[],
  env: Record<string, string>,
): Promise<Record<string, string>> {
  step(3, "Local clones");
  if (orgs.length === 0) {
    say(dim("   no orgs chosen — skipping the repo scan."));
    return {};
  }

  const suggestions = ROOT_SUGGESTIONS.map((d) => join(homedir(), d)).filter(
    (d) => existsSync(d),
  );
  const fallback = suggestions[0] ?? homedir();
  say("   where do your clones live?");
  suggestions.forEach((d, i) => say(`  ${i + 1}) ${d}`));
  const hint = suggestions.length > 0 ? "a number, or " : "";
  const answer = await ask(
    `   ${hint}a path (tab completes) [${fallback}] `,
    fallback,
  );
  // A bare number picks one of the suggestions above; anything else is a path.
  const asNumber = Number(answer);
  const chosen =
    Number.isInteger(asNumber) &&
    asNumber >= 1 &&
    asNumber <= suggestions.length
      ? suggestions[asNumber - 1]!
      : answer;
  const root = resolve(expandHome(chosen));
  if (!existsSync(root)) {
    say(dim(`   ${root} does not exist — skipping the repo scan.`));
    return {};
  }

  say(dim(`   scanning ${root} (up to ${SCAN_MAX_DEPTH} levels)...`));
  const wanted = new Set(orgs.map((o) => o.toLowerCase()));
  // One entry per repo: config keys on "org/repo", so several checkouts of the
  // same repo would collapse anyway — pick which one survives deliberately. A
  // real clone beats a linked worktree, then the shallower path wins.
  const best = new Map<string, Checkout>();
  let collapsed = 0;
  for (const checkout of findGitRepos(root, SCAN_MAX_DEPTH)) {
    const dir = checkout.path;
    const origin = run(["git", "-C", dir, "remote", "get-url", "origin"], env);
    if (!origin.ok) continue;
    const parsed = parseOrigin(origin.out);
    if (!parsed || !wanted.has(parsed.org.toLowerCase())) continue;
    const slug = `${parsed.org}/${parsed.repo}`;
    const held = best.get(slug);
    if (!held) {
      best.set(slug, checkout);
      continue;
    }
    collapsed++;
    const better =
      held.linked !== checkout.linked
        ? !checkout.linked
        : checkout.path.length < held.path.length;
    if (better) best.set(slug, checkout);
  }
  const matches = [...best.entries()].map(([slug, c]) => ({
    slug,
    path: c.path,
  }));
  if (collapsed > 0) {
    say(
      dim(`   (${collapsed} extra checkout(s) of the same repos left out)`),
    );
  }

  if (matches.length === 0) {
    say(dim(`   no clones of ${orgs.join(", ")} found under ${root}.`));
    say(dim("   you can add repos to the config by hand later."));
    return {};
  }

  say(`   found ${matches.length} clone(s) — keep which?`);
  const picked = await multiSelect(
    matches.map((m) => `${m.slug} ${dim("→")} ${m.path}`),
    `   numbers, comma separated [empty = all, "none" = skip]:`,
  );

  const repos: Record<string, string> = {};
  for (const i of picked) {
    const m = matches[i]!;
    repos[m.slug] = m.path;
  }
  return repos;
}

// ----------------------------------------------------------- step 4: write --

function writeConfig(
  orgs: string[],
  repos: Record<string, string>,
  account: string | undefined,
): string {
  step(4, "Writing config");
  const cfg: Record<string, unknown> = { orgs, repos };
  if (account) cfg.gh_account = account;
  mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
  const path = join(SANDBOX_CONFIG_DIR, "config.json");
  // Synchronous on purpose: doctor spawns right after and reads this file.
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  say(`   wrote ${path}`);
  say(dim(JSON.stringify(cfg, null, 2).split("\n").map((l) => `   ${l}`).join("\n")));
  return path;
}

// ---------------------------------------------------------- step 5: doctor --

function runDoctor(): number {
  step(5, "Checking the setup");
  mkdirSync(SANDBOX_STATE_DIR, { recursive: true });
  if (!existsSync(DOCKET_MAIN)) {
    say(dim(`   ${DOCKET_MAIN} not found — skipping doctor.`));
    return 0;
  }
  const p = Bun.spawnSync(["bun", "run", DOCKET_MAIN, "doctor"], {
    env: {
      ...process.env,
      DOCKET_CONFIG_DIR: SANDBOX_CONFIG_DIR,
      DOCKET_STATE_DIR: SANDBOX_STATE_DIR,
    } as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return p.exitCode ?? 0;
}

// ------------------------------------------------------------------- main --

async function main(): Promise<number> {
  say(bold("docket setup") + dim(" — prototype B (sandboxed)"));
  say(dim(`config → ${SANDBOX_CONFIG_DIR}`));
  say(dim(`state  → ${SANDBOX_STATE_DIR}`));

  const { account, env } = await chooseAccount();
  const orgs = await chooseOrgs(env);
  const repos = await chooseRepos(orgs, env);
  writeConfig(orgs, repos, account);
  rl.close();

  const code = runDoctor();
  say();
  say(
    code === 0
      ? bold("Setup looks good.")
      : dim("doctor found problems above — fix those, then re-run: docket doctor"),
  );
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    rl.close();
    if (e instanceof InputEnded) {
      say("\ninput ended — nothing was written.");
      process.exit(1);
    }
    say(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
