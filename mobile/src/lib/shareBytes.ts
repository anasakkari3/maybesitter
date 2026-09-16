/**
 * Reading a shared file into memory, once, to refuse it (UC-3.5, #189).
 *
 * ── Why this is a module of its own, here ────────────────────────
 *
 * `eslint.config.js` forbids importing `expo-file-system*` from `src/api/**`,
 * `src/features/**` and `src/screens/**`, because the rule it enforces is "no
 * local database or file cache of user content" (#148, #157). The ban is
 * blanket and should be: a rule with a judgement call in it is a rule nobody
 * can check. So a read that has to happen lives outside those globs, and this
 * header is the argument the config's own prose demands for anything put here.
 *
 * `shareFiles.ts` is the neighbouring exception and it is deliberately **not**
 * where this went. Its argument is that it does the opposite of what the rule
 * aims at — it *deletes* files and creates none — and that argument does not
 * stretch to pulling a user's chat archive into the JavaScript heap. This needs
 * its own, which is below.
 *
 * ── The argument ─────────────────────────────────────────────────
 *
 * The rule is about *keeping* user content on the device. This keeps nothing:
 * it returns an array to a caller that inspects it and drops it, there is no
 * store, no cache, no key, and nothing written. The read exists so that a zip
 * bomb can be refused **before** it is uploaded, which is #189's acceptance
 * criterion — "an entry over 1 MB or a compression ratio over 100 is refused on
 * the device". Without a read there is nothing to refuse, and the guard that
 * exists in `whatsappExportReader.ts` would be a correct, tested function the
 * product never calls.
 *
 * The rest of the share path still never touches the bytes: `apiUpload` hands
 * React Native a `{ uri, name, type }` descriptor and the platform streams the
 * file, so a 15 MB share is never a string in the JS heap. This is one archive,
 * read once, at the moment a decision is being made about it.
 *
 * ── It never throws ──────────────────────────────────────────────
 *
 * A file the platform will not give up is not the user's error, and it must not
 * be a crash on a screen they reached by sharing something. `null` is "this
 * could not be read", the caller turns that into the ordinary refusal, and
 * nothing is logged — a path is a file name and a file name is content.
 */
import { File } from 'expo-file-system';

/**
 * The bytes of a shared file, or null when there are none to be had.
 *
 * `limitBytes` is a ceiling on what will be pulled into memory, checked against
 * the platform's own size first so an over-large file is refused without being
 * read at all. A file the OS reports as zero bytes is read anyway: `size` is 0
 * both for an empty file and for one the platform would not measure, and
 * `intake.ts` already treats an unknown size as "let the reader decide".
 *
 * Synchronous on purpose. The caller is deciding whether to start an upload,
 * and a decision that has already been made by the time the answer arrives is
 * not a guard.
 */
export function readSharedFileBytes(uri: string, limitBytes: number): Uint8Array | null {
  if (!uri.startsWith('file://') && !uri.startsWith('/')) return null;
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    if (file.size > limitBytes) return null;
    const bytes = file.bytesSync();
    // Measured after the read as well: `size` is the platform's claim about the
    // file, and the array is what it actually gave us.
    return bytes.byteLength > limitBytes ? null : bytes;
  } catch {
    // Already gone, a uri the platform will not resolve, or a read that failed
    // half way. None of those is worth a log line that could carry a name.
    return null;
  }
}
