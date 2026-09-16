/**
 * Taking the photographer out of the photograph, before it leaves the phone
 * (UC-3.6, #190).
 *
 * ── The criterion is about the upload, so this has to be here ────
 *
 * #190 asks that there be no APP1/EXIF **in the upload**. That is a claim about
 * the bytes on the wire, and the only place it can be made true is the device.
 * The server strips again — `lib/services/share/imageMetadata.ts` — but a
 * server-side strip happens after the coordinates have already crossed the
 * network, which is precisely the thing the criterion forbids.
 *
 * What is in a photo off a phone: the GPS coordinates it was taken at, the
 * camera's serial number, the original timestamp, the owner's name on some
 * bodies, and — after any edit — an XMP block with the editing history and any
 * caption. A screenshot annotated in an editor carries that editor's own block.
 * None of it is the poster on the wall.
 *
 * ── Two implementations, one set of answers ──────────────────────
 *
 * This file and `lib/services/share/imageMetadata.ts` are the same algorithm on
 * two sides of a workspace boundary that cannot import across itself — the same
 * situation `emailTextDetector.ts` is in. So they are held to one written-down
 * set of answers: `tests/share/exportImageStripCases.test.ts` asserts the
 * backend stripper against declared properties and then writes the inputs and
 * outputs to `__fixtures__/imageStripCases.json`, and
 * `__tests__/prepareImages.test.ts` runs *this* over them byte for byte. A
 * change on one side and not the other is a red run rather than a silent
 * divergence.
 *
 * ── Removal, not redaction ───────────────────────────────────────
 *
 * Every rule is "keep the small closed list that carries pixels, drop
 * everything else", never "drop the metadata I have heard of". An allowlist
 * fails safe against the container extension nobody here has read about; a
 * blocklist fails open, silently, on exactly the file that carried something
 * new.
 *
 * ── HEIF is refused rather than half-stripped ────────────────────
 *
 * An iPhone photo is usually HEIF, and HEIF keeps its EXIF as an *item* whose
 * payload lives in `mdat` and whose position is recorded in `iloc` — so
 * removing it means rewriting every offset in the file, and getting that wrong
 * produces a file that still decodes and still carries the coordinates. There
 * is no honest way to land that without a real-device fixture to hold it to, so
 * a HEIF share is refused on the phone and the user is told the file cannot be
 * read. That is a real gap and it is written here rather than hidden: refusing
 * is a missing feature, and a rewrite nobody can test is a privacy claim that
 * is not true.
 *
 * ── The bytes do enter JavaScript here, and only here ────────────
 *
 * `ShareProvider.tsx` says the bytes never reach the JS heap, because
 * `apiUpload` hands React Native a `{ uri, name, type }` descriptor and the
 * platform streams the file. That stays true of the *upload*. It cannot stay
 * true of a rewrite: there is no way to remove a segment from a file without
 * reading it. So one image at a time is read, rewritten and dropped, the
 * stripped copy goes into the cache directory beside the copy the OS already
 * made, and `ShareProvider` deletes both on every exit from the flow.
 */
import type { SharedFile, SharePayloadProblem } from './intake';

/* ══ The pure half ═══════════════════════════════════════════════ */

export type ImageStripResult =
  | {
    readonly ok: true;
    readonly bytes: Uint8Array;
    readonly removedSegments: number;
    readonly removedBytes: number;
  }
  | { readonly ok: false; readonly reason: 'unreadable_container' | 'container_not_strippable' };

const FAILED: ImageStripResult = { ok: false, reason: 'unreadable_container' };

function tag(bytes: Uint8Array, offset: number): string {
  if (bytes.length < offset + 4) return '';
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + bytes[offset + 3]! * 0x1000000
  );
}

function concat(pieces: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/** `APP0`–`APP15` and `COM`. */
function isJpegMetadata(code: number): boolean {
  return (code >= 0xe0 && code <= 0xef) || code === 0xfe;
}

/**
 * Every `APPn` and every comment, gone.
 *
 * `APP1` is EXIF and XMP and is the one the criterion names, but the rule is
 * the whole class: `APP0`'s JFXX extension carries a thumbnail of the picture,
 * `APP2` an ICC profile some phones stamp with a device name, `APP13`
 * Photoshop's block — which is where a caption and a photographer's name live.
 * Everything from `SOS` on is copied byte for byte: that is the picture.
 */
function stripJpeg(bytes: Uint8Array): ImageStripResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return FAILED;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let removedSegments = 0;
  let removedBytes = 0;
  let at = 2;
  let sawScan = false;

  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return FAILED;
    let marker = at + 1;
    while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
    if (marker >= bytes.length) return FAILED;
    const code = bytes[marker]!;

    if (code === 0xda || code === 0xd9) {
      kept.push(bytes.subarray(at));
      sawScan = true;
      at = bytes.length;
      break;
    }
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      kept.push(bytes.subarray(at, marker + 1));
      at = marker + 1;
      continue;
    }
    if (marker + 2 >= bytes.length) return FAILED;
    const length = (bytes[marker + 1]! << 8) | bytes[marker + 2]!;
    if (length < 2) return FAILED;
    const end = marker + 1 + length;
    if (end > bytes.length) return FAILED;

    if (isJpegMetadata(code)) {
      removedSegments += 1;
      removedBytes += end - at;
    } else {
      kept.push(bytes.subarray(at, end));
    }
    at = end;
  }

  if (!sawScan) return FAILED;
  return { ok: true, bytes: concat(kept), removedSegments, removedBytes };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The chunks that are the picture: `IHDR`, `PLTE`, `IDAT`, `IEND` and `tRNS`.
 *
 * Everything else — `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`, `iCCP`, and
 * whatever a future editor invents — goes without being named, which is the
 * point of writing the keep list rather than the drop list.
 */
