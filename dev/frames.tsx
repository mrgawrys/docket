// Headless frame viewer: mounts the real <App> over a seeded scenario via
// ink-testing-library and prints the frames — AI QA's fast pass after a UI
// change. A viewer, never a test: nothing here asserts anything.

import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAuth } from "../src/auth";
import { paths, readConfigSync } from "../src/config";
import { resolveOpeners } from "../src/openers";
import { App, type TuiActions } from "../src/tui/app";
import { materialize } from "./sandbox";
import { scenarios, seedScenario } from "./scenarios";

// Long enough for Ink to settle a render; frames are read after each pause.
const SETTLE_MS = 50;

const unknownScenario = (name: string): string =>
  `unknown scenario: ${name}\nvalid: ${Object.keys(scenarios).join(", ")}`;

// The initial frame, then one frame per key in `keys`. Each keystroke is one
// character written to the fake stdin — no enter support: enter suspends into
// a spawned process, which headless mode must not do.
// `calls` is the log of stub-action invocations a keystroke triggered — QA
// evidence for what actually fired, kept separate from the rendered frames.
export async function renderFrames(
  name: string,
  keys = "",
): Promise<{ frames: string[]; calls: string[] }> {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(unknownScenario(name));
  if (scenario.interactiveOnly) {
    throw new Error(`${name} is interactive-only — run: bun run demo ${name}`);
  }

  const dirs = materialize(mkdtempSync(join(tmpdir(), "docket-frames-")));
  seedScenario(dirs, scenario);
  const p = paths({
    DOCKET_CONFIG_DIR: dirs.configDir,
    DOCKET_STATE_DIR: dirs.stateDir,
  } as NodeJS.ProcessEnv);
  // The config as seeded on disk — repo paths already resolved under root.
  // Interactive-only scenarios (no seeded config) are rejected above, so this
  // fallback never fires; a bare default is honest about that.
  const cfg = readConfigSync(p.configPath, { orgs: [], repos: {} });

  // The auth probe (and anything a key spawns) must see the shims, never the
  // machine's real gh/claude; restored so the smoke test leaks nothing.
  const overlay: Record<string, string> = { ...dirs.env, ...scenario.env };
  const saved = new Map<string, string | undefined>(
    Object.keys(overlay).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, overlay);
  try {
    // Mirrors runTui: probe through the claude shim, same warning wording.
    const auth = claudeAuth(cfg);
    const authWarning =
      "ok" in auth && !auth.ok
        ? `claude is not logged in (${auth.dir}) — run: docket doctor`
        : undefined;
    const calls: string[] = [];
    const actions: TuiActions = {
      retry: async (k) => {
        calls.push(`retry:${k}`);
        return { code: 0 };
      },
      review: async (k) => {
        calls.push(`review:${k}`);
        return { code: 0 };
      },
      receive: async (k) => {
        calls.push(`receive:${k}`);
        return { code: 0 };
      },
      poll: async () => {
        calls.push("poll");
        return { code: 0 };
      },
      sync: async () => {
        calls.push("sync");
        return { code: 0 };
      },
      dismiss: (k) => {
        calls.push(`dismiss:${k}`);
        return `dismissed ${k}`;
      },
      kill: (k) => {
        calls.push(`kill:${k}`);
        return `${k}: killed`;
      },
    };
    // Fixed resolver and $SHELL, like tests/tui.test.tsx: frames must not
    // change with the developer's PATH or login shell.
    const resolved = resolveOpeners(
      cfg,
      (bin) => bin === "git" || bin === "/bin/sh" || bin === "open",
      { SHELL: "/bin/sh" } as NodeJS.ProcessEnv,
    );
    const ui = render(
      <App
        cfg={cfg}
        paths={p}
        actions={actions}
        resolved={resolved}
        request={() => {}}
        authWarning={authWarning}
      />,
    );
    const frames: string[] = [];
    await Bun.sleep(SETTLE_MS);
    frames.push(ui.lastFrame() ?? "");
    for (const key of keys) {
      ui.stdin.write(key);
      await Bun.sleep(SETTLE_MS);
      frames.push(ui.lastFrame() ?? "");
    }
    ui.unmount();
    return { frames, calls };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let keys = "";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keys") keys = args[++i] ?? "";
    else rest.push(args[i]!);
  }
  const name = rest[0];
  if (!name) {
    console.error("usage: bun run frames <scenario>|all [--keys <seq>]");
    console.error(`scenarios: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }
  try {
    if (name === "all") {
      for (const [n, s] of Object.entries(scenarios)) {
        if (s.interactiveOnly) continue;
        console.log(`\n═══ ${n} — ${s.description} ═══\n`);
        const { frames, calls } = await renderFrames(n);
        console.log(frames[0]);
        if (calls.length) console.log(`\nactions: ${calls.join(", ")}`);
      }
    } else {
      const { frames, calls } = await renderFrames(name, keys);
      console.log(frames[0]);
      frames.slice(1).forEach((frame, i) => {
        console.log(`\n── after "${keys[i]}" ──\n`);
        console.log(frame);
      });
      if (calls.length) console.log(`\nactions: ${calls.join(", ")}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}
