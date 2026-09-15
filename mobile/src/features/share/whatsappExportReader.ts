/**
 * Reading a WhatsApp `.zip` export on the phone, before anything is uploaded
 * (UC-3.5, #189).
 *
 * ── Why this is on the device at all ─────────────────────────────
 *
 * A chat export is the one thing this product accepts that is not data but a
 * *program*: a zip tells a decompressor how much to produce, and 42 KB of it
 * can ask for 4.5 petabytes. The server has its own reader with the same two
 * limits (`lib/services/share/chatArchive.ts`) and does not trust this one —
 * but a bomb that is refused only on the server has already crossed the
 * network, already spent one of the user's thirty daily shares, and already
 * been decompressed somewhere. The acceptance criterion puts the refusal here.
 *
 * ── What fflate does and does not give you ───────────────────────
 *
 * This was chosen by reading the installed tree, not the documentation, and
 * three things about it decide the shape of the code below:
 *
 *  1. **`Unzip` surfaces each entry before decompressing it.** `onfile` fires
 *     as the local header is parsed, and an entry is only inflated if
 *     `start()` is called on it. So "media is never extracted" is structural
 *     here too: `start()` is called for `.txt` entries and for nothing else,
 *     and a photo's compressed bytes are never handed to an inflater.
 *  2. **`file.originalSize` and `file.size` come out of the archive**, which is
 *     to say out of whoever wrote it, and are *absent* for an entry written in
 *     streaming mode. They are worth checking because the check is free, and
 *     they are not worth believing.
 *  3. **`file.terminate()` does nothing for the synchronous decoder.** Read
 *     `UnzipInflate` in `fflate/lib/index.cjs`: it has no `terminate`, and
 *     `Unzip`'s `terminate` is `if (d && d.terminate) d.terminate()`. There is
 *     no way to abort an inflate that is already running, and `inflateSync` has
 *     no output ceiling of any kind — nothing in fflate corresponds to Node
 *     zlib's `maxOutputLength`.
 *
 * **That third point is the finding, and it is why this feeds the archive in
 * chunks.** `Unzip.push(wholeArchive)` inflates an entry to completion before
 * any callback runs — measured, in `fflate's streaming decoder has no ceiling
 * at all when fed in one push`: sixteen megabytes delivered in a single
 * `ondata` call. A byte counter in that callback would be told about the
 * gigabyte after it had been allocated. Pushing `FEED_BYTES` at a time makes
 * `ondata` fire while the entry is still being read, and the refusal is to stop
 * feeding.
 *
 * ── What the chunking is, and what it is not ─────────────────────
 *
 * It is a bound on peak allocation, not a decision. The refusal itself comes
 * from the byte counter, which answers the same way whether the archive
 * arrived in one push or five hundred — so **removing `FEED_BYTES` leaves this
 * file's suite green**, and that is said here rather than left for somebody to
 * discover and read as a guard that works.
 *
 * What it changes is the size of the allocation the refusal happens *after*:
 * one chunk's worth of expansion (32 KiB in, at most about 33 MB out at
 * DEFLATE's 1032:1 ceiling) instead of the archive's. Asserting that
 * difference would take a fixture expanding past this process's heap —
 * gigabytes — to build and inflate on every run, which is a worse trade than
 * writing the reason down. The measurement it rests on is asserted; the
 * megabytes it saves are not.
 */
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';

/** The most one entry inside an archive may expand to. 1 MB. */
export const MAX_ENTRY_BYTES = 1024 * 1024;
/** The most an entry may expand *by*. Text deflates at about 3:1; a bomb at 1000:1. */
export const MAX_COMPRESSION_RATIO = 100;
/** More entries than this and it is not a chat export. */
export const MAX_ENTRIES = 512;
/**
 * How much of the archive is fed to the decompressor at a time.
 *
 * The whole point of the number. DEFLATE's maximum expansion is 1032 to 1, so
 * 32 KiB in can become at most about 33 MB out before the counter below is
 * consulted again — an allocation a phone survives, where the archive's own
 * full expansion is not. Smaller is safer and slower; this reads a 15 MB export
 * in under five hundred pushes.
 */
export const FEED_BYTES = 32 * 1024;

/**
 * Why an archive will not be uploaded.
 *
 * A fixed vocabulary, the same shape as `SharePayloadProblem` in `intake.ts`,
 * and never a sentence and never a file name.
 */
export type ExportProblem =
  | 'not_an_archive'
  | 'no_transcript'
  | 'entry_too_large'
  | 'ratio_exceeded'
  | 'not_text';

export type ExportRead =
  | { ok: true; text: string; mediaEntries: number }
  | { ok: false; problem: ExportProblem };

/** Whether an entry is the transcript rather than an attachment. */
function isTranscript(name: string): boolean {
  if (name.startsWith('__MACOSX/') || name.endsWith('/')) return false;
  if (name.includes('..') || name.startsWith('/')) return false;
  return name.toLowerCase().endsWith('.txt');
}

