#!/usr/bin/env bash
# Stop hook: mark the watchdog turn ended so the plugin's poll loop
# finalizes the status bubble (edits to "✓ done in Xm Ys") and cleans up.
set -u
payload=$(cat)
session=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
[[ -z "$session" ]] && exit 0

dir="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}/watchdog"
[[ -d "$dir" ]] || exit 0

map="$dir/.session-$session"
[[ -r "$map" ]] || exit 0
chat_id=$(< "$map")
[[ -z "$chat_id" ]] && exit 0

state="$dir/$chat_id.json"
if [[ -r "$state" ]]; then
  now_ms=$(($(date +%s%N) / 1000000))
  tmp=$(mktemp "$dir/.tmp.XXXXXX")
  jq --argjson now "$now_ms" '.ended_at = $now' "$state" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$state" 2>/dev/null \
    || rm -f "$tmp" 2>/dev/null
fi

rm -f "$map" 2>/dev/null || true
exit 0
