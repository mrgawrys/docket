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
export function ghAccountToken(
  gh: string,
  account: string,
  env: NodeJS.ProcessEnv = process.env,
): { token: string } | { error: string } {
  try {
    const p = Bun.spawnSync([gh, "auth", "token", "--user", account], {
      stderr: "pipe",
      env: env as Record<string, string>,
    });
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
  // Only searchMyPrs keeps drafts; searchReviewRequests filters them out.
  isDraft?: boolean;
  updatedAt?: string;
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

export function prView<T>(
  ctx: GhCtx,
  repo: string,
  number: string,
  fields: string,
): T | null {
  const out = gh(ctx, ["pr", "view", number, "--repo", repo, "--json", fields]);
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

export interface Threads {
  unresolved: number;
  total: number;
}

// Review thread resolution is GraphQL-only: `pr view --json` has no field
// for it. The first 100 threads are enough for any PR a person still reads.
export function prThreads(
  ctx: GhCtx,
  repo: string,
  number: string,
): Threads | null {
  const [owner, name] = repo.split("/");
  const query =
    "query($owner:String!,$name:String!,$number:Int!){" +
    "repository(owner:$owner,name:$name){pullRequest(number:$number){" +
    "reviewThreads(first:100){totalCount nodes{isResolved}}}}}";
  const out = gh(ctx, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  if (out === null) return null;
  try {
    const t = (
      JSON.parse(out) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                totalCount?: number;
                nodes?: { isResolved?: boolean }[];
              };
            };
          };
        };
      }
    ).data?.repository?.pullRequest?.reviewThreads;
    if (!t) return null;
    const nodes = t.nodes ?? [];
    return {
      total: t.totalCount ?? nodes.length,
      unresolved: nodes.filter((n) => !n.isResolved).length,
    };
  } catch {
    return null;
  }
}

interface SearchRow {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt?: string;
  repository: { nameWithOwner: string };
}

export function searchReviewRequests(ctx: GhCtx, org: string): Candidate[] {
  const out = gh(ctx, [
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    "--owner",
    org,
    "--limit",
    "100",
    "--json",
    "number,title,url,isDraft,updatedAt,repository",
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
      updatedAt: r.updatedAt,
    }));
}

// PRs the user authored under one owner (an org, or the user's own login).
// Drafts are kept — they are listed in the mine view, only flagged. The search
// API has no head-ref field, so the branch is fetched separately (prView) for
// keys the poller has not seen before.
export function searchMyPrs(ctx: GhCtx, owner: string): Candidate[] {
  const out = gh(ctx, [
    "search",
    "prs",
    "--author=@me",
    "--state=open",
    "--owner",
    owner,
    "--limit",
    "100",
    "--json",
    "number,title,url,isDraft,updatedAt,repository",
  ]);
  let rows: SearchRow[] | null = null;
  try {
    if (out !== null) rows = JSON.parse(out) as SearchRow[];
  } catch {
    // fall through to the failure path
  }
  if (rows === null) {
    ctx.log(`gh search (authored) failed for owner ${owner}`);
    return [];
  }
  return rows.map((r) => ({
    repo: r.repository.nameWithOwner,
    number: r.number,
    title: r.title,
    url: r.url,
    isDraft: r.isDraft,
    updatedAt: r.updatedAt,
  }));
}

// One review someone submitted on the user's PR, flattened for decideMineSync.
export interface PrMineInfo {
  state: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  updatedAt?: string;
  reviews: {
    author: string;
    state: string;
    body: string;
    submittedAt: string;
    comments: number; // inline comments; filled only for blank approvals
  }[];
}

export function prMineInfo(
  ctx: GhCtx,
  repo: string,
  number: string,
): PrMineInfo | null {
  const raw = prView<{
    state?: string;
    isDraft?: boolean;
    headRefOid?: string;
    headRefName?: string;
    updatedAt?: string;
    reviews?: {
      id?: string;
      author?: { login?: string };
      state?: string;
      body?: string;
      submittedAt?: string;
    }[];
  }>(
    ctx,
    repo,
    number,
    "state,isDraft,headRefOid,headRefName,updatedAt,reviews",
  );
  if (!raw) return null;
  const reviews = raw.reviews ?? [];
  // Only a blank approval's verdict hinges on its inline comments, so only
  // then does the PR pay a second call.
  const counts = reviews.some((r) => r.state === "APPROVED" && !r.body?.trim())
    ? reviewCommentCounts(ctx, repo, number)
    : null;
  return {
    state: raw.state ?? "",
    isDraft: raw.isDraft ?? false,
    headRefOid: raw.headRefOid ?? "",
    headRefName: raw.headRefName ?? "",
    updatedAt: raw.updatedAt,
    reviews: reviews.map((r) => ({
      author: r.author?.login ?? "",
      state: r.state ?? "",
      body: r.body ?? "",
      submittedAt: r.submittedAt ?? "",
      comments: (r.id && counts?.get(r.id)) || 0,
    })),
  };
}

// `pr view --json reviews` has no inline-comment count; GraphQL does. Keyed
// by review node id, which is the `id` pr view returns.
export function reviewCommentCounts(
  ctx: GhCtx,
  repo: string,
  number: string,
): Map<string, number> | null {
  const [owner, name] = repo.split("/");
  const query =
    "query($owner:String!,$name:String!,$number:Int!){" +
    "repository(owner:$owner,name:$name){pullRequest(number:$number){" +
    "reviews(first:100){nodes{id comments{totalCount}}}}}}";
  const out = gh(ctx, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  if (out === null) return null;
  try {
    const nodes =
      (
        JSON.parse(out) as {
          data?: {
            repository?: {
              pullRequest?: {
                reviews?: {
                  nodes?: { id?: string; comments?: { totalCount?: number } }[];
                };
              };
            };
          };
        }
      ).data?.repository?.pullRequest?.reviews?.nodes ?? [];
    return new Map(
      nodes.flatMap((n) =>
        n.id ? [[n.id, n.comments?.totalCount ?? 0] as const] : [],
      ),
    );
  } catch {
    return null;
  }
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
    "api",
    "user/teams",
    "--paginate",
    "--jq",
    '.[] | .organization.login + "/" + .slug',
  ]);
  if (out === null) return null;
  return out.split("\n").filter(Boolean);
}
