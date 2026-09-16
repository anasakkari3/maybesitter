/**
 * A zip writer that is allowed to lie (UC-3.5, #189).
 *
 * `lib/services/share/chatArchive.ts` claims three things: it refuses an entry
 * whose *declared* size is too big, it refuses one whose *declared* ratio is
 * too high, and — the one that matters — it refuses one whose *real* output
 * crosses the ceiling even when both declarations said it would not.
 *
 * The third claim cannot be tested with a library that writes honest archives.
 * A zip bomb is a well-formed archive with a false central directory, so the
 * fixture builder has to be able to write one: `declaredUncompressedSize` and
 * `declaredCompressedSize` override what goes into the headers without
 * changing a byte of the data they describe.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  /** 0 = stored, 8 = deflate. Anything else is written verbatim, uncompressed. */
  readonly method?: 0 | 8;
  /** What the headers will *say* the entry expands to. Defaults to the truth. */
  readonly declaredUncompressedSize?: number;
  /** What the headers will *say* the compressed bytes measure. */
  readonly declaredCompressedSize?: number;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Every part, concatenated. Built this way because `push(...bytes)` on a
 * megabyte of stored entry overflows the call stack. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** One zip file, with whatever the entries claim about themselves. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let localBytes = 0;
  let centralBytes = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const name = encoder.encode(entry.name);
    const crc = crc32(Buffer.from(entry.data));
    const compressedSize = entry.declaredCompressedSize ?? body.byteLength;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.byteLength;
    const offset = localBytes;

    const localHeader = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(compressedSize), ...u32(uncompressedSize),
      ...u16(name.length), ...u16(0),
    ]);
    local.push(localHeader, name, body);
    localBytes += localHeader.byteLength + name.byteLength + body.byteLength;

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(compressedSize), ...u32(uncompressedSize),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]);
    central.push(centralHeader, name);
    centralBytes += centralHeader.byteLength + name.byteLength;
  }

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralBytes), ...u32(localBytes), ...u16(0),
  ]);
  return concat([...local, ...central, eocd]);
}

/** A run of one byte, which deflates at roughly a thousand to one. */
export function bomb(bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(0x41);
}

/**
 * Roughly `bytes` of text that does not compress like a bomb.
 *
 * A megabyte of one repeated character deflates at about a thousand to one,
 * which trips the ratio guard — so it cannot be used to test the *size* guard's
 * boundary without the two tests proving the same thing. This is deterministic
 * pseudo-random text at about two to one, which is what prose does.
 */
export function bulkyText(bytes: number): string {
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  let out = '';
  while (out.length < bytes) out += alphabet[next() % alphabet.length];
  return out.slice(0, bytes);
}
