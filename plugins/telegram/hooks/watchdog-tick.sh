#!/usr/bin/env bash
# PreToolUse hook: record the last tool name in watchdog state so the
# bubble can show "⏳ working… 47s • last: Bash" while a turn runs.
# No-op for non-telegram sessions and turns without a state file.
set -u
payload=$(cat)

tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
[[ -z "$tool" || -z "$session" ]] && exit 0

dir="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}/watchdog"
[[ -d "$dir" ]] || exit 0

map="$dir/.session-$session"
[[ -r "$map" ]] || exit 0
chat_id=$(< "$map")
[[ -z "$chat_id" ]] && exit 0

state="$dir/$chat_id.json"
[[ -r "$state" ]] || exit 0

now_ms=$(($(date +%s%N) / 1000000))
tmp=$(mktemp "$dir/.tmp.XXXXXX")
jq --arg t "$tool" --argjson now "$now_ms" \
  '.last_tool = $t | .last_tool_at = $now' \
  "$state" > "$tmp" 2>/dev/null \
  && mv "$tmp" "$state" 2>/dev/null \
  || rm -f "$tmp" 2>/dev/null
exit 0
