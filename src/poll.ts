import { ghUser, myTeams, reviewRequesters, searchReviewRequests, type ReviewRequesters } from "./github";
import { startReview, type Ctx } from "./reviewer";
import { loadState } from "./state";
import { reconcile } from "./sync";

// Should this candidate be skipped as "only requested via ignored teams"?
// Returns the responsible teams, or null to review. Missing data (a failed
// gh call for login, requesters, or membership) fails open: the PR gets reviewed.
export function skipVia(
  login: string | null,
  requested: ReviewRequesters | null,
  memberOf: string[] | null,
  ignored: string[],
): string[] | null {
  if (!login || !requested || !memberOf) return null;
  if (requested.users.includes(login)) return null;
  const mine = requested.teams.filter((t) => memberOf.includes(t));
  if (mine.length === 0) return null;
  return mine.every((t) => ignored.includes(t)) ? mine : null;
}

export async function pollCycle(ctx: Ctx, dry: boolean): Promise<void> {
  if (!dry) reconcile(ctx);
  ctx.log(`polling ${ctx.cfg.orgs.join(", ")} for review requests`);

  const ignored = ctx.cfg.ignored_teams ?? [];
  // membership is stable within a cycle — fetch it at most once, lazily
  let me: { login: string | null; teams: string[] | null } | null = null;

  for (const org of ctx.cfg.orgs) {
    for (const c of searchReviewRequests(ctx.gh, org)) {
      const key = `${c.repo}#${c.number}`;
      if (loadState(ctx.paths.statePath)[key]) continue; // known PR — never re-review
      if (ignored.length > 0) {
        me ??= { login: ghUser(ctx.gh), teams: myTeams(ctx.gh) };
        const req = reviewRequesters(ctx.gh, c.repo, String(c.number));
        const via = skipVia(me.login, req, me.teams, ignored);
        if (via) {
          // no state entry: a later direct request must resurface this PR
          if (dry) console.log(`would skip (via ${via.join(", ")}): ${key}`);
          else ctx.log(`SKIP ${key}: requested only via ${via.join(", ")}`);
          continue;
        }
      }
      if (dry) {
        console.log(`would review: ${key} — ${c.title}`);
      } else {
        await startReview(ctx, key, c.repo, c.title, c.url);
      }
    }
  }

  const { started, failed, skipped, synced } = ctx.counters;
  if (dry) {
    ctx.log("poll complete (dry run)");
  } else if (started + failed + skipped + synced === 0) {
    ctx.log("poll complete: nothing new");
  } else {
    ctx.log(`poll complete: ${started} started, ${failed} failed, ${skipped} skipped, ${synced} synced`);
  }
}
