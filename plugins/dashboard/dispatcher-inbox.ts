import { renameSync, writeFileSync } from 'node:fs'

type InboxIo = {
  write(path: string, body: string): void
  rename(from: string, to: string): void
}

const REAL_IO: InboxIo = {
  write(path, body) {
    writeFileSync(path, body, { mode: 0o600 })
  },
  rename(from, to) {
    renameSync(from, to)
  },
}

/**
 * Spool one dashboard message for the dispatcher. This is async on purpose:
 * ENOSPC/EACCES/EROFS from the synchronous atomic write become a rejected
 * promise and reach each caller's existing `.catch()` or `await` boundary.
 */
export async function writeDispatcherInbox(
  tmp: string,
  dest: string,
  payload: unknown,
  io: InboxIo = REAL_IO,
): Promise<void> {
  io.write(tmp, JSON.stringify(payload) + '\n')
  io.rename(tmp, dest)
}
