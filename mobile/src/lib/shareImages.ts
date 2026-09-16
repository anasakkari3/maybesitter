/**
 * Reading and writing the one file a share rewrites (UC-3.6, #190).
 *
 * ── Why this module exists at all ────────────────────────────────
 *
 * The same reason `shareFiles.ts` does. `eslint.config.js` forbids importing
 * `expo-file-system*` from `src/api/**`, `src/features/**` and
 * `src/screens/**`, because the rule it enforces is "no local database or file
 * cache of user content" (#148, #157). The ban is blanket, and it should be: a
 * rule with a judgement call in it is a rule nobody can check. So the two
 * modules that do touch the filesystem live out here, and this header is the
 * argument the config's own prose demands for anything put in `src/lib/`.
 *
 * ── This one does create a file, and that is the difference ──────
 *
 * `shareFiles.ts` only removes. This writes: #190 requires that no EXIF is in
 * the upload, removing a segment from a file means rewriting the file, and a
 * rewritten file has to exist somewhere before React Native can stream it.
 *
 * What is written is *less* than what is already on disk. The OS has already
 * copied the shared photograph into the App Group container or the app cache;
 * this writes a second copy of the same picture with the GPS coordinates, the
 * camera serial and the editing history taken out, into the cache directory the
 * system may reclaim at any time. `ShareProvider` deletes both — the OS's copy
 * and this one — on every exit from the share flow, including unmount.
 *
 * ── The name carries nothing ─────────────────────────────────────
 *
 * A shared file is called "IMG_2024 Dana birthday.HEIC"; the name is content.
 * The copies written here are named from a counter and the container's own
 * extension, so nothing about what was shared is on the filesystem under a
 * readable name. The original name still travels in the upload's multipart
 * part, where the server reads it once for a three-word source hint and drops
 * it; that is #183's design and this does not change it.
 *
 * ── It throws, and the caller decides ────────────────────────────
 *
 * Unlike `deleteSharedFiles`, a failure here matters: it means the share cannot
 * be sent without its metadata, which is a share that must not be sent at all.
 * `prepareImages` turns a throw into a refusal the user can read. Nothing is
 * logged, because a path is a file name and a file name is content.
 */
import { File, Paths } from 'expo-file-system';
import type { ImageBytesPort } from '../features/share/prepareImages';

/** Enough to keep two shares in one session from colliding. Not a secret. */
let written = 0;

export const sharedImageBytes: ImageBytesPort = {
  read(uri: string): Uint8Array {
    return new File(uri).bytesSync();
  },
  write(bytes: Uint8Array, extension: string): string {
    written += 1;
    const file = new File(Paths.cache, `share-${Date.now()}-${written}.${extension}`);
    file.create({ overwrite: true, intermediates: true });
    file.write(bytes);
    return file.uri;
  },
};
