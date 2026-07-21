import { appendFileSync } from "node:fs";
import type { Logger } from "./log";

export interface GhCtx {
  gh: string;
  log: Logger;
  logPath: string;
  env: Record<string, string>;
}

export interface Candidate {
  repo: string;
  number: number;
  title: string;
  url: string;
}

function gh(ctx: GhCtx, args: string[]): string | null {
  const p = Bun.spawnSync([ctx.gh, ...args], { stderr: "pipe", env: ctx.env });
  const err = p.stderr.toString();
  if (err) appendFileSync(ctx.logPath, err);
  if (p.exitCode !== 0) return null;
  return p.stdout.toString();
}

export function ghUser(ctx: GhCtx): string | null {
  const out = gh(ctx, ["api", "user", "--jq", ".login"]);
  const login = out?.trim();
  return login ? login : null;
}

export function prView<T>(ctx: GhCtx, repo: string, number: string, fields: string): T | null {
  const out = gh(ctx, ["pr", "view", number, "--repo", repo, "--json", fields]);
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

interface SearchRow {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  repository: { nameWithOwner: string };
}

export function searchReviewRequests(ctx: GhCtx, org: string): Candidate[] {
  const out = gh(ctx, [
    "search", "prs", "--review-requested=@me", "--state=open",
    "--owner", org, "--limit", "100",
    "--json", "number,title,url,isDraft,repository",
  ]);
  if (out === null) {
    ctx.log(`gh search failed for org ${org}`);
    return [];
  }
  let rows: SearchRow[];
  try {
    rows = JSON.parse(out) as SearchRow[];
  } catch {
    ctx.log(`gh search failed for org ${org}`);
    return [];
  }
  return rows
    .filter((r) => !r.isDraft)
    .map((r) => ({
      repo: r.repository.nameWithOwner,
      number: r.number,
      title: r.title,
      url: r.url,
    }));
}
