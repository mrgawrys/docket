// The scenario catalog: the single source of mock data for `bun run demo` and
// `bun run frames`. Fixtures are typed against src/ so a schema change breaks
// the demo at compile time, not at render time.

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "../src/config";
import type { Entry, State } from "../src/state";
import type { SandboxDirs } from "./sandbox";

export interface Scenario {
  description: string;
  // Absent: no config.json is seeded — the wizard's "no-config" trigger.
  config?: Config;
  state: State;
  env?: Record<string, string>; // shim knobs layered over sandbox env
  hint?: string; // e.g. "press D for the denials view"
  args?: string[]; // CLI args for demo.ts; default [] = bare queue
  interactiveOnly?: boolean; // wizard: skipped by frames
}

// Repo and entry paths are root-relative in the catalog — the scratch dir only
// exists at seed time — and seedScenario materializes them as real directories
// so verbs land somewhere instead of erroring on a path that never existed.
const cfg = (repos: Record<string, string>, extra?: Partial<Config>): Config => ({
  orgs: ["testorg"],
  repos,
  ...extra,
});

const entry = (over: Partial<Entry> & { updated_at: string }): Entry => ({
  status: "ready",
  session_id: "sess-1234",
  ...over,
});

const fullState: State = {
  "testorg/api#412": entry({
    title: "Add rate limiting to the public API",
    url: "https://example.test/api/pull/412",
    local_path: "repos/api",
    summary: {
      headline: "Token bucket resets on every deploy — limits are advisory",
      issues: 3,
      risk: "high",
    },
    denials: [
      {
        tool: "Bash",
        suggestion: "Bash(rg:*)",
        count: 4,
        examples: ["rg -n 'bucket' src", "rg --files-with-matches limiter"],
        writeShaped: false,
        alreadyAllowed: false,
      },
    ],
    updated_at: "2026-08-18T09:12:00Z",
  }),
  "testorg/web#98": entry({
    title: "Fix flaky dark-mode toggle test",
    url: "https://example.test/web/pull/98",
    local_path: "repos/web",
    summary: {
      headline: "Straightforward await fix, matches the test style guide",
      issues: 0,
      risk: "low",
    },
    updated_at: "2026-08-18T10:30:00Z",
  }),
  "testorg/api#415": entry({
    title: "Migrate sessions table to ULID keys",
    url: "https://example.test/api/pull/415",
    local_path: "repos/api",
    summary: {
      headline: "Backfill runs in one transaction — locks the table",
      issues: 1,
      risk: "medium",
    },
    updated_at: "2026-08-18T11:05:00Z",
  }),
  "testorg/infra#33": entry({
    title: "Bump the CI runner image",
    url: "https://example.test/infra/pull/33",
    local_path: "repos/infra",
    summary: {
      headline: "Routine bump, changelog reviewed",
      issues: 0,
      risk: "low",
    },
    updated_at: "2026-08-18T12:47:00Z",
  }),
  "testorg/web#101": entry({
    title: "Server-render the pricing page",
    url: "https://example.test/web/pull/101",
    local_path: "repos/web",
    summary: {
      headline: "Hydration mismatch on the currency selector",
      issues: 2,
      risk: "medium",
    },
    updated_at: "2026-08-18T14:02:00Z",
  }),
};

const fullConfig = cfg({
  "testorg/api": "repos/api",
  "testorg/web": "repos/web",
  "testorg/infra": "repos/infra",
});

