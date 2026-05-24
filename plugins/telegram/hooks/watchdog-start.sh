#!/usr/bin/env bash
# UserPromptSubmit hook: start the watchdog timer for telegram-relayed turns.
#
# Why: long agent turns can run silently for minutes between replies. The
# plugin spawns a single self-editing status bubble after 60s elapsed so the
# user can see the agent is still working. This hook arms the timer for
# each new turn by writing a state file the plugin polls. No-op when the
# prompt isn't a telegram message.
set -u
payload=$(cat)

prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
[[ -z "$prompt" || -z "$session" ]] && exit 0

# Pick the chat_id off the inbound channel block. Multiple inbounds in one
# turn (e.g. mid-turn appended messages) all share the same chat_id, so
# first match is fine.
chat_id=$(printf '%s' "$prompt" \
  | grep -oE 'source="plugin:telegram:telegram"[^>]*chat_id="[0-9]+"' \
  | head -1 \
  | grep -oE 'chat_id="[0-9]+"' \
  | grep -oE '[0-9]+')
[[ -z "$chat_id" ]] && exit 0

dir="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}/watchdog"
mkdir -p "$dir" 2>/dev/null || true

now_ms=$(($(date +%s%N) / 1000000))
state="$dir/$chat_id.json"
tmp=$(mktemp "$dir/.tmp.XXXXXX")
jq -n --argjson s "$now_ms" --arg sid "$session" '{
  started_at: $s,
  session_id: $sid,
  last_tool: null,
  last_tool_at: null,
  bubble_message_id: null,
  ended_at: null
}' > "$tmp" 2>/dev/null && mv "$tmp" "$state" 2>/dev/null || rm -f "$tmp" 2>/dev/null

# session → chat mapping so PreToolUse/Stop hooks (which see session_id but
# not the channel block) can find the right state file.
echo -n "$chat_id" > "$dir/.session-$session" 2>/dev/null || true
exit 0
