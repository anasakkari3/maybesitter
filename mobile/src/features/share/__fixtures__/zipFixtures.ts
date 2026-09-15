/**
 * Zip archives that are allowed to lie (UC-3.5, #189).
 *
 * A zip bomb is a well-formed archive whose central directory is false, so the
 * interesting fixtures cannot come from a zip writer: every writer writes true
 * headers. `zip()` takes what an entry should *claim* separately from the data
 * it describes.
 *
 * It lives in `__fixtures__/` rather than in `__tests__/` because jest collects
 * `**\/__tests__/**\/*.ts` as suites, and a helper there is a file with no tests
 * in it. Two suites need these archives — the reader's own unit tests and the
 * share flow, which has to prove the reader is actually *called* — so they are
 * built in one place.
 */
import { deflateSync } from 'fflate';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** 0 stored, 8 deflate. Defaults to deflate. */
  method?: 0 | 8;
  /** What the headers will *say*, when that should differ from the truth. */
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
}

const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [
  value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

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

/**
 * One zip file, saying whatever it is told to say about its entries.
 *
 * The CRC is written as zero. Neither reader checks it — fflate's `Unzip` does
 * not, and `chatArchive.ts` does not — so a real one would be ceremony that
 * implies a check nobody performs.
 */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let localBytes = 0;
  let centralBytes = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateSync(entry.data) : entry.data;
    const name = encoder.encode(entry.name);
    const compressed = entry.declaredCompressedSize ?? body.length;
    const uncompressed = entry.declaredUncompressedSize ?? entry.data.length;
    const offset = localBytes;

    const localHeader = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(compressed), ...u32(uncompressed), ...u16(name.length), ...u16(0),
    ]);
    local.push(localHeader, name, body);
    localBytes += localHeader.byteLength + name.byteLength + body.byteLength;

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(compressed), ...u32(uncompressed), ...u16(name.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]);
    central.push(centralHeader, name);
    centralBytes += centralHeader.byteLength + name.byteLength;
  }

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centralBytes), ...u32(localBytes), ...u16(0),
  ]);
  return concat([...local, ...central, eocd]);
}

/** A run of one byte, which deflates at about a thousand to one. */
export function bomb(bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(0x41);
}

/** Deterministic text that deflates like prose rather than like a bomb. */
export function bulky(bytes: number): string {
  let seed = 0x2f6e2b1;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  let out = '';
  while (out.length < bytes) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[seed % alphabet.length];
  }
  return out.slice(0, bytes);
}

/** Two lines of a real export, for an archive that should read cleanly. */
export const TRANSCRIPT = [
  '‎[15/09/2026, 20:46:01] Dana: bring the documents tomorrow',
  '‎[15/09/2026, 20:47:00] Sami: I will pay the bill',
].join('\n');

/**
 * The archive that is the point of all of this.
 *
 * Every number it declares is inside the limits — 900 KB expanded, a plausible
 * compressed size — and both are false: the entry really expands to 16 MB.
 * Nothing but measuring the output during the inflate catches it.
 */
export function lyingBomb(): Uint8Array {
  const payload = bomb(16 * 1024 * 1024);
  return zip([{
    name: '_chat.txt',
    data: payload,
    declaredUncompressedSize: 900 * 1024,
    declaredCompressedSize: deflateSync(payload).length,
  }]);
}
