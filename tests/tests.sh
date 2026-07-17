#!/usr/bin/env bash
# Tests bin/auto-review against mock gh/claude shims — no network, no tokens.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../bin/auto-review"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

export AUTO_REVIEW_CONFIG_DIR="$TMP/cfg" AUTO_REVIEW_STATE_DIR="$TMP/ar" AUTO_REVIEW_NOTIFY=0
export CLAUDE_BIN="$TMP/bin/claude" GH_BIN="$TMP/bin/gh"
mkdir -p "$AUTO_REVIEW_CONFIG_DIR" "$AUTO_REVIEW_STATE_DIR" "$TMP/bin" "$TMP/demo"

cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = pr ] && [ "$2" = view ]; then
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

cat >"$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo run >>"${CLAUDE_CALLS:?}"
[ "$1" = -p ] && printf '%s' "$2" >"${PROMPT_CAPTURE:?}"
printf '%s' "${CLAUDE_CONFIG_DIR:-}" >"${CFGDIR_CAPTURE:?}"
jq -r '."testorg/demo#7".status // "absent"' "${AUTO_REVIEW_STATE_DIR:?}/state.json" >"${STATUS_AT_CALL:?}"
if [ "${CLAUDE_FAIL:-0}" = 1 ]; then echo "boom" >&2; exit 1; fi
echo '{"type":"result","subtype":"success","result":"ok","session_id":"sess-1234"}'
EOF
chmod +x "$TMP/bin/gh" "$TMP/bin/claude"
export CLAUDE_CALLS="$TMP/claude-calls"; : >"$CLAUDE_CALLS"
export STATUS_AT_CALL="$TMP/status-at-call"
export PROMPT_CAPTURE="$TMP/prompt-capture"
export CFGDIR_CAPTURE="$TMP/cfgdir-capture"

cat >"$AUTO_REVIEW_CONFIG_DIR/config.json" <<EOF
{"orgs": ["testorg"], "repos": {"testorg/demo": "$TMP/demo"}}
EOF

fail() { echo "FAIL: $1"; exit 1; }
STATE="$AUTO_REVIEW_STATE_DIR/state.json"

# 1. dry run: lists the non-draft PR only, writes no state, calls no claude
out=$(bash "$BIN" --dry-run)
grep -q 'would review: testorg/demo#7' <<<"$out" || fail "dry-run should list PR 7"
if grep -q '#8' <<<"$out"; then fail "dry-run must skip drafts"; fi
[ "$(jq 'length' "$STATE")" = 0 ] || fail "dry-run must not write state"
[ ! -s "$CLAUDE_CALLS" ] || fail "dry-run must not invoke claude"

# 2. real run: entry ready with session id and local path
bash "$BIN"
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = ready ] || fail "status should be ready"
[ "$(jq -r '."testorg/demo#7".session_id' "$STATE")" = sess-1234 ] || fail "session id recorded"
[ "$(jq -r '."testorg/demo#7".local_path' "$STATE")" = "$TMP/demo" ] || fail "local path recorded"
[ "$(cat "$STATUS_AT_CALL")" = reviewing ] || fail "entry must be 'reviewing' while claude runs"
grep -q 'worktree for PR #7 at .worktrees/pr-7' "$PROMPT_CAPTURE" || fail "prompt must request a worktree"
grep -q '/code-review 7' "$PROMPT_CAPTURE" || fail "prompt must invoke /code-review with the PR number"
tail -1 "$AUTO_REVIEW_STATE_DIR/auto-review.log" | grep -q 'poll complete: 1 reviewed' \
  || fail "summary should count reviewed PRs"

# 3. second run: dedup — claude not called again
bash "$BIN"
[ "$(wc -l <"$CLAUDE_CALLS" | tr -d ' ')" = 1 ] || fail "must not re-review a known PR"
tail -1 "$AUTO_REVIEW_STATE_DIR/auto-review.log" | grep -q 'poll complete: nothing new' \
  || fail "summary should say nothing new when idle"

# 4. failure path: claude exits non-zero -> status failed, error recorded
echo '{}' >"$STATE"   # fresh state
CLAUDE_FAIL=1 bash "$BIN"
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = failed ] || fail "status should be failed"
jq -e '."testorg/demo#7".error' "$STATE" >/dev/null || fail "error message recorded"

# 5. retry: failed entry becomes ready without a new poll match needed
bash "$BIN" --retry "testorg/demo#7"
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = ready ] || fail "retry should flip to ready"
[ "$(jq -r '."testorg/demo#7".session_id' "$STATE")" = sess-1234 ] || fail "retry records session"
if bash "$BIN" --retry "nope/nope#1" 2>/dev/null; then fail "unknown key must exit non-zero"; fi

# 6. orphaned "reviewing" entry (previous run died mid-review) reconciled to failed
echo '{"testorg/demo#9": {"status": "reviewing", "title": "Orphan", "url": "u",
      "updated_at": "2026-01-01T00:00:00Z"}}' >"$STATE"
