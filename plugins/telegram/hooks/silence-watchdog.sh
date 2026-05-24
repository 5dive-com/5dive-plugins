#!/usr/bin/env bash
# PostToolUse hook: nudge the agent when it's gone quiet on Telegram.
#
# Why: agents paired over Telegram sometimes go silent for minutes while
# they crunch through tool calls. CLAUDE.md and the notify-user skill both
# say "ack within 30s, edit your last message every ~30s", but Claude
# reads those at session start and ignores them mid-task once it's deep in
# work. This hook is the forcing function — it injects a fresh
# <system-reminder> into the next tool result after the silence threshold
# is crossed, so the model sees it in the live context window instead of
# having to recall a session-load directive.
#
# Distinct from the v0.2.0 watchdog (auto-edit "⏳ working… 47s" bubble):
# the user scrapped that for feeling fake. This hook injects only the
# reminder; Claude still writes the actual TG content itself, in its own
# voice, on its own beat. No fake bubble, no auto-edit, no pane scraping.
#
# Triggers (PostToolUse, after every tool call) when ALL of:
#   - access.json has at least one allowFrom entry (paired)
#   - silence.json shows recent TG activity (inbound within last hour)
#   - EITHER (now - lastReplyAt > 90s) OR (toolCallsSinceReply >= 5)
#
# Re-firing policy (avoids one-shot fatigue without spamming):
#   - First time after a reply: fire immediately when threshold crossed
#   - After first fire: re-fire only on multiples of 5 calls OR every 60s
#
# State writes:
#   - This hook increments toolCallsSinceReply on every call
#   - server.ts resets {lastReplyAt: now, toolCallsSinceReply: 0} after
#     successful reply/edit_message
#   - server.ts sets lastInboundAt on inbound delivery (post-gate)
# Race window between server reset and hook increment is benign: the
# counter ends up at 1 after a reply (instead of 0), so the threshold
# fires after 4 more tool calls — close enough for a heuristic.
#
# Inert paths: no jq, no access.json, no allowFrom, no recent inbound,
# or no state file yet. Bail without writing anywhere so background
# (non-TG) sessions never see this hook do anything.
#
# Auto-registered via the plugin manifest (hooks/hooks.json).

set -u

STATE_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"
ACCESS_FILE="$STATE_DIR/access.json"
SILENCE_FILE="$STATE_DIR/silence.json"

# Drain stdin (PostToolUse payload — we don't read it but the harness sends it).
cat >/dev/null 2>&1 || true

command -v jq >/dev/null 2>&1 || exit 0
[[ -r "$ACCESS_FILE" ]] || exit 0
allowed=$(jq -r '.allowFrom // [] | length' "$ACCESS_FILE" 2>/dev/null)
[[ "${allowed:-0}" -gt 0 ]] || exit 0

now=$(date +%s)
state="{}"
[[ -r "$SILENCE_FILE" ]] && state=$(cat "$SILENCE_FILE" 2>/dev/null)
[[ -z "$state" ]] && state="{}"

last_inbound=$(printf '%s' "$state" | jq -r '.lastInboundAt // 0' 2>/dev/null)
last_reply=$(printf '%s' "$state"   | jq -r '.lastReplyAt // 0'   2>/dev/null)
last_reminder=$(printf '%s' "$state" | jq -r '.lastReminderAt // 0' 2>/dev/null)
calls=$(printf '%s' "$state"        | jq -r '.toolCallsSinceReply // 0' 2>/dev/null)

# Bump counter unconditionally; we still want it accurate even if the
# session isn't currently in a TG conversation (a fresh inbound later
# should see real numbers, not zero).
calls=$((calls + 1))

# Bail when the session isn't in a TG conversation — no inbound this hour
# means no one's waiting on a reply. Persist the bumped counter anyway in
# case a TG inbound lands later in this same agent's life.
in_conversation=1
if (( last_inbound == 0 || now - last_inbound > 3600 )); then
  in_conversation=0
fi

# Compute thresholds.
since_reply=0
if (( last_reply > 0 )); then
  since_reply=$(( now - last_reply ))
elif (( last_inbound > 0 )); then
  # Never replied to this TG thread — measure silence from inbound.
  since_reply=$(( now - last_inbound ))
fi

should_fire=0
if (( in_conversation )); then
  crossed_count=$(( calls >= 5 ? 1 : 0 ))
  crossed_time=$(( since_reply > 90 ? 1 : 0 ))
  if (( crossed_count || crossed_time )); then
    if (( last_reminder == 0 || last_reminder < last_reply || last_reminder < last_inbound )); then
      # First time crossing the threshold since the last
      # reply/inbound — always fire.
      should_fire=1
    elif (( calls >= 5 && calls % 5 == 0 )); then
      should_fire=1
    elif (( now - last_reminder >= 60 )); then
      should_fire=1
    fi
  fi
fi

new_reminder=$last_reminder
(( should_fire )) && new_reminder=$now

# Atomic write — tmp + rename — so the server-side updater never sees a
# half-written file.
tmp="${SILENCE_FILE}.tmp.$$"
jq -n \
  --argjson li "$last_inbound" \
  --argjson lr "$last_reply" \
  --argjson lm "$new_reminder" \
  --argjson c  "$calls" \
  '{lastInboundAt: $li, lastReplyAt: $lr, lastReminderAt: $lm, toolCallsSinceReply: $c}' \
  > "$tmp" 2>/dev/null && mv "$tmp" "$SILENCE_FILE" 2>/dev/null
rm -f "$tmp" 2>/dev/null

(( should_fire )) || exit 0

# Inject the reminder. additionalContext on PostToolUse is appended to
# the tool result the model sees — same surface the harness uses for the
# "task tools haven't been used" nudge.
reason="You've gone ${since_reply}s and ${calls} tool calls without sending a Telegram message. The user alarms at >60s silence — edit your last reply (mcp__plugin_telegram_telegram__edit_message) with a one-line status now, or send a fresh reply if a new inbound landed. Don't go silent."

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $r
  }
}'
exit 0