/** What one entry is worth reading, according to what the archive claims. */
function declaredRefusal(file: UnzipFile): ExportProblem | null {
  const original = file.originalSize;
  const compressed = file.size;
  if (original !== undefined && original > MAX_ENTRY_BYTES) return 'entry_too_large';
  if (original !== undefined && compressed !== undefined && compressed > 0
    && original / compressed > MAX_COMPRESSION_RATIO) {
    return 'ratio_exceeded';
  }
  return null;
}

/**
 * The transcript inside a WhatsApp export, or the reason not to upload it.
 *
 * Synchronous and pure: bytes in, a string or a refusal out. It touches no
 * native module and no filesystem, which is what lets it be tested without a
 * device — and what keeps it importable from `src/features/**`, where
 * `eslint.config.js` forbids `expo-file-system` outright.
 */
export function readWhatsAppExport(archive: Uint8Array): ExportRead {
  /** The transcript, as it is produced. Reset if a later entry supersedes it. */
  let chunks: Uint8Array[] = [];
  let produced = 0;
  let mediaEntries = 0;
  let started = 0;
  let problem: ExportProblem | null = null;
  /** The entry currently being inflated, so its counter is its own. */
  let reading: { name: string } | null = null;

  const unzip = new Unzip((file) => {
    if (problem !== null) return;
    if (!isTranscript(file.name)) {
      mediaEntries += 1;
      // Never started, so never inflated. This is the whole of "media is never
      // extracted": there is no branch below that a photo can reach.
      return;
    }
    if (started >= MAX_ENTRIES) return;
    const refusal = declaredRefusal(file);
    if (refusal !== null) {
      problem = refusal;
      return;
    }
    started += 1;
    // A second `.txt` replaces the first rather than appending to it: an
    // archive holding `notes.txt` and `_chat.txt` must not produce the two
    // glued together. `_chat.txt` is what iOS names the transcript and wins;
    // otherwise the first one found is kept, because unlike the server's
    // reader this one has no central directory to compare sizes in — it is
    // deciding as the entries stream past.
    if (reading !== null && produced > 0) {
      // Keep whichever is named `_chat.txt`; otherwise keep the longer one.
      const incomingPreferred = file.name.toLowerCase().endsWith('_chat.txt');
      if (!incomingPreferred) return;
    }
    reading = { name: file.name };
    chunks = [];
    produced = 0;
    file.ondata = (error, chunk) => {
      // Never thrown from here. `UnzipInflate.push` wraps its inflate in a
      // try/catch and re-delivers a throw to this same callback as an error,
      // so throwing would re-enter rather than unwind.
      if (error) {
        problem ??= 'not_an_archive';
        return;
      }
      if (problem !== null || chunk.length === 0) return;
      produced += chunk.length;
      // The limit that cannot be lied to, checked while the entry is still
      // being read. See the module header for why this is only meaningful
      // because the archive is fed in chunks.
      if (produced > MAX_ENTRY_BYTES) {
        problem = 'entry_too_large';
        chunks = [];
        return;
      }
      chunks.push(chunk);
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  let consumed = 0;
  try {
    for (let offset = 0; offset < archive.length; offset += FEED_BYTES) {
      // The refusal *is* stopping the feed: fflate's synchronous decoder has no
      // `terminate`, so an inflate that is not fed does not continue.
      if (problem !== null) break;
      const end = Math.min(offset + FEED_BYTES, archive.length);
      unzip.push(archive.subarray(offset, end), end === archive.length);
      consumed = end;
    }
  } catch {
    // A malformed archive. fflate throws a numbered error whose message can
    // quote the bytes it was reading, so it is never carried anywhere.
    return { ok: false, problem: problem ?? 'not_an_archive' };
  }

  if (problem !== null) return { ok: false, problem };
  if (reading === null) return { ok: false, problem: started === 0 && mediaEntries === 0 ? 'not_an_archive' : 'no_transcript' };

  // The real ratio, now that both numbers are measured rather than declared.
  // `consumed` is the whole archive rather than this entry's share of it, which
  // makes this the *conservative* direction: it can only ever under-report how
  // sharply one entry expanded.
  if (consumed > 0 && produced / consumed > MAX_COMPRESSION_RATIO) {
    return { ok: false, problem: 'ratio_exceeded' };
  }

  const joined = new Uint8Array(produced);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  let text: string;
  try {
    // Strict, exactly as the server's `decodeUtf8` is: without `fatal` a JPEG
    // renamed `.txt` decodes into a page of replacement characters and is then
    // uploaded as a transcript.
    text = new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch {
    return { ok: false, problem: 'not_text' };
  }
  return { ok: true, text, mediaEntries };
}
