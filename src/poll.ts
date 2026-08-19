import { claudeAuth } from "./auth";
import {
  ghUser,
  myTeams,
  prView,
  reviewRequesters,
  searchMyPrs,
  searchReviewRequests,
  type ReviewRequesters,
} from "./github";
import { notify } from "./notify";
import { startReview, type Ctx } from "./reviewer";
import { loadState, timestamp, updateEntry, type State } from "./state";
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

// Discover PRs the user authored (mapped repos only) as `open` mine entries.
// No run ever starts here — feedback, not existence, triggers work (reconcile).
function discoverMine(ctx: Ctx, dry: boolean, known: State): void {
  const login = ghUser(ctx.gh);
  if (!login) {
    ctx.log("poll: cannot resolve GitHub login, skipping authored PRs");
    return;
  }
  const seen = new Set<string>(); // one PR can match several owner searches
  for (const owner of [...ctx.cfg.orgs, login]) {
    for (const c of searchMyPrs(ctx.gh, owner)) {
      const key = `mine:${c.repo}#${c.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(c.repo in ctx.cfg.repos)) continue; // unmapped repo: not listed
      if (known[key]) continue;
      if (dry) {
        console.log(`would track (mine): ${key} — ${c.title}`);
        continue;
      }
      // The search API has no head-ref field, so a newly discovered PR costs
      // one pr view for its branch; reconcile keeps it fresh afterwards.
      const info = prView<{ headRefName?: string }>(
        ctx.gh,
        c.repo,
        String(c.number),
        "headRefName",
      );
      updateEntry(ctx.paths.statePath, key, () => ({
        status: "open",
        title: c.title,
        url: c.url,
        local_path: ctx.cfg.repos[c.repo],
        ...(info?.headRefName ? { branch: info.headRefName } : {}),
        ...(c.isDraft ? { flags: ["draft"] } : {}),
        updated_at: timestamp(),
      }));
      ctx.log(`TRACK ${key}: authored PR — ${c.title}`);
    }
  }
}

export async function pollCycle(ctx: Ctx, dry: boolean): Promise<void> {
  if (!dry) await reconcile(ctx);

  // Every review started while logged out fails and writes a state entry, and
  // a known key is never re-reviewed — so an auth outage silently burns the
  // whole queue. Returning first leaves those PRs to resurface next cycle.
  const auth = claudeAuth(ctx.cfg);
  if ("unknown" in auth) {
    ctx.log(`auth check inconclusive (${auth.unknown}) — polling anyway`);
  } else if (!auth.ok) {
    ctx.log(
      `poll aborted: claude is not logged in (${auth.dir}) — run: docket doctor`,
    );
    await notify(
      ctx.cfg,
      "docket: claude is not logged in",
      "run docket doctor",
    );
    return;
  }

  ctx.log(`polling ${ctx.cfg.orgs.join(", ")} for review requests`);

  const ignored = ctx.cfg.ignored_teams ?? [];
  // membership is stable within a cycle — fetch it at most once, lazily
  let me: { login: string | null; teams: string[] | null } | null = null;
  // snapshot is safe: each candidate key appears at most once per cycle
  const known = loadState(ctx.paths.statePath);

  for (const org of ctx.cfg.orgs) {
    for (const c of searchReviewRequests(ctx.gh, org)) {
      const key = `${c.repo}#${c.number}`;
      if (known[key]) continue; // known PR — never re-review
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

  discoverMine(ctx, dry, known);

  const { started, failed, skipped, synced } = ctx.counters;
  if (dry) {
    ctx.log("poll complete (dry run)");
  } else if (started + failed + skipped + synced === 0) {
    ctx.log("poll complete: nothing new");
  } else {
    ctx.log(
      `poll complete: ${started} started, ${failed} failed, ${skipped} skipped, ${synced} synced`,
    );
  }
}
