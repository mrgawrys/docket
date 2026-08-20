# My PRs View and Auto-Receive Implementation Plan

> **To execute this plan:** use the `executing-plans` skill. It reviews the plan,
> then asks how you want it built — review at the end (delegated: one subagent
> builds it all, an independent review at the end), or review each task
> (inline: a diff per task for you to approve).

**Goal:** A second TUI view listing the user's authored PRs, with shell/diff/claude verbs and an opt-in headless `/receive-code-review` run when actionable feedback lands.

**Architecture:** Mine entries are a second entry kind in the existing pipeline, keyed `mine:org/repo#N` in the same `state.json`; kind is derived from the key, never stored. Feedback detection lives in sync, the run goes through the existing detached runner parameterized by a `RunPlan`, and a new `checkout.ts` resolves or creates the working copy. Spec: `docs/specs/2026-08-19-my-prs-receive-design.md`.

**Tech Stack:** Bun, TypeScript, Ink (existing stack; no new dependencies).

## Global Constraints

- `bun test` stays fully mocked: no network, no tokens, git only against scripted temp-dir repos.
- Every claude invocation goes through `claudeBin(cfg)` / `claudeEnv(cfg)`; every gh call through `ctx.gh` (account pinning).
- The receive allowlist must never contain push or GitHub-write verbs; the run prompt's fixed preamble forbids both.
- `worktrees[]` means "paths docket may delete" — nothing else ever goes in it.
- TUI tests stay thin (CLAUDE.md): logic in pure modules, at most crucial-behavior component tests.
- Any manual run instruction uses `DOCKET_CONFIG_DIR=$(mktemp -d) DOCKET_STATE_DIR=$(mktemp -d)`.
- Format with `bun run format`; each task ends with a commit.

---

### Task 1: Key namespace and Entry changes

**Units:** `src/state.ts` — `mine:` key namespace, `review_at` rename with read-time migration, new Entry fields, kind-filtered `pendingEntries`.

**Interacts:** every key consumer (`runLogPath` slug in `config.ts`, `normalizeKey` callers in `main.ts`/`list.ts`) keeps working for review keys unchanged; later tasks call the new helpers.

**Signatures:**
```ts
export type EntryKind = "review" | "mine";
export function entryKind(key: string): EntryKind;      // "mine:" prefix → "mine"
export function bareKey(key: string): string;           // strips the prefix; identity for review keys
// pendingEntries gains an optional filter; no-arg behavior unchanged:
export function pendingEntries(state: State, kind?: EntryKind): ...existing return type;
// Entry: my_review_at renamed to review_at; new optional fields:
//   checkout_path?: string; branch?: string; status gains "open"; flags[] may hold "draft"
```

**Constraints:** `normalizeKey` accepts `mine:org/repo#N` and `mine:` + PR URL, and **rejects** any other colon-shaped input — today `mine:org/repo#N` silently parses with `mine:org` as the org; that must become an error. `splitKey` returns bare repo/number (gh never sees the prefix). `runLogPath`'s slug maps `:` like `/` and `#`. `loadState` migrates `my_review_at` → `review_at` on read (old name gone on next save); document the generalized meaning ("the review event this entry last accounted for — mine kind: theirs; review kind: the user's") at the field definition. `sync.ts`'s existing writer/readers of `my_review_at` follow the rename in this task.

**Seams:** `normalizeKey`, `entryKind`, `bareKey`, `splitKey`, `pendingEntries`, `loadState` migration, `runLogPath` — all pure/fs-only, tested directly.

**Done when:** rejection cases, prefix round-trips, migration, and kind filtering are covered; the full existing suite passes untouched. Commit.

### Task 2: Checkout resolver

**Units:** `src/checkout.ts` — finds, validates, fast-forwards, or creates the working copy for a PR branch.

**Interacts:** called by sync (Task 5) at trigger time and by the runner (Task 4/5) as a pre-spawn re-check; nothing else touches it. Uses `parseWorktrees` from `worktree.ts`.

