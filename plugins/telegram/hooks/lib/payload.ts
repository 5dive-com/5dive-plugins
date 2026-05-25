// Read the hook payload from stdin and JSON-parse. Returns {} on empty or
// malformed input so callers can `payload.transcript_path` without a guard
// at every site. Errors land in caller's try/catch only if the caller
// actively wants to know.
export async function readPayload<T = unknown>(): Promise<T> {
  try {
    const text = await Bun.stdin.text()
    if (!text.trim()) return {} as T
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}
