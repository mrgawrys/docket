import { ghUser, prMineInfo, prView, type PrMineInfo } from "./github";
import { feedbackNotification, notify } from "./notify";
import { prepareCheckout, shouldAutoRun } from "./receive";
import {
  cleanupEntry,
  spawnRunner,
  type Ctx,
  type StartResult,
} from "./reviewer";
import {
  isLiveReview,
  bareKey,
  entryKind,
  loadState,
  markDone,
  markReviewed,
  patchEntry,
  splitKey,
  type Entry,
  type Verdict,
} from "./state";

export interface PrSyncInfo {
  state: string;
  latestReviews?: {
    author?: { login?: string };
    state?: string;
    submittedAt?: string;
  }[];
  reviewRequests?: { login?: string }[];
  commits?: { committedDate?: string }[];
}

export type SyncDecision =
  | { kind: "unchanged" }
  | { kind: "done"; reason: "merged" | "closed" }
  | { kind: "reviewed"; verdict: Verdict; reviewedAt: string; flags: string[] };

export function decideSync(info: PrSyncInfo, me: string): SyncDecision {
  if (info.state === "MERGED") return { kind: "done", reason: "merged" };
  if (info.state === "CLOSED") return { kind: "done", reason: "closed" };
  const rev = (info.latestReviews ?? []).find((r) => r.author?.login === me);
  if (!rev) return { kind: "unchanged" };
  const verdict = (rev.state ?? "")
    .toLowerCase()
    .replaceAll("_", "-") as Verdict;
  const flags: string[] = [];
  if ((info.reviewRequests ?? []).some((r) => r.login === me))
    flags.push("re-requested");
  const lastCommit = (info.commits ?? []).at(-1)?.committedDate ?? "";
  if (lastCommit > (rev.submittedAt ?? "")) flags.push("new-commits");
  return {
    kind: "reviewed",
    verdict,
    reviewedAt: rev.submittedAt ?? "",
    flags,
  };
}

export type MineSyncDecision =
  | { kind: "done" }
  | {
      kind: "feedback";
      at: string;
      verdict: "approved" | "changes-requested" | "commented";
      // Who left the newest actionable review — the panel shows it, and the
      // TUI never fetches, so sync records it on the entry.
      reviewer: string;
    }
  | { kind: "none" };

// Verdict severity for "the worst actionable state wins".
const VERDICT_RANK: Record<Verdict, number> = {
  "changes-requested": 2,
  commented: 1,
  approved: 0,
};

// Actionable feedback on the user's PR: a review by someone else, newer than
// the entry's cursor, that is not a bare comment-less approval.
export function decideMineSync(
  info: PrMineInfo,
  me: string,
  entry: Entry,
): MineSyncDecision {
  if (info.state === "MERGED" || info.state === "CLOSED")
    return { kind: "done" };
  const cursor = entry.review_at ?? "";
  const actionable = info.reviews.filter(
    (r) =>
      r.author !== me &&
      r.submittedAt > cursor &&
      (r.state === "CHANGES_REQUESTED" ||
        r.state === "COMMENTED" ||
        (r.state === "APPROVED" && r.body.trim() !== "")),
  );
  if (actionable.length === 0) return { kind: "none" };
  const worst = actionable.reduce((a, b) =>
    VERDICT_RANK[toVerdict(b.state)] > VERDICT_RANK[toVerdict(a.state)] ? b : a,
  );
  const newest = actionable.reduce((a, b) =>
    b.submittedAt > a.submittedAt ? b : a,
  );
  return {
    kind: "feedback",
    at: newest.submittedAt,
    verdict: toVerdict(worst.state),
    reviewer: newest.author,
  };
}

const toVerdict = (state: string): Verdict =>
  state.toLowerCase().replaceAll("_", "-") as Verdict;

export type Feedback = Extract<MineSyncDecision, { kind: "feedback" }>;

// What happens when actionable feedback lands, after syncMine has recorded
// the verdict and advanced the cursor. Injectable so tests can pin it.
export type TriggerReceive = (
  ctx: Ctx,
  key: string,
  entry: Entry,
  fb: Feedback,
) => Promise<void>;

// The automatic path: opt-in, never on drafts. When the gate says no, the
// verdict syncMine already wrote is the whole reaction.
export const triggerReceive: TriggerReceive = async (ctx, key, entry) => {
  const gate = shouldAutoRun(ctx.cfg, entry);
  if (!gate.ok) {
    ctx.log(`SYNC ${key}: not auto-running (${gate.reason})`);
    return;
  }
  await startReceive(ctx, key, entry);
};