**Signatures:**
```ts
export type CheckoutResult =
  | { ok: true; path: string; owned: boolean }   // owned: docket created it this call (or previously, under checkoutsDir)
  | { ok: false; reason: string };               // "checkout dirty: <path>" | "checkout ahead of PR head: <path>" | git failure text
export function resolveCheckout(clone: string, branch: string, headSha: string, checkoutsDir: string): CheckoutResult;
```

**Constraints:** search order is `git worktree list --porcelain` in the clone (the clone itself is the first entry). A found checkout that is dirty (`status --porcelain` non-empty) or ahead of `headSha` (`rev-list <headSha>..HEAD` > 0) blocks — never fall through to creating a second copy of a branch that exists locally. Behind → `merge --ff-only <headSha>`. Not found anywhere → `git fetch origin <branch>` in the clone, then `git worktree add <checkoutsDir>/<slug>` tracking `origin/<branch>`; `owned: true` only on this path (a path under `checkoutsDir` found via worktree list is also `owned`). All git calls are subprocesses against the clone/checkout; no gh.

**Seams:** `resolveCheckout` against scripted git repos in temp dirs (a clone with a branch checked out in the clone, in a worktree, dirty, ahead, behind, and absent).

**Done when:** all six scenarios covered, including that the created worktree tracks the remote branch and lands under `checkoutsDir`. Commit.

### Task 3: Poll and sync detection (view data exists; nothing runs)

**Units:** `src/github.ts` — `searchMyPrs`, `prMineInfo`; `src/poll.ts` — second discovery loop; `src/sync.ts` — `decideMineSync` + mine branch of `reconcile`; `src/notify.ts` strings for feedback.

**Interacts:** poll creates `open` mine entries; reconcile updates them; `pendingEntries(state, "mine")` now returns real data. The auto-run call site is left as an explicit seam: reconcile calls a `triggerReceive(ctx, key, entry)` that this task stubs to "set verdict status only" (Task 5 replaces the body).

**Signatures:**
```ts
// github.ts
export function searchMyPrs(gh: GhCtx, owner: string): Candidate[];   // --author=@me, drafts KEPT; Candidate gains headRefName
export type PrMineInfo = { state: string; isDraft: boolean; headRefOid: string; headRefName: string;
                           reviews: { author: string; state: string; body: string; submittedAt: string }[] };
export function prMineInfo(gh: GhCtx, repo: string, number: number): PrMineInfo | null;
// sync.ts — pure, the tested core:
export type MineSyncDecision =
  | { kind: "done" }
  | { kind: "feedback"; at: string; verdict: "approved" | "changes-requested" | "commented" }
  | { kind: "none" };
export function decideMineSync(info: PrMineInfo, me: string, entry: Entry): MineSyncDecision;
```

**Constraints:** discovery iterates `[...cfg.orgs, myLogin]`, skips repos absent from `cfg.repos`, and never starts a run — new keys become `status: "open"` with `title`, `url`, `branch` (from `headRefName`), and `"draft"` in `flags` when applicable. Draft flag is refreshed on reconcile (drafts flip to ready-for-review). Actionable feedback = a review by someone other than `me`, `submittedAt > (entry.review_at ?? "")`, whose state is `CHANGES_REQUESTED`, `COMMENTED`, or `APPROVED` with a non-blank body — a bare comment-less `APPROVED` is not feedback. Verdict maps from the worst actionable state (changes-requested > commented > approved). On feedback: advance `review_at` to the newest actionable `submittedAt` **before** acting, notify, then call the trigger seam. Merged/closed → `done` + `cleanupEntry` (which only removes `worktrees[]` paths — no new guard needed). gh returning null leaves the entry as-is. Mine entries join reconcile's active set (they stay `open` until merged — the accepted per-poll `gh pr view` cost).

**Seams:** `decideMineSync` (pure); poll's discovery loop with a mocked gh; the reconcile mine-branch with mocked gh + temp state.

