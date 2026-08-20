// The fake world the test suite and the demo sandbox share: the gh/claude/
// launchctl shims, and how to materialize them into a scratch directory.
// tests/harness.ts layers its capture-file accessors on top; dev/demo.ts and
// dev/frames.tsx consume it directly.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Same shims as tests/tests.sh, knobs included: GH_PR_STATUS_JSON,
// GH_PR_VIEW_FAIL, GH_AUTH_STATUS_TEXT, GH_ORG_LIST, GH_ORG_LIST_FAIL,
// GH_MINE_SEARCH_JSON, GH_PR_MINE_JSON, GH_PR_HEADREF_JSON, GH_THREADS_JSON,
// CLAUDE_FAIL, CLAUDE_EMIT_DENIAL, CLAUDE_LOGGED_OUT. The gh shim logs every
// invocation (with the GH_TOKEN it saw) to GH_CALLS; the claude shim records
// its calls, the prompt, CLAUDE_CONFIG_DIR, and the state of testorg/demo#7 at
// call time.
const GH_SHIM = `#!/usr/bin/env bash
[ -n "\${GH_CALLS:-}" ] && echo "$* token=\${GH_TOKEN:-}" >>"\$GH_CALLS"
if [ "$1" = --version ]; then echo "gh version 0.0-test"; exit 0; fi
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ "\${GH_AUTH_STATUS_FAIL:-0}" = 1 ] && { echo "not logged in" >&2; exit 1; }
  # real gh writes the human-readable status to stderr, so callers that want
  # it have to read both streams — the shim keeps that true
  [ -n "\${GH_AUTH_STATUS_TEXT:-}" ] && { printf '%s\n' "\$GH_AUTH_STATUS_TEXT" >&2; exit 0; }
  echo "Logged in"; exit 0
fi
if [ "$1" = org ] && [ "$2" = list ]; then
  [ "\${GH_ORG_LIST_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
  printf '%s\n' "\${GH_ORG_LIST:-}"; exit 0
fi
if [ "$1" = auth ] && [ "$2" = token ]; then
  [ "\${GH_AUTH_TOKEN_FAIL:-0}" = 1 ] && { echo "no such account" >&2; exit 1; }
  echo "tok-$4"; exit 0
fi
if [ "$1" = api ] && [ "$2" = user ]; then echo testuser; exit 0; fi
if [ "$1" = api ] && [ "$2" = graphql ]; then
  json="\${GH_THREADS_JSON:-}"
  [ -n "$json" ] || json='{"data":{"repository":{"pullRequest":{"reviewThreads":{"totalCount":0,"nodes":[]}}}}}'
  echo "$json"
  exit 0
fi
if [ "$1" = api ] && [ "$2" = user/teams ]; then
  [ "\${GH_TEAMS_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
  [ -n "\${GH_TEAMS_CALLS:-}" ] && echo t >>"\$GH_TEAMS_CALLS"
  printf '%s\n' "\${GH_USER_TEAMS:-}"
  exit 0
fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  for a in "$@"; do
    if [ "$a" = headRefName ]; then
      [ "\${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      echo "\${GH_PR_HEADREF_JSON:-{\\"headRefName\\":\\"feature\\"}}"
      exit 0
    fi
    if [[ "$a" == state,isDraft* ]]; then
      [ "\${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      json="\${GH_PR_MINE_JSON:-}"
      [ -n "$json" ] || json='{"state":"OPEN","isDraft":false,"headRefOid":"","headRefName":"feature","reviews":[]}'
      echo "$json"
      exit 0
    fi
    if [ "$a" = headRefOid ]; then
      echo "{\"headRefOid\":\"$(git -C "$PWD" rev-parse HEAD 2>/dev/null)\"}"
      exit 0
    fi
    if [[ "$a" == *state*latestReviews* ]]; then
      [ "\${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      json="\${GH_PR_STATUS_JSON:-}"
      [ -n "$json" ] || json='{"state":"OPEN"}'
      echo "$json"
      exit 0
    fi
    if [ "$a" = reviewRequests ]; then
      [ "\${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      json="\${GH_REVIEW_REQUESTS_JSON:-}"
      [ -n "$json" ] || json='{"reviewRequests":[]}'
      echo "$json"
      exit 0
    fi
  done
  echo '{"title": "Manual PR", "url": "https://example.test/pr/42"}'
  exit 0
fi
# the authored-PRs search (mine view); empty unless a test scripts it, so the
# review-request fixtures below stay undisturbed
for a in "$@"; do
  if [ "$a" = --author=@me ]; then
    echo "\${GH_MINE_SEARCH_JSON:-[]}"
    exit 0
  fi
done
if [ -n "\${GH_SEARCH_JSON:-}" ]; then echo "\$GH_SEARCH_JSON"; exit 0; fi
cat <<'JSON'
[{"number": 7, "title": "Demo PR", "url": "https://example.test/pr/7",
  "isDraft": false, "repository": {"nameWithOwner": "testorg/demo"}},
 {"number": 8, "title": "Draft PR", "url": "https://example.test/pr/8",
  "isDraft": true, "repository": {"nameWithOwner": "testorg/demo"}}]
JSON
`;

