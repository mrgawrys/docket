import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, type Config } from "../src/config";
import { resolveOpeners } from "../src/openers";
import { setStatus, type Entry, type State } from "../src/state";
import { App, type TuiActions } from "../src/tui/app";
import type { SuspendRequest } from "../src/tui/suspend";

// Only three component tests, deliberately — see "TUI tests stay thin" in
// CLAUDE.md. Everything else about the UI is verified by running the binary.

const cfg: Config = { orgs: [], repos: {} };
const resolved = resolveOpeners(
  cfg,
  (bin) => bin === "git" || bin === "/bin/sh",
);

// `real` makes dismiss do what the command does — mark the entry done, which
// drops it from the queue. A stub that only records the call cannot catch a
// cursor that moves when the row under it disappears.
function mount(state: State, real = false, configText = JSON.stringify(cfg)) {
  const dir = mkdtempSync(join(tmpdir(), "docket-tui-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "config.json"), configText);
  const p = paths({
    DOCKET_CONFIG_DIR: dir,
    DOCKET_STATE_DIR: dir,
  } as NodeJS.ProcessEnv);
  const calls: string[] = [];
  const requests: SuspendRequest[] = [];
  const actions: TuiActions = {
    retry: async (k) => {
      calls.push(`retry:${k}`);
      return 0;
    },
    poll: async () => {
      calls.push("poll");
      return 0;
    },
    sync: async () => {
      calls.push("sync");
      return 0;
    },
    dismiss: (k) => {
      calls.push(`dismiss:${k}`);
      if (real) setStatus(p.statePath, k, "done");
      return `dismissed ${k}`;
    },
    kill: (k) => {
      calls.push(`kill:${k}`);
      return `${k}: killed`;
    },
  };
  const r = render(
    <App
      cfg={cfg}
      paths={p}
      actions={actions}
      resolved={resolved}
      request={(req) => requests.push(req)}
    />,
  );
  return { ...r, calls, requests, paths: p };
}

const entry = (over: Partial<Entry>): Entry => ({
  status: "ready",
  session_id: "s",
  local_path: "/clone",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

test("destructive verbs act on the highlighted row, not the first one", async () => {
  const ui = mount({
    "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
    "acme/two#2": entry({
      title: "Two",
      status: "reviewing",
      pid: 1,
      updated_at: "2026-01-02T00:00:00Z",
    }),
  });
  ui.stdin.write("j"); // move off row 1
  await Bun.sleep(20);
  ui.stdin.write("x");
  await Bun.sleep(20);
  ui.stdin.write("K");
  await Bun.sleep(20);
  expect(ui.calls).toEqual(["dismiss:acme/two#2", "kill:acme/two#2"]);
  ui.unmount();
});

test("the cursor holds its place when the row under it is dismissed", async () => {
  const ui = mount(
    {
      "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
      "acme/two#2": entry({ title: "Two", updated_at: "2026-01-02T00:00:00Z" }),
      "acme/three#3": entry({
        title: "Three",
        updated_at: "2026-01-03T00:00:00Z",
      }),
    },
    true,
  );
  ui.stdin.write("j");
  await Bun.sleep(20);
  ui.stdin.write("j"); // last row
  await Bun.sleep(20);
  ui.stdin.write("x");
  await Bun.sleep(20);
  ui.stdin.write("x");
  await Bun.sleep(20);
  // the second x lands on what took the vacated slot, never back at row 1 —
  // dismiss force-removes the PR's worktree, so a wrong target loses work
  expect(ui.calls).toEqual(["dismiss:acme/three#3", "dismiss:acme/two#2"]);
  ui.unmount();
});

test("verbs are unavailable, with the reason shown, when the worktree or session is gone", async () => {
  const ui = mount({
    "acme/one#1": entry({
      status: "failed",
      session_id: undefined,
      worktrees: ["/vanished/pr-1"],
    }),
  });
  await Bun.sleep(20);
  const frame = ui.lastFrame() ?? "";
  expect(frame).toContain("worktree is gone: /vanished/pr-1");
  expect(frame).toContain("no session (failed)");

  // and the keys stay dead rather than launching something
  ui.stdin.write("s");
  ui.stdin.write("d");
  await Bun.sleep(20);
  expect(ui.requests).toEqual([]);
  ui.unmount();
});

test("the denials key opens the view only for a row that has denials", async () => {
  const ui = mount({
    "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D"); // row 1 has none: the queue stays put, and says why
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("acme/two#2"); // the queue, not a view
  expect(ui.lastFrame()).toContain("no denials");
  ui.stdin.write("j");
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("Bash(rg:*) — 2 denied");
  ui.unmount();
});

test("apply writes the group under the cursor, and rails block a write-shaped one", async () => {
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(git push:*)",
          count: 1,
          examples: ["git push origin HEAD"],
          writeShaped: true,
          alreadyAllowed: false,
        },
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a"); // cursor starts on the write-shaped group: no apply
  await Bun.sleep(20);
  let config = JSON.parse(readFileSync(ui.paths.configPath, "utf8"));
  expect(config.extra_allowed_tools ?? []).toEqual([]);
  ui.stdin.write("j"); // move to Bash(rg:*)
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  config = JSON.parse(readFileSync(ui.paths.configPath, "utf8"));
  expect(config.extra_allowed_tools).toEqual(["Bash(rg:*)"]);
  // the view reflects the write immediately, without restarting the TUI — and
  // says the rule landed, not that adding it again would fix nothing
  expect(ui.lastFrame()).toContain("applied — takes effect next run");
  expect(ui.lastFrame()).not.toContain("rule exists but didn't match");
  ui.unmount();
});

test("apply reads the config off disk, not the snapshot the TUI started with", async () => {
  // every suspend verb remounts App with the startup cfg prop; a rule applied
  // before the suspend would otherwise be offered for applying all over again
  const ui = mount(
    {
      "acme/two#2": entry({
        title: "Two",
        updated_at: "2026-01-02T00:00:00Z",
        denials: [
          {
            tool: "Bash",
            suggestion: "Bash(rg:*)",
            count: 2,
            examples: ["rg TODO src"],
            writeShaped: false,
            alreadyAllowed: false,
          },
        ],
      }),
    },
    false,
    JSON.stringify({ ...cfg, extra_allowed_tools: ["Bash(rg:*)"] }),
  );
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("rule already exists");
  expect(
    JSON.parse(readFileSync(ui.paths.configPath, "utf8")).extra_allowed_tools,
  ).toEqual(["Bash(rg:*)"]);
  ui.unmount();
});

test("the apply rail holds for a suggestion the classifier now calls write-shaped", async () => {
  // the flag on the entry froze when the run ended, before npx was blocklisted
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(npx:*)",
          count: 1,
          examples: ["npx prettier --write ."],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("read-only stance");
  expect(
    JSON.parse(readFileSync(ui.paths.configPath, "utf8")).extra_allowed_tools ??
      [],
  ).toEqual([]);
  ui.unmount();
});

test("apply writes through a symlinked config instead of replacing the link", async () => {
  // dotfiles setups point config.json at a file in their own repo; a rename
  // over the link leaves a regular file and orphans the repo copy
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  const real = join(dirname(ui.paths.configPath), "dotfiles-config.json");
  renameSync(ui.paths.configPath, real);
  symlinkSync(real, ui.paths.configPath);
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  expect(lstatSync(ui.paths.configPath).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8")).extra_allowed_tools).toEqual([
    "Bash(rg:*)",
  ]);
  ui.unmount();
});

test("hand-off scopes to the group under the cursor, or the whole batch on H", async () => {
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      local_path: "/repo",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(git push:*)",
          count: 1,
          examples: ["git push origin HEAD"],
          writeShaped: true,
          alreadyAllowed: false,
        },
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("j"); // cursor moves to Bash(rg:*)
  await Bun.sleep(20);
  ui.stdin.write("h"); // group scope: only the group under the cursor
  await Bun.sleep(20);
  expect(ui.requests).toHaveLength(1);
  expect(ui.requests[0]?.cwd).toBe("/repo");
  expect(ui.requests[0]?.argv[1]).toContain("Bash(rg:*)");
  expect(ui.requests[0]?.argv[1]).not.toContain("Bash(git push:*)");

  ui.stdin.write("H"); // batch scope: every group, cursor position irrelevant
  await Bun.sleep(20);
  expect(ui.requests).toHaveLength(2);
  expect(ui.requests[1]?.argv[1]).toContain("Bash(rg:*)");
  expect(ui.requests[1]?.argv[1]).toContain("Bash(git push:*)");
  ui.unmount();
});

test("an empty queue keeps the TUI open so poll can populate it", async () => {
  const ui = mount({});
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("No pending reviews");
  ui.stdin.write("p");
  await Bun.sleep(20);
  expect(ui.calls).toEqual(["poll"]);
  expect(ui.lastFrame()).toContain("No pending reviews"); // still mounted
  ui.unmount();
});