const PNG_PICTURE_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);

function stripPng(bytes: Uint8Array): ImageStripResult {
  if (bytes.length < 8) return FAILED;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return FAILED;
  }
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let removedSegments = 0;
  let removedBytes = 0;
  let at = 8;
  let sawEnd = false;

  while (at + 8 <= bytes.length) {
    const length = readUint32(bytes, at);
    const type = tag(bytes, at + 4);
    if (length > 0x7fffffff) return FAILED;
    const end = at + 12 + length;
    if (end > bytes.length) return FAILED;
    if (PNG_PICTURE_CHUNKS.has(type)) kept.push(bytes.subarray(at, end));
    else {
      removedSegments += 1;
      removedBytes += end - at;
    }
    at = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return FAILED;
  // A payload appended past the end of a picture is the oldest trick there is.
  if (at < bytes.length) {
    removedSegments += 1;
    removedBytes += bytes.length - at;
  }
  return { ok: true, bytes: concat(kept), removedSegments, removedBytes };
}

/** The RIFF chunks that carry pixels rather than facts about the photographer. */
const WEBP_PICTURE_CHUNKS: ReadonlySet<string> = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

/** ICC, EXIF and XMP, as announced in the `VP8X` header. */
const VP8X_METADATA_FLAGS = 0x20 | 0x08 | 0x04;

function stripWebp(bytes: Uint8Array): ImageStripResult {
  if (bytes.length < 12) return FAILED;
  if (tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') return FAILED;
  const declared = readUint32LE(bytes, 4);
  const end = Math.min(bytes.length, 8 + declared);
  if (end < 12) return FAILED;

  const kept: Uint8Array[] = [];
  let removedSegments = 0;
  let removedBytes = 0;
  let at = 12;

  while (at + 8 <= end) {
    const type = tag(bytes, at);
    const size = readUint32LE(bytes, at + 4);
    const chunkEnd = at + 8 + size + (size % 2);
    if (chunkEnd > end) return FAILED;
    if (WEBP_PICTURE_CHUNKS.has(type)) {
      // `slice`, not `subarray`: the flags byte is edited, and editing the
      // caller's buffer would corrupt the copy the caller still holds.
      const chunk = bytes.slice(at, chunkEnd);
      if (type === 'VP8X' && size >= 1) chunk[8] = chunk[8]! & ~VP8X_METADATA_FLAGS;
      kept.push(chunk);
    } else {
      removedSegments += 1;
      removedBytes += chunkEnd - at;
    }
    at = chunkEnd;
  }
  if (at < bytes.length) {
    removedSegments += 1;
    removedBytes += bytes.length - at;
  }

  const body = concat(kept);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  const size = 4 + body.length;
  out[4] = size & 0xff;
  out[5] = (size >> 8) & 0xff;
  out[6] = (size >> 16) & 0xff;
  out[7] = (size >>> 24) & 0xff;
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set(body, 12);
  return { ok: true, bytes: out, removedSegments, removedBytes };
}

/** The same picture with nothing about the photographer in it. */
export function stripImageMetadata(bytes: Uint8Array, mimeType: string): ImageStripResult {
  switch (mimeType) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    case 'image/heic':
    case 'image/heif':
      return { ok: false, reason: 'container_not_strippable' };
    default:
      return FAILED;
  }
}

/**
 * The names of the metadata segments still in a file. Empty is the goal.
 *
 * A second walk over the *output*, used below as the check on this module's own
 * work. "It removed everything" and "nothing is left" are two statements, and
 * only the second one is the criterion — so the second one is what is checked,
 * on every image, on the path a real share takes and not only in a test.
 */
