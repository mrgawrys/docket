import { ghUser, prView } from "./github";
import { removeWorktree, type Ctx } from "./reviewer";
import { loadState, markDone, markReviewed, splitKey, type Verdict } from "./state";

export interface PrSyncInfo {
  state: string;
  latestReviews?: { author?: { login?: string }; state?: string; submittedAt?: string }[];
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
  const verdict = (rev.state ?? "").toLowerCase().replaceAll("_", "-") as Verdict;
  const flags: string[] = [];
  if ((info.reviewRequests ?? []).some((r) => r.login === me)) flags.push("re-requested");
  const lastCommit = (info.commits ?? []).at(-1)?.committedDate ?? "";
  if (lastCommit > (rev.submittedAt ?? "")) flags.push("new-commits");
  return { kind: "reviewed", verdict, reviewedAt: rev.submittedAt ?? "", flags };
}

export function reconcile(ctx: Ctx): void {
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
    const { repo, number } = splitKey(key);
    const info = prView<PrSyncInfo>(
      ctx.gh, repo, number, "state,latestReviews,reviewRequests,commits",
    );
    if (!info) {
      ctx.log(`SYNC ${key}: gh pr view failed, leaving entry as-is`);
      continue;
    }
    const d = decideSync(info, me);
    if (d.kind === "done") {
      markDone(statePath, key, d.reason);
      removeWorktree(ctx, key, "SYNC");
      ctx.log(`SYNC ${key}: PR ${d.reason} — marked done`);
      ctx.counters.synced++;
    } else if (d.kind === "reviewed") {
      const cur = `${entry.status} ${(entry.flags ?? []).join(" ")}`;
      const next = `${d.verdict} ${d.flags.join(" ")}`;
      if (cur !== next) {
        markReviewed(statePath, key, d.verdict, d.reviewedAt, d.flags);
        ctx.log(`SYNC ${key}: you reviewed (${d.verdict})${d.flags.length ? ` [${d.flags.join(" ")}]` : ""}`);
        ctx.counters.synced++;
      }
    }
  }
}
