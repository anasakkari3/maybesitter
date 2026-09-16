/**
 * The one text file inside a WhatsApp export, and nothing else (UC-3.5, #189).
 *
 * ── A chat archive is attacker-controlled input ──────────────────
 *
 * Every other file this route reads is a blob the model looks at. A zip is a
 * *program*: a few hundred bytes of it can instruct a decompressor to produce
 * gigabytes, and the classic 42.zip is 42 KB that expands to 4.5 PB. The share
 * route's 25 MB body limit says nothing about that, because the bomb is inside
 * the 25 MB.
 *
 * So there are three limits here, and each of them is enforced at a different
 * moment on purpose:
 *
 *  1. **The declared size, before anything is inflated.** An entry whose
 *     central directory says it expands past `MAX_ENTRY_BYTES` is refused
 *     without a byte being decompressed.
 *  2. **The declared ratio, before anything is inflated.** An entry claiming
 *     more than `MAX_COMPRESSION_RATIO` to one is refused the same way.
 *  3. **The real size, *during* inflation.** Both numbers above come out of the
 *     archive, which is to say out of the attacker, and a bomb declares
 *     whatever gets it past a check. `zlib.inflateRawSync`'s `maxOutputLength`
 *     is the one that cannot be lied to: it aborts the inflate the moment the
 *     output buffer would exceed it, rather than allocating first and measuring
 *     after. That is the guard; 1 and 2 are there to make the common refusal
 *     free.
 *
 * ── Media is never extracted, structurally ───────────────────────
 *
 * The acceptance criterion is that media is never extracted. It is held by the
 * shape of this function rather than by a delete afterwards: only entries whose
 * name ends in `.txt` are ever passed to the inflater, and the compressed bytes
 * of everything else are never even sliced out of the archive. There is no code
 * path here that decompresses a `.jpg`, so there is nothing to forget to clean
 * up.
 *
 * ── Why the central directory and not a library ──────────────────
 *
 * The same argument `mediaType.ts` makes about `file-type`. A WhatsApp export
 * is a flat, stored-or-deflated zip with fewer than a dozen entries; reading
 * its central directory is sixty lines, and those sixty lines are auditable in
 * a way that "which of this library's twelve code paths allocates before it
 * checks" is not. The device has the harder version of this problem — see
 * `mobile/src/features/share/whatsappExportReader.ts`.
 */
import { inflateRawSync } from 'node:zlib';
import { decodeUtf8 } from './mediaType';
import { ShareInputError } from './shareTypes';

/**
 * The most one entry may expand to. 1 MB.
 *
 * A year of a busy group chat is a few hundred kilobytes of `_chat.txt`, and
 * the device refuses a bare `.txt` share above exactly this, so an archive
 * whose transcript is larger than a transcript can be is not a transcript.
 */
export const MAX_ENTRY_BYTES = 1024 * 1024;
/**
 * The most an entry may expand *by*. 100 to 1.
 *
 * Text deflates at roughly 3:1, and a chat export of repeated headers reaches
 * perhaps 8:1. DEFLATE's theoretical maximum is 1032:1, which is what a bomb
 * uses. A hundred is far above anything a real export does and far below
 * anything an attack is worth building.
 */
export const MAX_COMPRESSION_RATIO = 100;
/** More entries than this and it is not a chat export. */
export const MAX_ENTRIES = 512;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The sentinel a Zip64 archive writes where a 32-bit size would go. */
const ZIP64_SENTINEL = 0xffffffff;

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function refuse(reason: string, message: string): never {
  // 415 rather than 400: the bytes are a well-formed zip and this is a
  // statement about what is *in* it, which is the same class of answer as
  // "that kind of file cannot be read here".
  throw new ShareInputError(415, reason, message);
}

/**
 * Where the central directory starts.
 *
 * Scanned backwards from the end, because the end-of-central-directory record
 * is last and may be followed by up to 64 KB of comment. Only that much is
 * scanned: a signature found further back is inside somebody's file data.
 */
function endOfCentralDirectory(view: DataView): { offset: number; entries: number } {
  const limit = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let index = view.byteLength - 22; index >= limit; index -= 1) {
    if (view.getUint32(index, true) !== EOCD_SIGNATURE) continue;
    const entries = view.getUint16(index + 10, true);
    const offset = view.getUint32(index + 16, true);
    if (offset === ZIP64_SENTINEL || entries === 0xffff) {
      refuse('archive_unsupported', 'that archive is in a format this cannot read');
    }
    return { offset, entries };
  }
  refuse('archive_unreadable', 'that archive could not be read');
}

/** Every entry the archive lists, without touching any of their data. */
function centralDirectory(bytes: Uint8Array): readonly CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { offset, entries } = endOfCentralDirectory(view);
  if (entries > MAX_ENTRIES) refuse('archive_too_many_entries', 'that archive holds more files than a chat export does');

  const found: CentralEntry[] = [];
  let cursor = offset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      refuse('archive_unreadable', 'that archive could not be read');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      refuse('archive_unsupported', 'that archive is in a format this cannot read');
    }
    const name = decodeUtf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength)) ?? '';
    found.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/**
 * Whether an entry is the transcript rather than an attachment.
 *
 * `__MACOSX/` is the resource-fork directory macOS adds when a user
 * re-compresses an export in Finder; its members are named after the real ones
 * and are not text. A name with `..` or a leading `/` in it is refused outright
 * — nothing here writes to disk, so it cannot escape anywhere, but an archive
 * that contains one is not a WhatsApp export and saying so is free.
 */
