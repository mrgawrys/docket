import { appendFileSync } from "node:fs";
import type { Logger } from "./log";

export interface GhCtx {
  gh: string;
  log: Logger;
  logPath: string;
  env: Record<string, string>;
  login?: string; // cached by ghUser — the login can't change within a process
}

// Resolve a token for a pinned gh account. The single code path both withCtx
// (to set GH_TOKEN) and doctor (to verify that exact setup) go through.
export function ghAccountToken(gh: string, account: string): { token: string } | { error: string } {
  try {
    const p = Bun.spawnSync([gh, "auth", "token", "--user", account], { stderr: "pipe" });
    const token = p.stdout.toString().trim();
    if (p.exitCode !== 0 || !token) return { error: p.stderr.toString() };
    return { token };
  } catch {
    return { error: `cannot run ${gh}` };
  }
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
  if (ctx.login !== undefined) return ctx.login;
  const out = gh(ctx, ["api", "user", "--jq", ".login"]);
  const login = out?.trim();
  if (login) ctx.login = login; // only cache success — a flaky call can retry
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
  let rows: SearchRow[] | null = null;
  try {
    if (out !== null) rows = JSON.parse(out) as SearchRow[];
  } catch {
    // fall through to the failure path
  }
  if (rows === null) {
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

export interface ReviewRequesters {
  users: string[];
  teams: string[]; // org-qualified slugs, e.g. "acme/some-team"
}

export function reviewRequesters(
  ctx: GhCtx,
  repo: string,
  number: string,
): ReviewRequesters | null {
  const info = prView<{
    reviewRequests?: Array<{ login?: string; slug?: string }>;
  }>(ctx, repo, number, "reviewRequests");
  if (!info?.reviewRequests) return null;
  const users: string[] = [];
  const teams: string[] = [];
  for (const r of info.reviewRequests) {
    if (r.login) users.push(r.login);
    else if (r.slug) teams.push(r.slug);
  }
  return { users, teams };
}

export function myTeams(ctx: GhCtx): string[] | null {
  const out = gh(ctx, [
    "api", "user/teams", "--paginate",
    "--jq", '.[] | .organization.login + "/" + .slug',
  ]);
  if (out === null) return null;
  return out.split("\n").filter(Boolean);
}
