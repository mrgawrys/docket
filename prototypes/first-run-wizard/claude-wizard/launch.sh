#!/usr/bin/env bash
# Prototype A: launches the docket setup wizard as an interactive claude session,
# pointed at a throwaway sandbox so the user's real config is never touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prompt_file="$here/wizard-prompt.md"

if [[ ! -f "$prompt_file" ]]; then
  echo "missing wizard prompt: $prompt_file" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "the 'claude' CLI is not on PATH" >&2
  exit 1
fi

# The wizard's last step runs doctor via bun; catch it here rather than let the
# session fail at the end.
if ! command -v bun >/dev/null 2>&1; then
  echo "'bun' is not on PATH — the wizard's final doctor step needs it" >&2
  exit 1
fi

export DOCKET_CONFIG_DIR="$here/sandbox/config"
export DOCKET_STATE_DIR="$here/sandbox/state"
mkdir -p "$DOCKET_CONFIG_DIR" "$DOCKET_STATE_DIR"

echo "docket setup wizard (prototype A)"
echo "  config -> $DOCKET_CONFIG_DIR"
echo "  state  -> $DOCKET_STATE_DIR"
echo

exec claude "$(cat "$prompt_file")"