// Resolve the checkout and hand the key to a detached receive runner — the
// shared body of the automatic trigger, `docket receive`, and the R verb.
export async function startReceive(
  ctx: Ctx,
  key: string,
  entry: Entry,
  note?: string,
): Promise<StartResult> {
  const { statePath } = ctx.paths;
  if (isLiveReview(entry)) {
    ctx.log(
      `SKIP ${key}: a receive run is already in flight (pid ${entry.pid})`,
    );
    return "already-running";
  }
  if (note !== undefined) patchEntry(statePath, key, { note });
  const prep = prepareCheckout(ctx, key, entry);
  if (!prep.ok) {
    ctx.log(`SKIP ${key}: ${prep.reason}`);
    patchEntry(statePath, key, { status: "skipped", error: prep.reason });
    await notify(ctx.cfg, "docket: receive blocked", prep.reason);
    ctx.counters.skipped++;
    return "skipped";
  }
  patchEntry(statePath, key, { status: "reviewing" });
  return spawnRunner(ctx, key);
}

async function syncMine(
  ctx: Ctx,
  key: string,
  entry: Entry,
  me: string,
  trigger: TriggerReceive,
): Promise<void> {
  const { statePath } = ctx.paths;
  const { repo, number } = splitKey(key);
  const info = prMineInfo(ctx.gh, repo, number);
  if (!info) {
    ctx.log(`SYNC ${key}: gh pr view failed, leaving entry as-is`);
    return;
  }
  const d = decideMineSync(info, me, entry);
  if (d.kind === "done") {
    const reason = info.state === "MERGED" ? "merged" : "closed";
    markDone(statePath, key, reason);
    cleanupEntry(ctx, key, "SYNC");
    ctx.log(`SYNC ${key}: PR ${reason} — marked done`);
    ctx.counters.synced++;
    return;
  }

  // Drafts flip to ready-for-review, and a force-recreated PR can change its
  // head branch — refresh both from what gh just said.
  const flags = (entry.flags ?? []).filter((f) => f !== "draft");
  if (info.isDraft) flags.push("draft");
  const changed =
    flags.join(" ") !== (entry.flags ?? []).join(" ") ||
    (info.headRefName !== "" && info.headRefName !== entry.branch);
  if (changed) {
    patchEntry(statePath, key, {
      flags,
      ...(info.headRefName ? { branch: info.headRefName } : {}),
    });
    entry = loadState(statePath)[key] ?? entry;
  }

  if (d.kind !== "feedback") return;
  // Advance the cursor and record their verdict before acting: the same
  // review must never re-trigger, even if the trigger path crashes.
  patchEntry(statePath, key, {
    status: d.verdict,
    review_at: d.at,
    reviewer: d.reviewer,
  });
  ctx.log(`SYNC ${key}: ${d.reviewer} left feedback (${d.verdict})`);
  ctx.counters.synced++;
  const n = feedbackNotification(bareKey(key), d.verdict, d.reviewer);
  await notify(ctx.cfg, n.title, n.body);
  await trigger(ctx, key, loadState(statePath)[key] ?? entry, d);
}

export async function reconcile(
  ctx: Ctx,
  trigger: TriggerReceive = triggerReceive,
): Promise<void> {
  const { statePath } = ctx.paths;
  const active = Object.entries(loadState(statePath)).filter(
    ([, e]) => e.status !== "done" && e.status !== "reviewing",
  );
  if (active.length === 0) return;

  const me = ghUser(ctx.gh);
  if (!me) {
    ctx.log("sync: cannot resolve GitHub login, skipping");
    return;
  }

  for (const [key, entry] of active) {
    if (entryKind(key) === "mine") {
      await syncMine(ctx, key, entry, me, trigger);
      continue;
    }
    const { repo, number } = splitKey(key);
    const info = prView<PrSyncInfo>(
      ctx.gh,
      repo,
      number,
      "state,latestReviews,reviewRequests,commits",
    );
    if (!info) {
      ctx.log(`SYNC ${key}: gh pr view failed, leaving entry as-is`);
      continue;
    }
    const d = decideSync(info, me);
    if (d.kind === "done") {
      markDone(statePath, key, d.reason);
      cleanupEntry(ctx, key, "SYNC");
      ctx.log(`SYNC ${key}: PR ${d.reason} — marked done`);
      ctx.counters.synced++;
    } else if (d.kind === "reviewed") {
      const cur = `${entry.status} ${(entry.flags ?? []).join(" ")}`;
      const next = `${d.verdict} ${d.flags.join(" ")}`;
      if (cur !== next) {
        markReviewed(statePath, key, d.verdict, d.reviewedAt, d.flags);
        ctx.log(
          `SYNC ${key}: you reviewed (${d.verdict})${d.flags.length ? ` [${d.flags.join(" ")}]` : ""}`,
        );
        ctx.counters.synced++;
      }
    }
  }
}
