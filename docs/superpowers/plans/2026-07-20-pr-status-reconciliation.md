# PR Status Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the `reviews` list in step with GitHub — merged/closed PRs disappear, PRs you already reviewed show your verdict (`approved` / `changes-requested` / `commented`) plus flags when there's news since your review.

**Architecture:** A `reconcile()` function in `bin/auto-review` queries `gh pr view` for every active state entry and rewrites its status. It runs at the start of every poll and standalone via a new `--sync` mode (never launches Claude). The fish frontend gains a `reviews sync` subcommand that delegates to `--sync` and then shows the list; the list line renders the new statuses and flags. Only `done` entries are hidden — reviewed-but-open entries stay visible with their verdict.

**Tech Stack:** bash + jq + gh CLI (poller), fish (frontend), fully mocked bash test suite (`tests/tests.sh`, no network).

## Global Constraints

- Reviews never write anything to GitHub; `reconcile` is read-only toward GitHub.
- `--sync` and reconciliation must never invoke the `claude` binary.
- A failed `gh` call leaves the affected entry untouched (network trouble must not corrupt state).
- `reviewing` entries are never touched by reconcile (they belong to the in-flight run).
- `--dry-run` stays fully read-only: no state writes, so no reconcile.
- Tests stay offline/mocked — no real network, no tokens.
- Status vocabulary after this change: `reviewing`, `ready`, `failed`, `canceled`, `skipped`, `done`, `approved`, `changes-requested`, `commented`. Flags: `re-requested`, `new-commits`.

## File Map

| File | Change |
|---|---|
| `bin/auto-review` | Add `state_done`, `state_reviewed`, `remove_worktree`, `reconcile`; wire into `main` (poll + new `--sync` mode); extend poll summary with synced count |
| `tests/tests.sh` | Rework `gh` mock (api user, `pr view --json state,...` branch, env-driven responses); add tests 6–9 |
| `fish/reviews.fish` | `sync` subcommand, help line, flags in the list rendering |
| `fish/reviews-completions.fish` | Completion for `sync` |
| `README.md` | Day-to-day + lifecycle docs |

---

### Task 1: Reconcile engine + `--sync` in `bin/auto-review`

**Files:**
- Modify: `tests/tests.sh` (gh mock at top, new tests appended after test 5)
- Modify: `bin/auto-review`

**Interfaces:**
- Produces: `bash bin/auto-review --sync` (reconcile-only mode); state entries may gain `status` values `approved`/`changes-requested`/`commented`, a `flags` array (`re-requested`, `new-commits`), `my_review_at`, and `done_reason` (`merged`/`closed`). Task 2's fish code reads `.flags` and calls `--sync`.
- Consumes: existing `state_set`/`state_status`/`log`/lock helpers in `bin/auto-review`.

- [ ] **Step 1: Rework the gh mock in `tests/tests.sh`**

Replace the existing `cat >"$TMP/bin/gh" <<'EOF' ... EOF` block with:

```bash
cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = api ] && [ "$2" = user ]; then echo testuser; exit 0; fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  for a in "$@"; do
    if [[ "$a" == *state*latestReviews* ]]; then
      [ "${GH_PR_VIEW_FAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
      json="${GH_PR_STATUS_JSON:-}"
      [ -n "$json" ] || json='{"state":"OPEN"}'
      echo "$json"
      exit 0
    fi
  done
  echo '{"title": "Manual PR", "url": "https://example.test/pr/42"}'
  exit 0
fi
cat <<'JSON'
[{"number": 7, "title": "Demo PR", "url": "https://example.test/pr/7",
  "isDraft": false, "repository": {"nameWithOwner": "testorg/demo"}},
 {"number": 8, "title": "Draft PR", "url": "https://example.test/pr/8",
  "isDraft": true, "repository": {"nameWithOwner": "testorg/demo"}}]
JSON
EOF
```