**Done when:** trigger matrix covered (each review state × bare/with-body × mine/others' authorship × before/after cursor), drafts listed but flagged, unmapped repos skipped, `docket poll --dry-run` lists authored PRs without creating runs. Commit.

### Task 4: Runner generalization (behavior-preserving)

**Units:** `src/reviewer.ts` — extract the run core parameterized by `RunPlan`; the review plan reproduces today's behavior exactly.

**Interacts:** `docket exec <key>` selects the plan by `entryKind(key)`; Task 5 supplies the mine plan. Spawn/tee/tail-parse/notify/status-write code moves, not changes.

**Signatures:**
```ts
export type RunPlan = {
  prompt: string;
  allowedTools: string[];
  cwd: string;
  discoverWorktrees: boolean;   // review: true (post-run pickReviewWorktrees); mine: false
  label: string;                // notification + log prefix: "review" | "receive"
};
export function runPlan(ctx: Ctx, key: string, entry: Entry): RunPlan;
```

**Constraints:** this task is a refactor — for review keys, prompts, allowlist, cwd, discovery, notifications, and every status/error write are byte-identical to before; the mine branch of `runPlan` throws "not yet wired" until Task 5. The existing reviewer tests must pass without assertion changes (test-harness plumbing may adapt).

**Seams:** the existing reviewer test suite is the regression harness; `runPlan` itself is pure and gets direct cases in Task 5.

**Done when:** full suite green with unchanged reviewer assertions. Commit.

### Task 5: Receive runs — config, prompt, trigger, CLI

**Units:** `src/receive.ts` — prompt builder and auto-run gate; `src/config.ts` — receive keys and allowlist; the real `triggerReceive` body in `src/sync.ts`; `docket receive` in `src/main.ts`.

**Interacts:** sync's trigger seam (Task 3) now resolves the checkout and starts a detached run via the Task 4 core; `runPlan`'s mine branch returns the receive plan; `docket receive <pr> ["note"]` mirrors `docket review` (URLs accepted via `normalizeKey`, note handed to the prompt).

**Signatures:**
```ts
// config.ts
//   Config gains: receive_enabled?: boolean; receive_prompt?: string; extra_receive_allowed_tools?: string[]
export const RECEIVE_ALLOWED_TOOLS: string[];   // review baseline + Edit, Write, MultiEdit, Bash(git add:*), Bash(git commit:*)
export function effectiveReceiveAllowedTools(cfg: Config): string[];
export function effectiveReceivePrompt(cfg: Config): string;   // default runs /receive-code-review for the PR
// receive.ts
export function receivePrompt(cfg: Config, key: string, entry: Entry, note?: string): string;
export function shouldAutoRun(cfg: Config, entry: Entry): { ok: true } | { ok: false; reason: string };
```

**Constraints:** `receivePrompt` wraps the configurable body in a fixed preamble — work only in `checkout_path`; edits and local commits allowed; never push; never write to GitHub — plus the existing summary instruction. `shouldAutoRun` requires `receive_enabled`, no `"draft"` flag, and is checked only on the automatic path — `docket receive`/`R` run regardless of the boolean but still refuse a blocked checkout. Trigger flow: `resolveCheckout` (clone from `cfg.repos`, `branch`, head sha from `prMineInfo`, `checkoutsDir` under `paths.stateDir`); blocked → `status: "skipped"`, `error: reason`, notify; usable → write `checkout_path` (and append to `worktrees[]` iff `owned`), then the detached spawn identical to review's. The run process re-runs `resolveCheckout` before spawning claude and downgrades to `skipped` if now blocked (TOCTOU guard). Run cwd is `checkout_path`. `configProblem` validates the three keys; `runLogPath` already handles mine keys (Task 1).

**Seams:** `receivePrompt`, `shouldAutoRun`, `effectiveReceive*` (pure); the trigger flow with mocked gh/spawn + scripted git repos; the CLI path via the existing main.ts test idiom.

**Done when:** an end-to-end mocked flow — feedback arrives → checkout resolved → detached run recorded with the receive allowlist and cwd → `ready` with session id — passes, plus the blocked and opted-out branches; the receive allowlist snapshot contains no push or gh verbs (assert the absence). Commit.

### Task 6: TUI mine view and the `n` input

**Units:** `src/tui/app.tsx` — `"mine"` view, tab toggle, per-view cursor, mine verb dispatch, footer input mode; `src/tui/legend.tsx` — `MINE_KEYS` + footer; `src/list.ts` — `buildFreshChat`, mine-aware `buildResume` cwd, sectioned `printPending`; `src/openers.ts` — `{worktree}` from `checkout_path` for mine entries; `src/tui/queue.tsx` — `open`/verdict/draft chips; new pure helper `parsePrInput` (in `src/list.ts`).

**Interacts:** rows from `pendingEntries(state, kind)` per view; verbs reuse `SuspendRequest`; `n` feeds `actions.review` (queue view) or `actions.receive` (mine view); `TuiActions` gains `receive(key, note?)`.

**Signatures:**
```ts
export function buildFreshChat(entry: Entry, cfg: Config): SuspendRequest;   // bare claude in checkout_path
export function parsePrInput(input: string, cfg: Config): { key: string; note?: string } | { error: string };
```

**Constraints:** `tab` toggles queue ↔ mine from either; each view keeps its own cursor/scroll. Mine verbs: `enter` resumes the receive session with cwd `checkout_path`, falls back to `buildFreshChat` when no session but a checkout exists, greyed with reason otherwise; `s`/`d` via openers with `{worktree}` = `checkout_path`; `R` = manual receive (ignores `receive_enabled`; the `unavailable` map greys it only for statically known reasons — no clone mapped, a run already in flight — while a dirty/ahead checkout is refused by the Task 5 trigger flow and surfaces as `skipped` + reason in the panel, since probing git per row per render is too heavy); `w`/`K`/`x` inherited. `n` opens a one-line footer input in both views — pasted URL or `ORG/REPO#N`, optional trailing note after whitespace; `enter` submits, `esc` cancels; `parsePrInput` rejects unmapped repos and bad shapes with the reason shown in the footer. Panel: run headline via the existing `assessment.ts` path when a run happened, else the verdict + newest reviewer name from sync-fetched data. In the mine view the denials machinery targets `extra_receive_allowed_tools`, and a denied push/GitHub-write call is labeled as the guardrail working, not offered as an addable rule.

**Seams:** `parsePrInput`, `buildFreshChat`, the openers context change, `printPending` sectioning — pure; no TUI component tests (the blocked-checkout refusal is Task 5's flow test).

**Done when:** pure-module tests pass; manually verified with scratch dirs (`DOCKET_CONFIG_DIR=$(mktemp -d) DOCKET_STATE_DIR=$(mktemp -d) bun src/main.ts`) that both views render, tab and `n` behave, and mine verbs grey with reasons on an entry without a checkout. Commit.

### Task 7: Wizard, doctor, docs

**Units:** `src/wizard/*` — the receive question in both routes; `src/doctor.ts` — receive checks; `README.md`, `docs/configuration.md`, `config.example.json`.

**Interacts:** wizard writes `receive_enabled`/`receive_prompt` via the existing `writeConfigText` path; doctor reads the same keys.

**Constraints:** the quick wizard asks "also act on reviews you receive?" (yes/no → `receive_enabled`), with the same `$EDITOR` option for a custom `receive_prompt` the review-prompt step has; the claude-guided wizard's brief gains the same option. **Neither route ever overwrites an existing non-default `receive_prompt`** — present values are read-only unless explicitly edited (the `review_prompt` deletion incident is the reason this is a hard rule). Doctor, when `receive_enabled`: `receive_prompt` non-blank if set, the `receive-code-review` skill/plugin installed (same probe style as the `/code-review` check), receive allowlist entries well-formed. README Requirements/Setup, the configuration reference, and `config.example.json` document the three keys and the new view/verbs.

**Seams:** doctor checks and wizard config-writing logic (pure/mocked, existing idiom); docs are read back, not tested.

**Done when:** doctor fails on a `receive_enabled` config without the skill installed and passes with it (mocked probe); wizard tests cover the never-overwrite rule; docs read back consistent with the spec. Commit.