function isTranscript(entry: CentralEntry): boolean {
  const name = entry.name;
  if (name.startsWith('__MACOSX/') || name.endsWith('/')) return false;
  if (name.includes('..') || name.startsWith('/')) return false;
  return name.toLowerCase().endsWith('.txt');
}

/** Where an entry's compressed bytes actually begin. */
function dataStart(bytes: Uint8Array, entry: CentralEntry): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.localOffset + 30 > bytes.byteLength || view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    refuse('archive_unreadable', 'that archive could not be read');
  }
  // The local header's own name and extra lengths, not the central one's: the
  // extra field legitimately differs between the two, and using the central
  // directory's length here reads from the wrong offset on most real archives.
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  return entry.localOffset + 30 + nameLength + extraLength;
}

/** What one archive gave up, and what it was carrying. */
export interface ChatArchiveContent {
  readonly text: string;
  /** Entries that were not the transcript. Never opened; only counted. */
  readonly mediaEntries: number;
}

/**
 * The transcript inside a WhatsApp export.
 *
 * Throws `ShareInputError` for an archive this refuses, which is every archive
 * that is not one flat transcript plus attachments it will not open.
 */
export function readChatArchive(bytes: Uint8Array): ChatArchiveContent {
  const entries = centralDirectory(bytes);
  const transcripts = entries.filter(isTranscript);
  const mediaEntries = entries.length - transcripts.length;
  if (transcripts.length === 0) refuse('archive_no_transcript', 'that archive holds no chat transcript');

  // `_chat.txt` is what iOS names it. When an archive holds several, the
  // largest is taken: a re-zipped export sometimes carries a stray `notes.txt`,
  // and the transcript is the long one.
  const chosen = transcripts.find((entry) => entry.name.toLowerCase().endsWith('_chat.txt'))
    ?? transcripts.reduce((largest, entry) => (entry.uncompressedSize > largest.uncompressedSize ? entry : largest));

  // (1) and (2): the declared size and ratio, before a byte is inflated.
  if (chosen.uncompressedSize > MAX_ENTRY_BYTES) {
    refuse('archive_entry_too_large', 'a file inside that archive is larger than this reads');
  }
  if (chosen.compressedSize > 0 && chosen.uncompressedSize / chosen.compressedSize > MAX_COMPRESSION_RATIO) {
    refuse('archive_ratio_exceeded', 'that archive expands further than this reads');
  }

  const start = dataStart(bytes, chosen);
  const end = start + chosen.compressedSize;
  if (end > bytes.byteLength) refuse('archive_unreadable', 'that archive could not be read');
  const compressed = bytes.subarray(start, end);

  let raw: Uint8Array;
  if (chosen.method === 0) {
    // Stored. There is nothing to inflate, so the measurement is the length,
    // and it is taken before the bytes are adopted rather than after.
    if (compressed.byteLength > MAX_ENTRY_BYTES) {
      refuse('archive_entry_too_large', 'a file inside that archive is larger than this reads');
    }
    raw = compressed;
  } else if (chosen.method === 8) {
    try {
      /*
       * (3): the limit that cannot be lied to, and the *only* thing standing
       * between a false header and the whole expansion.
       *
       * `maxOutputLength` throws as the output buffer crosses the ceiling, so
       * a header claiming 900 KB over a body that expands to 4 GB stops at
       * 1 MB rather than at 4 GB. It is checked against the ceiling and never
       * against what the archive declared, because the declaration is the
       * attacker's.
       *
       * There is deliberately no `raw.byteLength > MAX_ENTRY_BYTES` check
       * after this call. There was one, and it made this line untestable: it
       * caught the bomb *after* the allocation, so removing `maxOutputLength`
       * left the suite green while the out-of-memory it exists to prevent was
       * back. A second check that can only fire when the first has already
       * failed is not defence in depth, it is cover for a broken guard.
       */
      raw = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      // `ERR_BUFFER_TOO_LARGE` and a corrupt stream arrive the same way and
      // are the same answer to the user. The error is never quoted: zlib's
      // message can carry bytes from the stream.
      refuse('archive_entry_too_large', 'a file inside that archive is larger than this reads');
    }
  } else {
    refuse('archive_unsupported', 'that archive is in a format this cannot read');
  }

  // The real ratio, now that both numbers are measured rather than declared.
  // A bomb can keep its expansion under a megabyte and still be a bomb.
  if (compressed.byteLength > 0 && raw.byteLength / compressed.byteLength > MAX_COMPRESSION_RATIO) {
    refuse('archive_ratio_exceeded', 'that archive expands further than this reads');
  }

  const text = decodeUtf8(raw);
  if (text === null) refuse('archive_not_text', 'the transcript in that archive is not readable text');
  return { text, mediaEntries };
}
