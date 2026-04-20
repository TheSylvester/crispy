/**
 * Atomic Write — Partial-read-safe file writes for shared ~/.crispy/ state
 *
 * Writes go to a per-process temp sibling (`<path>.tmp-<pid>-<rand>`) and are
 * rename(2)'d into place. On POSIX the rename is atomic; on Windows it
 * replaces atomically on NTFS. Concurrent readers from other VS Code windows
 * see either the old file or the new file, never a truncated partial write.
 *
 * Call sites that race across processes:
 * - `settings-store.saveSettingsFile()` — `~/.crispy/settings.json`
 * - `ipc-server.register/unregister/pruneAndRead` — `~/.crispy/ipc/servers.json`
 *
 * @module atomic-write
 */
import { renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { rename, writeFile, unlink } from 'node:fs/promises';

type WriteOptions = { mode?: number };

function tempPath(finalPath: string): string {
  return `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function writeFileAtomic(
  finalPath: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): Promise<void> {
  const tmp = tempPath(finalPath);
  try {
    await writeFile(tmp, data, { mode: options.mode });
    await rename(tmp, finalPath);
  } catch (err) {
    try { await unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
}

export function writeFileAtomicSync(
  finalPath: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): void {
  const tmp = tempPath(finalPath);
  try {
    writeFileSync(tmp, data, { mode: options.mode });
    renameSync(tmp, finalPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
