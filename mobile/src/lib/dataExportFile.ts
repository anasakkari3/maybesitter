/**
 * Handing the user's data export to the OS share sheet (#174 step 7).
 *
 * ── Why this module may touch the filesystem ─────────────────────
 *
 * `eslint.config.js` forbids `expo-file-system*` under `src/api/**`,
 * `src/features/**` and `src/screens/**`: no local database or file cache of
 * user content (#148, #157). An export is the opposite of a cache, and the
 * rule is still right to be blanket, so the one file an export needs is made
 * here, outside those globs, exactly as `shareFiles.ts` deletes the copies a
 * share left behind.
 *
 * The share sheet takes a file, not a string, so the JSON has to exist on disk
 * while the sheet is open. It exists for exactly that long:
 *
 *   - it is written to the cache directory, which the OS may purge and which
 *     is never backed up;
 *   - it is deleted in a `finally` as soon as the sheet closes, whether the
 *     user sent it somewhere, cancelled, or the sheet failed to open;
 *   - any copy a killed process left behind is swept before the next one is
 *     written, so at most one ever exists.
 *
 * ── expo-sharing is loaded on use ────────────────────────────────
 *
 * Its JS calls `requireNativeModule('ExpoSharing')` at import time, which
 * throws in a binary built before the dependency was added. Requiring it on
 * press rather than at startup means an old build fails this one action,
 * cleanly, instead of failing to launch.
 *
 * Nothing here logs: a path names the file, and the file is the account.
 */
import { File, Paths } from 'expo-file-system';

export const EXPORT_FILE_PREFIX = 'maybesitter-export-';

export type ShareFile = (uri: string, options: { mimeType: string; UTI: string; dialogTitle: string }) => Promise<void>;

type SharingModule = typeof import('expo-sharing');

async function shareWithSystemSheet(uri: string, options: { mimeType: string; UTI: string; dialogTitle: string }): Promise<void> {
  // `require`, not `import()`: the convention and the reason are in
  // `src/notifications/nativeModules.ts`. It throws here, inside the press,
  // on a binary without the native module — which the caller reports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sharing = require('expo-sharing') as SharingModule;
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing is not available');
  await Sharing.shareAsync(uri, options);
}

/** Deletes any export a previous, interrupted run left in the cache. */
export function sweepExportFiles(): number {
  let removed = 0;
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && entry.name.startsWith(EXPORT_FILE_PREFIX)) {
        try {
          entry.delete();
          removed += 1;
        } catch {
          // One file that will not go does not stop the rest.
        }
      }
    }
  } catch {
    // An unreadable cache directory holds nothing this module can reach.
  }
  return removed;
}

/**
 * Writes the export, opens the share sheet on it, and removes it again.
 *
 * Resolves when the sheet has closed. Rejects if the file could not be written
 * or the sheet could not open; the file is gone either way.
 */
export async function shareExportFile(
  json: string,
  options: { dialogTitle: string; exportedAt: string },
  share: ShareFile = shareWithSystemSheet,
): Promise<void> {
  sweepExportFiles();
  const day = options.exportedAt.slice(0, 10).replace(/[^0-9-]/g, '') || 'export';
  const file = new File(Paths.cache, `${EXPORT_FILE_PREFIX}${day}.json`);
  try {
    file.create({ overwrite: true });
    file.write(json);
    await share(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: options.dialogTitle });
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // The sweep before the next export takes it.
    }
  }
}
