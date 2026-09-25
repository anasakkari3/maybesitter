/**
 * The zip half of a WhatsApp share (UC-3.5, #189).
 *
 * The acceptance criteria this file is the evidence for:
 *
 *  - an iOS `.zip` export parses;
 *  - media is never extracted;
 *  - an entry over 1 MB, or one that expands by more than a hundred to one, is
 *    refused — including when the archive's own headers say otherwise, which is
 *    the only case a real zip bomb presents.
 *
 * A chat export is attacker-controlled input. Every fixture here is built by
 * `tests/fixtures/whatsapp/zipBuilder.ts` rather than by a zip library, because
 * a library writes honest archives and the interesting cases are the dishonest
 * ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  MAX_COMPRESSION_RATIO,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  readChatArchive,
} from '../../lib/services/share/chatArchive.ts';
import { ShareInputError } from '../../lib/services/share/shareTypes.ts';
import { bomb, buildZip, bulkyText } from '../fixtures/whatsapp/zipBuilder.ts';
import { IOS_ENGLISH } from '../fixtures/whatsapp/exports.ts';

const encoder = new TextEncoder();
/** Real first bytes of a JPEG, so "the media entry" is really media. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ShareInputError, `expected a ShareInputError, got ${String(error)}`);
    assert.equal(error.status, 415);
    return error.reason;
  }
  return assert.fail('the archive was accepted');
}

/* ── The ordinary case ───────────────────────────────────────────── */

test('an iOS export parses, and its attachments are counted rather than opened', () => {
  const archive = buildZip([
    { name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) },
    { name: '00000002-PHOTO-2026-09-15-20-48-00.jpg', data: JPEG },
    { name: '00000003-AUDIO-2026-09-15-20-49-00.opus', data: new Uint8Array(64).fill(7) },
  ]);
  const content = readChatArchive(archive);
  assert.equal(content.text, IOS_ENGLISH);
  assert.equal(content.mediaEntries, 2);
});

test('a stored (uncompressed) transcript parses too', () => {
  const archive = buildZip([{ name: '_chat.txt', data: encoder.encode(IOS_ENGLISH), method: 0 }]);
  assert.equal(readChatArchive(archive).text, IOS_ENGLISH);
});

/**
 * The criterion, held by shape rather than by cleanup.
 *
 * There is no path from `readChatArchive` to a non-`.txt` entry's bytes, so the
 * evidence is that an archive whose media entry is *unreadable* still parses:
 * a reader that inflated everything and discarded the media afterwards would
 * throw here.
 */
test('media is never extracted — a corrupt attachment does not stop the transcript being read', () => {
  const corrupt = new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01]);
  const archive = buildZip([
    { name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) },
    // A deflate stream that cannot be inflated, declared as a deflated entry.
    { name: 'photo.jpg', data: corrupt, method: 0, declaredCompressedSize: corrupt.byteLength },
  ]);
  const content = readChatArchive(archive);
  assert.equal(content.text, IOS_ENGLISH);
  assert.equal(content.mediaEntries, 1);
});

test('a media entry that would expand into gigabytes is not looked at', () => {
  // 16 MB of one byte, next to a tiny transcript. If the reader inflated
  // everything it found, this would allocate 16 MB and then be thrown away.
  const archive = buildZip([
    { name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) },
    { name: 'video.mp4', data: bomb(16 * 1024 * 1024) },
  ]);
  const content = readChatArchive(archive);
  assert.equal(content.text, IOS_ENGLISH);
  assert.equal(content.mediaEntries, 1);
});

test('the macOS resource-fork directory is not read as a transcript', () => {
  const archive = buildZip([
    { name: '__MACOSX/._chat.txt', data: new Uint8Array([0, 5, 22, 7]) },
    { name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) },
  ]);
  assert.equal(readChatArchive(archive).text, IOS_ENGLISH);
});

/* ── The limits, declared ────────────────────────────────────────── */

