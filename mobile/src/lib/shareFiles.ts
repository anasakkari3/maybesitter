/**
 * Deleting the copies a share left behind (UC-3.0, #183).
 *
 * ── Why this module exists at all ────────────────────────────────
 *
 * `eslint.config.js` forbids importing `expo-file-system*` from `src/api/**`,
 * `src/features/**` and `src/screens/**`, because the rule it enforces is "no
 * local database or file cache of user content" (#148, #157). This code does
 * the opposite of what that rule is aimed at — it *removes* files — but the ban
 * is blanket, and it should be: a rule with a judgement call in it is a rule
 * nobody can check. So this is the one module allowed to touch the filesystem,
 * it lives outside those globs exactly as `src/lib/deviceSettings/` does, and
 * this header is the argument the config's own prose demands for anything put
 * here.
 *
 * ── What is left behind, and by whom ─────────────────────────────
 *
 * Nothing here creates a file. Both platforms hand a shared file over as a copy
 * the OS made:
 *
 *   - **iOS.** The generated Share Extension copies what was shared into the
 *     App Group container (`containerURL(forSecurityApplicationGroupIdentifier:)`
 *     in `ShareExtensionViewController.swift`) so the main app can read it, and
 *     records the paths in the group's `UserDefaults`.
 *     `resetShareIntent()` clears the UserDefaults entry and **does not delete
 *     the files** — read `ExpoShareIntentModule.swift`'s `clearShareIntent`,
 *     which sets one key to nil and nothing else. Without this module, every
 *     photo anybody ever shared stays in the App Group container for the life of
 *     the install.
 *   - **Android.** The intent's `content://` uri is resolved to a copy in the
 *     app's own cache directory.
 *
 * The acceptance criterion is that no copy of the shared bytes remains in the
 * App Group container or the app cache. This is the half of that the phone owns.
 *
 * ── It never throws ──────────────────────────────────────────────
 *
 * A delete that fails must not become the user's error: they have either just
 * been handed a proposal or just pressed Discard, and either way the file is the
 * app's problem, not theirs. Failures are counted and returned so a caller can
 * assert on them in a test; nothing is logged, because a path is content.
 */
import { File } from 'expo-file-system';

/** What a cleanup managed. Counts only — a path is the user's file name. */
export interface ShareCleanupResult {
  deleted: number;
  /** Files that were already gone. Not a failure: the goal is that they are. */
  absent: number;
  failed: number;
}

/**
 * Deletes every uri given, and reports what happened.
 *
 * Call it in a `finally`, on every exit from the share screen — success,
 * failure, discard and unmount. A path that is not a `file://` uri is skipped
 * rather than attempted: Android hands out `content://` uris that belong to the
 * sharing app, and deleting one of those would be deleting somebody else's file.
 */
export function deleteSharedFiles(uris: readonly string[]): ShareCleanupResult {
  const result: ShareCleanupResult = { deleted: 0, absent: 0, failed: 0 };
  for (const uri of uris) {
    if (!uri.startsWith('file://') && !uri.startsWith('/')) continue;
    try {
      const file = new File(uri);
      if (!file.exists) {
        result.absent += 1;
        continue;
      }
      file.delete();
      result.deleted += 1;
    } catch {
      // Already gone, on a read-only volume, or a uri the platform will not
      // resolve. None of those is worth a line in a log that could carry a name.
      result.failed += 1;
    }
  }
  return result;
}

/** Whether a file the app was handed is still on disk. For tests and asserts. */
export function sharedFileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}