export function metadataSegmentsIn(bytes: Uint8Array, mimeType: string): readonly string[] {
  const found: string[] = [];
  if (mimeType === 'image/jpeg') {
    let at = 2;
    while (at + 1 < bytes.length && bytes[at] === 0xff) {
      let marker = at + 1;
      while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
      const code = bytes[marker];
      if (code === undefined || code === 0xda || code === 0xd9) break;
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
        at = marker + 1;
        continue;
      }
      if (marker + 2 >= bytes.length) break;
      const length = (bytes[marker + 1]! << 8) | bytes[marker + 2]!;
      if (length < 2) break;
      if (isJpegMetadata(code)) found.push(code === 0xfe ? 'COM' : `APP${code - 0xe0}`);
      at = marker + 1 + length;
    }
    return found;
  }
  if (mimeType === 'image/png') {
    let at = 8;
    while (at + 8 <= bytes.length) {
      const length = readUint32(bytes, at);
      const type = tag(bytes, at + 4);
      if (length > 0x7fffffff || at + 12 + length > bytes.length) break;
      if (!PNG_PICTURE_CHUNKS.has(type)) found.push(type);
      at += 12 + length;
      if (type === 'IEND') break;
    }
    if (at < bytes.length) found.push('trailing');
    return found;
  }
  if (mimeType === 'image/webp') {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const type = tag(bytes, at);
      const size = readUint32LE(bytes, at + 4);
      const chunkEnd = at + 8 + size + (size % 2);
      if (chunkEnd > bytes.length) break;
      if (!WEBP_PICTURE_CHUNKS.has(type)) found.push(type.trim());
      else if (type === 'VP8X' && size >= 1 && (bytes[at + 8]! & VP8X_METADATA_FLAGS) !== 0) {
        found.push('VP8X-flags');
      }
      at = chunkEnd;
    }
    return found;
  }
  // Saying "none" about a container this cannot read would be the worst answer
  // available.
  return ['unparsed_container'];
}

/* ══ The half that touches the disk ══════════════════════════════ */

/**
 * Reading and writing, as a port.
 *
 * `eslint.config.js` forbids importing `expo-file-system*` from
 * `src/features/**`, and rightly: the rule is "no local database or file cache
 * of user content". This module does the filesystem's work through an injected
 * port instead, so the algorithm above stays a pure function a test can run
 * over real bytes with no native module present, and the one implementation
 * that does touch the disk lives in `src/lib/shareImages.ts` — outside the
 * glob, with its own argument in its own header, exactly as
 * `src/lib/shareFiles.ts` does.
 */
export interface ImageBytesPort {
  /** Every byte of a file the OS copied out for us. */
  read(uri: string): Uint8Array;
  /** Writes a stripped copy somewhere temporary and returns its uri. */
  write(bytes: Uint8Array, extension: string): string;
}

export interface PreparedImages {
  /** The files to upload: the same descriptors, pointing at the stripped copies. */
  readonly files: readonly SharedFile[];
  /** The copies this made, for the caller's `finally` to delete. */
  readonly created: readonly string[];
  /** How many metadata segments went, across every picture. A count, never a name. */
  readonly removedSegments: number;
  readonly removedBytes: number;
}

export type PrepareImagesResult =
  | { readonly ok: true; readonly prepared: PreparedImages }
  | { readonly ok: false; readonly problem: SharePayloadProblem; readonly created: readonly string[] };

const EXTENSION_FOR: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Every picture in a share, rewritten without its metadata.
 *
 * Fails the whole share rather than dropping one picture. A user who shared
 * five photographs and got four commitments would have no way to tell which
 * one was left out or why, and "we could not read one of these" is a sentence
 * worth showing rather than a silence.
 *
 * `created` comes back on both paths, because a failure on the fourth picture
 * still leaves three stripped copies on disk and the caller has to delete them.
 */
export function prepareImages(
  files: readonly SharedFile[],
  port: ImageBytesPort,
): PrepareImagesResult {
  const prepared: SharedFile[] = [];
  const created: string[] = [];
  let removedSegments = 0;
  let removedBytes = 0;

  for (const file of files) {
    const extension = EXTENSION_FOR[file.mimeType];
    if (extension === undefined) return { ok: false, problem: 'unsupported', created };

    let bytes: Uint8Array;
    try {
      bytes = port.read(file.uri);
    } catch {
      // A uri the platform will not resolve, or a file already gone. Never
      // logged: a path is the user's own file name.
      return { ok: false, problem: 'unsupported', created };
    }

    const stripped = stripImageMetadata(bytes, file.mimeType);
    // Fail closed. A container this could not account for byte by byte is one
    // whose EXIF it cannot promise it removed, and uploading it anyway would
    // make the criterion a hope.
    if (!stripped.ok || metadataSegmentsIn(stripped.bytes, file.mimeType).length > 0) {
      return { ok: false, problem: 'unsupported', created };
    }

    let uri: string;
    try {
      uri = port.write(stripped.bytes, extension);
    } catch {
      return { ok: false, problem: 'unsupported', created };
    }
    created.push(uri);
    removedSegments += stripped.removedSegments;
    removedBytes += stripped.removedBytes;
    prepared.push({
      ...file,
      uri,
      // The size the server will actually receive, so a preview and a limit
      // are both talking about the bytes that exist.
      sizeBytes: stripped.bytes.byteLength,
    });
  }

  return { ok: true, prepared: { files: prepared, created, removedSegments, removedBytes } };
}