export const scenarios: Record<string, Scenario> = {
  full: {
    description: "mixed verdicts and risks, one row with a denial chip",
    config: fullConfig,
    state: fullState,
    hint: "j/k move, x dismisses, D on the ⊘ row opens the denials view",
  },
  empty: {
    description: "valid setup, nothing pending",
    config: cfg({ "testorg/demo": "repos/demo" }),
    state: {},
    hint: "p polls — the gh shim answers with a demo PR",
  },
  denials: {
    description: "one review with safe, write-shaped and already-covered denials",
    config: cfg(
      { "testorg/api": "repos/api" },
      { extra_allowed_tools: ["Bash(fd:*)"] },
    ),
    state: {
      "testorg/api#412": entry({
        title: "Add rate limiting to the public API",
        url: "https://example.test/api/pull/412",
        local_path: "repos/api",
        summary: {
          headline: "Review finished; several tool calls were denied",
          issues: 1,
          risk: "medium",
        },
        denials: [
          {
            tool: "Bash",
            suggestion: "Bash(rg:*)",
            count: 4,
            examples: ["rg -n 'bucket' src", "rg --files-with-matches limiter"],
            writeShaped: false,
            alreadyAllowed: false,
          },
          {
            tool: "Bash",
            suggestion: "Bash(gh pr comment:*)",
            count: 1,
            examples: ["gh pr comment 412 --body 'left inline notes'"],
            writeShaped: true,
            alreadyAllowed: false,
          },
          {
            tool: "Bash",
            suggestion: "Bash(fd:*)",
            count: 2,
            examples: ["fd limiter src"],
            writeShaped: false,
            alreadyAllowed: true,
          },
        ],
        updated_at: "2026-08-18T09:12:00Z",
      }),
    },
    hint: "press D for the denials view — a adds the safe rule only",
  },
  failed: {
    description: "a failed run with denials and no session to resume",
    config: cfg({ "testorg/api": "repos/api" }),
    state: {
      "testorg/api#413": entry({
        status: "failed",
        session_id: undefined,
        error: "claude exited 1 before writing a session",
        title: "Extract the billing webhooks",
        url: "https://example.test/api/pull/413",
        local_path: "repos/api",
        denials: [
          {
            tool: "Bash",
            suggestion: "Bash(rg:*)",
            count: 2,
            examples: ["rg -n webhook src"],
            writeShaped: false,
            alreadyAllowed: false,
          },
        ],
        updated_at: "2026-08-18T09:40:00Z",
      }),
    },
    hint: "enter hands the denials to claude — there is no session to resume",
  },
  running: {
    description: "a review in flight (the demo launcher backs it with a live pid)",
    config: cfg({ "testorg/web": "repos/web" }),
    state: {
      "testorg/web#102": entry({
        status: "reviewing",
        session_id: undefined,
        pid: 0,
        title: "Rework the signup funnel",
        url: "https://example.test/web/pull/102",
        local_path: "repos/web",
        updated_at: "2026-08-18T15:00:00Z",
      }),
    },
    hint: "w watches the run, K kills the live runner",
  },
  "auth-warning": {
    description: "the full queue with claude logged out — footer warning visible",
    config: fullConfig,
    state: fullState,
    // A fixed dir, not the developer's real one — the footer names it, so a
    // real path would make the frame machine-specific.
    env: { CLAUDE_LOGGED_OUT: "1", CLAUDE_CONFIG_DIR: "/tmp/docket-demo-claude" },
    hint: "the footer warns that claude is not logged in",
  },
  wizard: {
    description: "first run, no config — the setup offer (interactive only)",
    state: {},
    env: { GH_ORG_LIST: "testorg" },
    hint: "answer the offer — the gh shim plays GitHub",
    interactiveOnly: true,
  },
  mine: {
    description:
      "your authored PRs: feedback waiting, a finished receive run, a draft, a blocked checkout",
    config: cfg({ "testorg/api": "repos/api", "testorg/web": "repos/web" }),
    state: {
      // one review-kind row so tabbing back shows a populated queue
      "testorg/api#412": entry({
        title: "Add rate limiting to the public API",
        url: "https://example.test/api/pull/412",
        local_path: "repos/api",
        summary: {
          headline: "Token bucket resets on every deploy — limits are advisory",
          issues: 3,
          risk: "high",
        },
        updated_at: "2026-08-18T09:12:00Z",
      }),
      "mine:testorg/api#77": entry({
        status: "changes-requested",
        session_id: undefined,
        title: "Split the poller into discover and reconcile",
        url: "https://example.test/api/pull/77",
        local_path: "repos/api",
        branch: "poller-split",
        checkout_path: "repos/api-77",
        reviewer: "carol",
        review_at: "2026-08-19T16:20:00Z",
        updated_at: "2026-08-19T16:21:00Z",
      }),
      "mine:testorg/web#98": entry({
        status: "ready",
        title: "Migrate the settings page off the legacy grid",
        url: "https://example.test/web/pull/98",
        local_path: "repos/web",
        branch: "settings-grid",
        checkout_path: "repos/web-98",
        worktrees: ["repos/web-98"],
        reviewer: "dave",
        review_at: "2026-08-19T11:05:00Z",
        summary: {
          headline: "Addressed both review threads; two commits, ready to push",
          issues: 2,
          risk: "low",
        },
        updated_at: "2026-08-19T11:30:00Z",
      }),
      "mine:testorg/web#101": entry({
        status: "skipped",
        session_id: undefined,
        error: "checkout dirty: repos/web",
        title: "Inline the notification templates",
        url: "https://example.test/web/pull/101",
        local_path: "repos/web",
        branch: "notif-templates",
        reviewer: "carol",
        review_at: "2026-08-19T18:02:00Z",
        updated_at: "2026-08-19T18:03:00Z",
      }),
      "mine:testorg/api#80": entry({
        status: "open",
        session_id: undefined,
        title: "Sketch: split app.tsx by view",
        url: "https://example.test/api/pull/80",
        local_path: "repos/api",
        branch: "app-split",
        flags: ["draft"],
        updated_at: "2026-08-19T19:00:00Z",
      }),
    },
    hint: "tab toggles between the review queue and your PRs",
  },
};

const materializePath = (root: string, p: string): string => {
  const abs = isAbsolute(p) ? p : join(root, p);
  mkdirSync(abs, { recursive: true });
  return abs;
};

export function seedScenario(
  dirs: SandboxDirs,
  s: Scenario,
  opts: { runningPid?: number } = {},
): void {
  if (s.config) {
    const config: Config = {
      ...s.config,
      repos: Object.fromEntries(
        Object.entries(s.config.repos).map(([repo, path]) => [
          repo,
          materializePath(dirs.root, path),
        ]),
      ),
    };
    writeFileSync(
      join(dirs.configDir, "config.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
  }
  const state: State = {};
  for (const [key, e] of Object.entries(s.state)) {
    // copies throughout — the catalog object must survive a seed untouched
    const out: Entry = { ...e };
    if (out.local_path)
      out.local_path = materializePath(dirs.root, out.local_path);
    if (out.checkout_path)
      out.checkout_path = materializePath(dirs.root, out.checkout_path);
    if (out.worktrees)
      out.worktrees = out.worktrees.map((w) => materializePath(dirs.root, w));
    if (out.status === "reviewing" && opts.runningPid !== undefined)
      out.pid = opts.runningPid;
    state[key] = out;
  }
  writeFileSync(
    join(dirs.stateDir, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
}