(The `pr view` branch dispatches on the `--json state,latestReviews,...` argument so the existing `--review` test, which fetches `--json title,url`, keeps its old response. With no `GH_PR_STATUS_JSON` set, reconcile sees an open PR with no reviews — a no-op — so existing tests 1–5 stay valid.)

- [ ] **Step 2: Append failing tests 6–9 to `tests/tests.sh`**

Append before the final `echo` (add one if the file ends after test 5):

```bash
# 6. sync: my review flips the status, flags capture re-request + new commits
calls_before=$(wc -l <"$CLAUDE_CALLS" | tr -d ' ')
GH_PR_STATUS_JSON='{"state":"OPEN",
  "latestReviews":[{"author":{"login":"testuser"},"state":"CHANGES_REQUESTED",
                    "submittedAt":"2026-07-19T10:00:00Z"}],
  "reviewRequests":[{"login":"testuser"}],
  "commits":[{"committedDate":"2026-07-19T12:00:00Z"}]}' bash "$BIN" --sync
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = changes-requested ] \
  || fail "sync should record my review verdict"
[ "$(jq -c '."testorg/demo#7".flags' "$STATE")" = '["re-requested","new-commits"]' ] \
  || fail "sync should flag re-request and new commits"
[ "$(jq -r '."testorg/demo#7".session_id' "$STATE")" = sess-1234 ] \
  || fail "sync must keep the session resumable"
[ "$(wc -l <"$CLAUDE_CALLS" | tr -d ' ')" = "$calls_before" ] \
  || fail "sync must never invoke claude"

# 7. sync: plain approval, nothing new -> flags clear
GH_PR_STATUS_JSON='{"state":"OPEN",
  "latestReviews":[{"author":{"login":"testuser"},"state":"APPROVED",
                    "submittedAt":"2026-07-19T13:00:00Z"}],
  "reviewRequests":[],
  "commits":[{"committedDate":"2026-07-19T12:00:00Z"}]}' bash "$BIN" --sync
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = approved ] || fail "verdict should update"
[ "$(jq -c '."testorg/demo#7".flags' "$STATE")" = '[]' ] || fail "flags should clear"

# 8. sync: gh failure leaves the entry untouched
GH_PR_VIEW_FAIL=1 bash "$BIN" --sync
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = approved ] \
  || fail "gh failure must not change state"

# 9. normal poll reconciles too: merged -> done, worktree removed, no new claude run
git -C "$TMP/demo" init -q
git -C "$TMP/demo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$TMP/demo" worktree add --quiet "$TMP/demo/.worktrees/pr-7" >/dev/null
calls_before=$(wc -l <"$CLAUDE_CALLS" | tr -d ' ')
GH_PR_STATUS_JSON='{"state":"MERGED"}' bash "$BIN"
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = done ] || fail "merged PR should be done"
[ "$(jq -r '."testorg/demo#7".done_reason' "$STATE")" = merged ] || fail "done_reason recorded"
[ ! -d "$TMP/demo/.worktrees/pr-7" ] || fail "merged PR worktree should be removed"
[ "$(wc -l <"$CLAUDE_CALLS" | tr -d ' ')" = "$calls_before" ] \
  || fail "done entry must not be re-reviewed"
tail -1 "$AUTO_REVIEW_STATE_DIR/auto-review.log" | grep -q '1 synced' \
  || fail "poll summary should count synced entries"
```

- [ ] **Step 3: Run tests, confirm 6–9 fail**

Run: `bash tests/tests.sh`
Expected: tests 1–5 pass; test 6 fails (`--sync` unknown → treated as a poll, or status never becomes `changes-requested`).

- [ ] **Step 4: Implement reconcile in `bin/auto-review`**

Add `SYNCED=0` to the counters line (`REVIEWED=0 FAILED=0 SKIPPED=0 SYNCED=0`), then add after `state_status()`:

```bash
state_done() { # $1 key, $2 reason (merged|closed)
  local tmp; tmp=$(mktemp)
  jq --arg k "$1" --arg r "$2" --arg d "$(timestamp)" \
    '.[$k].status = "done" | .[$k].done_reason = $r | .[$k].updated_at = $d' \
    "$STATE" >"$tmp" && mv "$tmp" "$STATE"
}

state_reviewed() { # $1 key, $2 verdict, $3 review time, $4 flags (space-separated)
  local tmp; tmp=$(mktemp)
  jq --arg k "$1" --arg s "$2" --arg r "$3" --arg f "${4:-}" --arg d "$(timestamp)" \
    '.[$k].status = $s | .[$k].my_review_at = $r | .[$k].updated_at = $d
     | .[$k].flags = ($f | if . == "" then [] else split(" ") end)' \
    "$STATE" >"$tmp" && mv "$tmp" "$STATE"
}

remove_worktree() { # $1 key — drop the PR worktree if the clone still has it
  local path num=${1##*#}
  path=$(jq -r --arg k "$1" '.[$k].local_path // empty' "$STATE")
  [ -n "$path" ] && [ -d "$path/.worktrees/pr-$num" ] || return 0
  if git -C "$path" worktree remove --force ".worktrees/pr-$num" 2>>"$LOG_FILE"; then
    log "SYNC $1: removed worktree $path/.worktrees/pr-$num"
  else
    log "SYNC $1: could not remove worktree $path/.worktrees/pr-$num"
  fi
}

reconcile() { # refresh active entries against GitHub; never launches reviews
  local me keys k repo number info verdict kind st reviewed_at rereq newc flags cur
  keys=$(jq -r 'to_entries[]
    | select(.value.status != "done" and .value.status != "reviewing") | .key' "$STATE")
  [ -n "$keys" ] || return 0
  if ! me=$("$GH_BIN" api user --jq .login 2>>"$LOG_FILE"); then
    log "sync: cannot resolve GitHub login, skipping"; return 0
  fi
  for k in $keys; do
    repo="${k%#*}" number="${k##*#}"
    if ! info=$("$GH_BIN" pr view "$number" --repo "$repo" \
        --json state,latestReviews,reviewRequests,commits 2>>"$LOG_FILE"); then
      log "SYNC $k: gh pr view failed, leaving entry as-is"
      continue
    fi
    verdict=$(jq -r --arg me "$me" '
      (.latestReviews // [] | map(select(.author.login == $me)) | first) as $rev
      | if .state == "MERGED" then "done merged"
        elif .state == "CLOSED" then "done closed"
        elif $rev == null then "unchanged"
        else [
          "reviewed",
          ($rev.state | ascii_downcase | gsub("_"; "-")),
          $rev.submittedAt,
          (if ([.reviewRequests // [] | .[] | .login? // empty] | index($me)) != null
           then 1 else 0 end),
          (if ((.commits // [] | last | .committedDate? // "") > $rev.submittedAt)
           then 1 else 0 end)
        ] | join(" ")
        end' <<<"$info")
    read -r kind st reviewed_at rereq newc <<<"$verdict"
    case "$kind" in
      done)
        state_done "$k" "$st"
        remove_worktree "$k"
        log "SYNC $k: PR $st — marked done"
        SYNCED=$((SYNCED+1))
        ;;
      reviewed)
        flags=""
        [ "$rereq" = 1 ] && flags="re-requested"
        [ "$newc" = 1 ] && flags="${flags:+$flags }new-commits"
        cur=$(jq -r --arg k "$k" \
          '.[$k] | "\(.status) \((.flags // []) | join(" "))"' "$STATE")
        if [ "$cur" != "$st $flags" ]; then
          state_reviewed "$k" "$st" "$reviewed_at" "$flags"
          log "SYNC $k: you reviewed ($st)${flags:+ [$flags]}"
          SYNCED=$((SYNCED+1))
        fi
        ;;
    esac
  done
}
```

Wire into `main`: after the `reconcile_orphans` line add:

```bash
  if [ "${1:-}" = "--sync" ]; then
    reconcile
    log "sync complete: $SYNCED updated"
    return 0
  fi
```

Before the `log "polling ..."` line add:

```bash
  [ "$dry" -eq 1 ] || reconcile
```

And change the final summary block to:

```bash
  if [ "$dry" -eq 1 ]; then
    log "poll complete (dry run)"
  elif [ $((REVIEWED + FAILED + SKIPPED + SYNCED)) -eq 0 ]; then
    log "poll complete: nothing new"
  else
    log "poll complete: $REVIEWED reviewed, $FAILED failed, $SKIPPED skipped, $SYNCED synced"
  fi
```

(Note: test 2's `grep 'poll complete: 1 reviewed'` still matches the extended line. The change-detection guard in the `reviewed` branch keeps `updated_at` — and therefore list order — stable when nothing changed on GitHub.)

- [ ] **Step 5: Run tests, confirm all pass**

Run: `bash tests/tests.sh`
Expected: all tests pass, ending with the suite's success output.

- [ ] **Step 6: Commit**

```bash
git add bin/auto-review tests/tests.sh
git commit -m "feat: reconcile state with GitHub PR status (--sync)"
```

---

### Task 2: `reviews sync` + flag display in the fish frontend

**Files:**
- Modify: `fish/reviews.fish`
- Modify: `fish/reviews-completions.fish`

**Interfaces:**
- Consumes: `bash $repo/bin/auto-review --sync` (Task 1) and the `.flags` array in state entries.
- Produces: `reviews sync` (sync then interactive list).

- [ ] **Step 1: Add the `sync` case and help line in `fish/reviews.fish`**

In the `help` case, after the first `echo` line add:

```fish
            echo "reviews sync       refresh from GitHub: merged/closed dismissed, your verdicts shown"
```

Before `case status` add (no `return` — it falls through to the list below the switch):

```fish
        case sync
            bash $repo/bin/auto-review --sync
```

- [ ] **Step 2: Render flags in the list line**

Replace the `set -l line (jq -r ...)` call in the listing loop with:

```fish
        set -l line (jq -r --arg k $keys[$i] \
            '.[$k] | "[\(.status)\((.flags // [])
                | if length > 0 then " " + (map("+" + .) | join(" ")) else "" end)]\t\(.title)\t\(.updated_at)"' $state)
```

(Renders e.g. `[approved +new-commits]` or `[changes-requested +re-requested +new-commits]`.)

- [ ] **Step 3: Add the completion**

In `fish/reviews-completions.fish`, after the `status` line add:

```fish
complete -c reviews -n __fish_use_subcommand -a sync -d 'refresh entries from GitHub'
```

- [ ] **Step 4: Syntax-check both fish files**

Run: `fish -n fish/reviews.fish && fish -n fish/reviews-completions.fish`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add fish/reviews.fish fish/reviews-completions.fish
git commit -m "feat: reviews sync subcommand and verdict/flag display"
```

---

### Task 3: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Day to day and How it works**

In "Day to day", after the `reviews status | log ...` bullet add:

```markdown
- `reviews sync` — refresh entries from GitHub before listing: merged/closed
  PRs are dismissed (worktree removed), PRs you already reviewed show your
  verdict. The poller does the same refresh on every poll.
```

Replace the "Entry lifecycle" paragraph in "How it works" with:

```markdown
Entry lifecycle: `reviewing` → `ready` | `failed` | `canceled` (Ctrl+C), plus
`skipped` (no local clone mapped) and `done` (dismissed). Orphaned
`reviewing` entries from a dead run flip to `failed` on the next poll. Every
poll (and `reviews sync`) also reconciles active entries against GitHub:
merged/closed PRs become `done` and lose their worktree; once you review a
PR its entry shows your verdict — `approved`, `changes-requested`, or
`commented` — with `+re-requested` / `+new-commits` flags when the author
re-requests your review or pushes after it. Flagged entries are acted on
manually (`r#` or `--review` with a note).
```

- [ ] **Step 2: Run the full suite once more and commit**

Run: `bash tests/tests.sh`
Expected: all pass.

```bash
git add README.md
git commit -m "docs: document sync and review-verdict statuses"
```