bash "$BIN"
[ "$(jq -r '."testorg/demo#9".status' "$STATE")" = failed ] || fail "orphaned reviewing entry should become failed"
jq -e '."testorg/demo#9".error' "$STATE" >/dev/null || fail "orphan reconcile records an error"

# 7. --review: force-review an arbitrary PR (not in state, not review-requested)
bash "$BIN" --review "testorg/demo#42" "author pushed changes, focus on the delta"
[ "$(jq -r '."testorg/demo#42".status' "$STATE")" = ready ] || fail "--review should produce a ready entry"
[ "$(jq -r '."testorg/demo#42".title' "$STATE")" = "Manual PR" ] || fail "--review should fetch PR metadata"
grep -q '/code-review 42' "$PROMPT_CAPTURE" || fail "--review must target the given PR"
grep -q 'focus on the delta' "$PROMPT_CAPTURE" || fail "--review note must reach the prompt"

# 8. --review accepts a GitHub PR URL and normalizes it to ORG/REPO#N
bash "$BIN" --review "https://github.com/testorg/demo/pull/43"
[ "$(jq -r '."testorg/demo#43".status' "$STATE")" = ready ] || fail "URL input should normalize to org/repo#n key"
if jq -e 'keys[] | select(startswith("http"))' "$STATE" >/dev/null; then fail "no URL-shaped keys may reach state"; fi
if bash "$BIN" --review "total garbage" 2>/dev/null; then fail "unparseable input must exit non-zero"; fi

# 9. missing config: clear error pointing at config.example.json, non-zero exit
if AUTO_REVIEW_CONFIG_DIR="$TMP/nonexistent" bash "$BIN" --dry-run 2>"$TMP/err"; then
  fail "missing config must exit non-zero"
fi
grep -q 'config.example.json' "$TMP/err" || fail "missing-config error should point at config.example.json"

# 10. claude_config_dir from config is exported as CLAUDE_CONFIG_DIR
cat >"$AUTO_REVIEW_CONFIG_DIR/config.json" <<EOF
{"orgs": ["testorg"], "repos": {"testorg/demo": "$TMP/demo"},
 "claude_config_dir": "$TMP/claude-home"}
EOF
bash "$BIN" --review "testorg/demo#44"
[ "$(cat "$CFGDIR_CAPTURE")" = "$TMP/claude-home" ] || fail "claude_config_dir must reach claude as CLAUDE_CONFIG_DIR"

# 11. claude_bin from config is used when CLAUDE_BIN env is not set
cat >"$TMP/bin/claude2" <<'EOF'
#!/usr/bin/env bash
echo run2 >>"${CLAUDE_CALLS:?}"
echo '{"session_id":"sess-9"}'
EOF
chmod +x "$TMP/bin/claude2"
cat >"$AUTO_REVIEW_CONFIG_DIR/config.json" <<EOF
{"orgs": ["testorg"], "repos": {"testorg/demo": "$TMP/demo"},
 "claude_bin": "$TMP/bin/claude2"}
EOF
env -u CLAUDE_BIN AUTO_REVIEW_CONFIG_DIR="$AUTO_REVIEW_CONFIG_DIR" AUTO_REVIEW_STATE_DIR="$AUTO_REVIEW_STATE_DIR" \
  bash "$BIN" --review "testorg/demo#45"
grep -q run2 "$CLAUDE_CALLS" || fail "claude_bin from config must be used"

# 12. skipped: PR repo has no local clone mapped -> status skipped, no local_path
echo '{}' >"$STATE"
cat >"$AUTO_REVIEW_CONFIG_DIR/config.json" <<EOF
{"orgs": ["testorg"], "repos": {}}
EOF
bash "$BIN"
[ "$(jq -r '."testorg/demo#7".status' "$STATE")" = skipped ] || fail "unmapped repo should be skipped"
[ "$(jq '."testorg/demo#7" | has("local_path")' "$STATE")" = false ] || fail "skipped entry must not record local_path"
tail -1 "$AUTO_REVIEW_STATE_DIR/auto-review.log" | grep -q '1 skipped' || fail "summary should count skipped PRs"

echo "ALL TESTS PASS"