const CLAUDE_SHIM = `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo "claude 0.0-test"; exit 0; fi
# the auth probe is not a review run — it must not land in CLAUDE_CALLS
if [ "$1" = auth ] && [ "$2" = status ]; then
  if [ "\${CLAUDE_LOGGED_OUT:-0}" = 1 ]; then
    echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'
  else
    echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
  fi
  exit 0
fi
echo run >>"\${CLAUDE_CALLS:?}"
[ "$1" = -p ] && printf '%s' "$2" >"\${PROMPT_CAPTURE:?}"
prev=""
for a in "$@"; do
  [ "$prev" = --allowedTools ] && printf '%s' "$a" >"\${ALLOWED_CAPTURE:?}"
  prev="$a"
done
printf '%s' "\${CLAUDE_CONFIG_DIR:-}" >"\${CFGDIR_CAPTURE:?}"
printf '%s' "$PWD" >"\${CWD_CAPTURE:?}"
printf '%s' "\${CLAUDE_BASH_WATCHDOG_SECONDS:-}" >"\${WATCHDOG_CAPTURE:?}"
printf '%s' "\${GH_TOKEN:-}" >"\${GHTOKEN_CAPTURE:?}"
bun -e 'const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(process.env.DOCKET_STATE_DIR+"/state.json","utf8"))}catch{};console.log((s["testorg/demo#7"]||{}).status||"absent")' >"\${STATUS_AT_CALL:?}"
# optionally simulate the agent creating a review worktree wherever it likes
[ -n "\${CLAUDE_MAKE_WORKTREE:-}" ] && git -C "$PWD" worktree add --quiet --detach "\$CLAUDE_MAKE_WORKTREE" HEAD 2>/dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at the diff"},{"type":"tool_use","name":"Bash","input":{"command":"git fetch origin"}}]}}'
# optionally simulate a dontAsk denial: a tool_use the allowlist turned away
if [ -n "\${CLAUDE_EMIT_DENIAL:-}" ]; then
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"denied-1","name":"Bash","input":{"command":"rg --files"}}]}}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"denied-1","is_error":true,"content":"Permission to use Bash has been denied because Claude Code is running in dontAsk mode."}]}}'
fi
if [ "\${CLAUDE_FAIL:-0}" = 1 ]; then echo "boom" >&2; exit 1; fi
[ -n "\${CLAUDE_SLEEP:-}" ] && sleep "\$CLAUDE_SLEEP"
# CLAUDE_RESULT stands in for the agent's final message; bun does the escaping
bun -e 'console.log(JSON.stringify({type:"result",subtype:"success",result:process.env.CLAUDE_RESULT??"ok",session_id:"sess-1234"}))'
`;

// Nothing is ever loaded, so no consumer can be swayed by what the developer's
// own launchd happens to be running. LAUNCHCTL_BIN points somewhere else in
// the tests that need a job to exist.
const LAUNCHCTL_SHIM = "#!/usr/bin/env bash\nexit 1\n";

export interface SandboxDirs {
  root: string; // the scratch dir everything lives under
  configDir: string; // root/cfg
  stateDir: string; // root/state
  binDir: string; // root/bin — shims live here
  env: Record<string, string>;
}

// The claude shim's capture files are required (bash `:?`), so they are always
// created and wired up — inert for a demo, read back by the test harness.
export function materialize(root: string): SandboxDirs {
  const configDir = join(root, "cfg");
  const stateDir = join(root, "state");
  const binDir = join(root, "bin");
  for (const d of [configDir, stateDir, binDir]) mkdirSync(d, { recursive: true });

  const shim = (name: string, source: string) => {
    const p = join(binDir, name);
    writeFileSync(p, source);
    chmodSync(p, 0o755);
    return p;
  };
  const capture = (name: string) => {
    const p = join(root, name);
    writeFileSync(p, "");
    return p;
  };

  const env: Record<string, string> = {
    DOCKET_CONFIG_DIR: configDir,
    DOCKET_STATE_DIR: stateDir,
    DOCKET_NOTIFY: "0",
    CLAUDE_BIN: shim("claude", CLAUDE_SHIM),
    GH_BIN: shim("gh", GH_SHIM),
    LAUNCHCTL_BIN: shim("launchctl", LAUNCHCTL_SHIM),
    GH_CALLS: capture("gh-calls"),
    CLAUDE_CALLS: capture("claude-calls"),
    PROMPT_CAPTURE: capture("prompt-capture"),
    ALLOWED_CAPTURE: capture("allowed-capture"),
    CFGDIR_CAPTURE: capture("cfgdir-capture"),
    CWD_CAPTURE: capture("cwd-capture"),
    WATCHDOG_CAPTURE: capture("watchdog-capture"),
    GHTOKEN_CAPTURE: capture("ghtoken-capture"),
    STATUS_AT_CALL: capture("status-at-call"),
  };

  return { root, configDir, stateDir, binDir, env };
}
