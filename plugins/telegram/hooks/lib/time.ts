// Portable reset-epoch extractor. The previous bash version relied on
// GNU `date -d "9pm UTC" +%s` which doesn't exist on macOS/BSD. JS Date
// parsing is cross-platform but only accepts ISO-ish input — so we
// re-implement the "<HH(:MM)?>(am|pm)? (<TZ>)?" parse explicitly.
//
// Bumps to "tomorrow" when the parsed clock time is in the past today —
// matches the bash logic. Returns null on any input we can't parse.

const CLOCK_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i
const TZ_RE = /\(([A-Za-z_]+\/[A-Za-z_]+|UTC|GMT)\)/

export function parseResetEpoch(text: string): number | null {
  // Numeric epoch passthrough (used for payload.resetsAt). Bash also
  // tolerated ms-precision epochs by dividing by 1000 if >10^10 — keep that.
  if (/^\d+$/.test(text.trim())) {
    let n = parseInt(text.trim(), 10)
    if (n > 1e10) n = Math.floor(n / 1000)
    return n
  }

  // ISO-ish (RFC3339) — let Date handle it.
  const iso = Date.parse(text)
  if (!isNaN(iso)) return Math.floor(iso / 1000)

  // Plain-English "Xpm" / "X:YYam (TZ)" — extract clock + optional TZ.
  return parseResetFromText(text)
}

export function parseResetFromText(text: string): number | null {
  const clock = CLOCK_RE.exec(text)
  if (!clock) return null
  const hour12 = parseInt(clock[1], 10)
  const minute = clock[2] ? parseInt(clock[2], 10) : 0
  const isPm = clock[3].toLowerCase() === 'pm'
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null
  let hour24 = hour12 % 12
  if (isPm) hour24 += 12

  const tz = TZ_RE.exec(text)?.[1]
  const tzName = tz === 'GMT' ? 'UTC' : tz // GMT and UTC are aliases for our purposes
  const now = new Date()

  // Today's date in the target TZ, with the parsed clock time.
  const epoch = epochAtTz(now, hour24, minute, tzName)
  if (epoch === null) return null

  // Bump tomorrow if the parsed time is already in the past.
  const nowSec = Math.floor(Date.now() / 1000)
  if (epoch < nowSec) {
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
    return epochAtTz(tomorrow, hour24, minute, tzName)
  }
  return epoch
}

// Compute epoch (seconds) for "today at <hour>:<minute>" in the given IANA
// timezone. Uses Intl.DateTimeFormat to extract the TZ-local Y/M/D, then
// constructs a UTC date that matches by iterating once (TZ-aware Date
// construction in JS without third-party libs is genuinely this annoying).
function epochAtTz(referenceDay: Date, hour: number, minute: number, tzName?: string): number | null {
  // No TZ → use system local time.
  if (!tzName) {
    const d = new Date(
      referenceDay.getFullYear(),
      referenceDay.getMonth(),
      referenceDay.getDate(),
      hour,
      minute,
      0,
      0,
    )
    return Math.floor(d.getTime() / 1000)
  }
  try {
    // Get the Y/M/D in the target TZ for the reference day. Use 'sv-SE'
    // locale to get ISO-ish "YYYY-MM-DD" formatting.
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tzName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const [y, m, d] = fmt.format(referenceDay).split('-').map(s => parseInt(s, 10))
    // Build a candidate UTC instant for "Y-M-D hour:minute" and compute the
    // offset between that wall-clock and what the TZ shows.
    let candidate = Date.UTC(y, m - 1, d, hour, minute, 0)
    const checkFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tzName,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    })
    // Iterate up to twice: first to apply the base offset, second to handle
    // DST edge transitions. In practice converges immediately.
    for (let i = 0; i < 2; i++) {
      const shown = checkFmt.format(new Date(candidate))
      const [sh, sm] = shown.split(':').map(s => parseInt(s, 10))
      const wantTotal = hour * 60 + minute
      const gotTotal = sh * 60 + sm
      const drift = wantTotal - gotTotal
      if (drift === 0) break
      candidate += drift * 60 * 1000
    }
    return Math.floor(candidate / 1000)
  } catch {
    return null
  }
}