test('an entry whose declared size is over the ceiling is refused before anything is inflated', () => {
  const archive = buildZip([
    { name: '_chat.txt', data: encoder.encode('short'), declaredUncompressedSize: MAX_ENTRY_BYTES + 1 },
  ]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_entry_too_large');
});

test('an entry whose declared ratio is over the ceiling is refused before anything is inflated', () => {
  const archive = buildZip([
    {
      name: '_chat.txt',
      data: encoder.encode('short'),
      declaredCompressedSize: 100,
      declaredUncompressedSize: 100 * (MAX_COMPRESSION_RATIO + 1),
    },
  ]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_ratio_exceeded');
});

/* ── The limit that cannot be lied to ────────────────────────────── */

/**
 * The only case that is actually a zip bomb.
 *
 * Both declarations are inside the limits and both are false: the header says
 * the entry expands to 900 KB, and the deflate stream expands to 16 MB. A
 * reader that trusted either number would allocate all of it. `maxOutputLength`
 * aborts the inflate as the output buffer crosses 1 MB, which is why this is a
 * refusal and not an out-of-memory.
 */
test('an entry that lies about its size in the header is still refused, during inflation', () => {
  const payload = bomb(16 * 1024 * 1024);
  const compressed = deflateRawSync(payload);
  const archive = buildZip([
    {
      name: '_chat.txt',
      data: payload,
      // Both numbers say "a large but ordinary transcript". Neither is true.
      declaredUncompressedSize: 900 * 1024,
      declaredCompressedSize: compressed.byteLength,
    },
  ]);
  assert.ok(compressed.byteLength < 200 * 1024, 'the fixture did not compress like a bomb');
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_entry_too_large');
});

/**
 * The bound is real, not incidental.
 *
 * A transcript just under the ceiling parses; the same transcript just over it
 * does not. Without both halves, a reader that refused everything would pass.
 */
/**
 * A bomb that stays under the size ceiling is still a bomb.
 *
 * Half a megabyte of one byte deflates to a few hundred, and every declared
 * number here is inside the limits: under 1 MB, and a declared ratio of about
 * eighty to one. Only the *measured* ratio gives it away, which is why that
 * check is separate from the size one rather than folded into it.
 */
test('an entry whose real ratio is over the ceiling is refused even when it fits under the size limit', () => {
  const payload = bomb(500 * 1024);
  // Derived rather than written down, so the fixture stays inside the declared
  // limits whichever way zlib's output moves.
  const declaredUncompressedSize = deflateRawSync(payload).byteLength * (MAX_COMPRESSION_RATIO - 1);
  assert.ok(declaredUncompressedSize < MAX_ENTRY_BYTES, 'the fixture no longer fits under the size ceiling');
  const archive = buildZip([{ name: '_chat.txt', data: payload, declaredUncompressedSize }]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_ratio_exceeded');
});

/**
 * A stored entry has no inflate to bound, so it is measured before it is taken.
 *
 * The header lies in the other direction here — it claims a kilobyte over a
 * megabyte of real, uncompressed data — so both declared checks wave it
 * through and `maxOutputLength` never runs, because there is nothing to
 * inflate. The measurement on the stored branch is the only thing left.
 */
test('a stored entry over the ceiling is refused, even when its header claims otherwise', () => {
  const archive = buildZip([{
    name: '_chat.txt',
    data: encoder.encode(bulkyText(MAX_ENTRY_BYTES + 4096)),
    method: 0,
    declaredUncompressedSize: 1024,
  }]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_entry_too_large');
});

test('the ceiling is a boundary: just under parses, just over is refused', () => {
  const under = bulkyText(MAX_ENTRY_BYTES - 1024);
  const over = bulkyText(MAX_ENTRY_BYTES + 1024);
  assert.equal(readChatArchive(buildZip([{ name: '_chat.txt', data: encoder.encode(under) }])).text.length, under.length);
  assert.equal(
    reasonOf(() => readChatArchive(buildZip([{ name: '_chat.txt', data: encoder.encode(over) }]))),
    'archive_entry_too_large',
  );
});

/* ── Everything that is not a chat export ────────────────────────── */

test('an archive with no text file in it is refused', () => {
  const archive = buildZip([{ name: 'photo.jpg', data: JPEG }]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_no_transcript');
});

test('bytes that are not a zip at all are refused rather than crashed on', () => {
  assert.equal(reasonOf(() => readChatArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))), 'archive_unreadable');
});

test('a truncated archive is refused rather than crashed on', () => {
  const archive = buildZip([{ name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) }]);
  assert.equal(reasonOf(() => readChatArchive(archive.subarray(0, archive.byteLength - 8))), 'archive_unreadable');
});

test('an entry compressed with something this cannot read is refused, not guessed at', () => {
  const archive = buildZip([{ name: '_chat.txt', data: encoder.encode(IOS_ENGLISH), method: 14 as 0 }]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_unsupported');
});

test('a transcript that is not valid UTF-8 is refused, not decoded into replacement characters', () => {
  // Windows-1256 «صباح» — text in another encoding, and not UTF-8.
  const archive = buildZip([{ name: '_chat.txt', data: new Uint8Array([0xd5, 0xc8, 0xc7, 0xcd]) }]);
  assert.equal(reasonOf(() => readChatArchive(archive)), 'archive_not_text');
});

/**
 * The largest `.txt` wins when there are several.
 *
 * A re-zipped export carries a stray `notes.txt` beside `_chat.txt`, and iOS
 * always names the transcript `_chat.txt` — so the name decides first and size
 * only breaks a tie between files that have no such name.
 */
test('`_chat.txt` is preferred over another text file in the same archive', () => {
  const archive = buildZip([
    { name: 'notes.txt', data: encoder.encode('a shopping list I left in the folder') },
    { name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) },
  ]);
  assert.equal(readChatArchive(archive).text, IOS_ENGLISH);
});

/**
 * An entry-count bomb is refused from the end-of-central-directory record.
 *
 * Ten thousand attachments cost a megabyte of archive and nothing else — none
 * is ever inflated — but a central directory is walked entry by entry, and the
 * cap is what keeps that walk bounded by something other than the 25 MB body
 * limit. Measured for #400: the refusal reads one 16-bit field, no entry.
 */
test('an archive with more entries than a chat export could have is refused before its directory is walked', () => {
  const entries = [{ name: '_chat.txt', data: encoder.encode(IOS_ENGLISH) }];
  for (let index = 0; index < MAX_ENTRIES + 1; index += 1) entries.push({ name: `IMG-${index}.jpg`, data: JPEG });
  assert.equal(reasonOf(() => readChatArchive(buildZip(entries))), 'archive_too_many_entries');
  // The boundary is real: exactly the cap still parses.
  const atCap = entries.slice(0, MAX_ENTRIES);
  assert.equal(readChatArchive(buildZip(atCap)).mediaEntries, MAX_ENTRIES - 1);
});
