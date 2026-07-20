import { searchReviewRequests } from "./github";
import { reviewPr, type Ctx } from "./reviewer";
import { loadState } from "./state";
import { reconcile } from "./sync";

export async function pollCycle(ctx: Ctx, dry: boolean): Promise<void> {
  if (!dry) reconcile(ctx);
  ctx.log(`polling ${ctx.cfg.orgs.join(", ")} for review requests`);

  for (const org of ctx.cfg.orgs) {
    for (const c of searchReviewRequests(ctx.gh, org)) {
      const key = `${c.repo}#${c.number}`;
      if (loadState(ctx.paths.statePath)[key]) continue; // known PR — never re-review
      if (dry) {
        console.log(`would review: ${key} — ${c.title}`);
      } else {
        await reviewPr(ctx, key, c.repo, String(c.number), c.title, c.url);
      }
    }
  }

  const { reviewed, failed, skipped, synced } = ctx.counters;
  if (dry) {
    ctx.log("poll complete (dry run)");
  } else if (reviewed + failed + skipped + synced === 0) {
    ctx.log("poll complete: nothing new");
  } else {
    ctx.log(`poll complete: ${reviewed} reviewed, ${failed} failed, ${skipped} skipped, ${synced} synced`);
  }
}
