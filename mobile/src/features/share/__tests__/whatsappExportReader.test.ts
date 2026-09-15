/**
 * The zip-bomb defence, on the phone (UC-3.5, #189).
 *
 * The criterion this file is the evidence for is *"an entry over 1 MB or a
 * compression ratio over 100 is refused **on the device**"* — and, beside it,
 * that media is never extracted.
 *
 * ── Why the archives are built here and not by a library ─────────
 *
 * A zip bomb is a well-formed archive whose central directory is false. Every
 * zip writer writes true ones, so the interesting fixtures cannot come from
 * one: `zip()` below takes what the headers should *claim* separately from the
 * data they describe.
 *
 * ── One test here is about fflate rather than about us ───────────
 *
 * "fflate enforces the limit per entry during extraction" would be a
 * comfortable thing to believe and is not true. Two tests below measure what
 * it really does — `unzipSync` bounds an entry at the size the *archive*
 * declared, and the streaming decoder bounds it at nothing — so the reason
 * `readWhatsAppExport` feeds the archive in chunks stays visible to whoever
 * next decides the chunking is ceremony.
 */
import { describe, expect, it } from '@jest/globals';
import { deflateSync, Unzip, UnzipInflate, unzipSync } from 'fflate';
import {
  FEED_BYTES,
  MAX_COMPRESSION_RATIO,
  MAX_ENTRY_BYTES,
  readWhatsAppExport,
} from '../whatsappExportReader';

interface Entry {
  name: string;
  data: Uint8Array;
  /** 0 stored, 8 deflate. */
  method?: 0 | 8;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
}

const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [
  value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** A zip file that says whatever it is told to say about its entries. */
function zip(entries: readonly Entry[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateSync(entry.data) : entry.data;
    const name = Array.from(encoder.encode(entry.name));
    const compressed = entry.declaredCompressedSize ?? body.length;
    const uncompressed = entry.declaredUncompressedSize ?? entry.data.length;
    const offset = local.length;
    local.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(compressed), ...u32(uncompressed),
      ...u16(name.length), ...u16(0), ...name, ...Array.from(body),
    );
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(compressed), ...u32(uncompressed),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    );
  }
  return new Uint8Array([
    ...local, ...central,
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(local.length), ...u16(0),
  ]);
}

const encoder = new TextEncoder();
const TRANSCRIPT = [
  '‎[15/09/2026, 20:46:01] Dana: bring the documents tomorrow',
  '‎[15/09/2026, 20:47:00] Sami: I will pay the bill',
].join('\n');
/** Deterministic text that deflates like prose rather than like a bomb. */
function bulky(bytes: number): string {
  let seed = 0x2f6e2b1;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
  let out = '';
  while (out.length < bytes) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[seed % alphabet.length];
  }
  return out.slice(0, bytes);
}
/** A run of one byte, which deflates at about a thousand to one. */
const bomb = (bytes: number) => new Uint8Array(bytes).fill(0x41);

describe('the ordinary export', () => {
  it('reads the transcript and counts the attachments without opening them', () => {
    const read = readWhatsAppExport(zip([
      { name: '_chat.txt', data: encoder.encode(TRANSCRIPT) },
      { name: '00000002-PHOTO-2026-09-15.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]) },
      { name: '00000003-AUDIO-2026-09-15.opus', data: new Uint8Array(64).fill(9) },
    ]));
    expect(read).toEqual({ ok: true, text: TRANSCRIPT, mediaEntries: 2 });
  });

  it('reads a stored (uncompressed) transcript', () => {
    const read = readWhatsAppExport(zip([{ name: '_chat.txt', data: encoder.encode(TRANSCRIPT), method: 0 }]));
    expect(read).toEqual({ ok: true, text: TRANSCRIPT, mediaEntries: 0 });
  });

  it('prefers _chat.txt over another text file in the same archive', () => {
    const read = readWhatsAppExport(zip([
      { name: 'notes.txt', data: encoder.encode('a shopping list left in the folder') },
      { name: '_chat.txt', data: encoder.encode(TRANSCRIPT) },
    ]));
    expect(read).toEqual({ ok: true, text: TRANSCRIPT, mediaEntries: 0 });
  });

  it('reads a transcript across many feed chunks', () => {
    const long = bulky(FEED_BYTES * 6);
    const read = readWhatsAppExport(zip([{ name: '_chat.txt', data: encoder.encode(long) }]));
    expect(read.ok).toBe(true);
    expect(read.ok && read.text).toEqual(long);
  });
});

describe('media is never extracted', () => {
  it('reads the transcript beside an attachment that could not be inflated', () => {
    const corrupt = new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01]);
    const read = readWhatsAppExport(zip([
      { name: '_chat.txt', data: encoder.encode(TRANSCRIPT) },
      // Stored bytes declared as a deflate entry: inflating them throws.
      { name: 'photo.jpg', data: corrupt, method: 0, declaredCompressedSize: corrupt.length },
    ]));
    expect(read).toEqual({ ok: true, text: TRANSCRIPT, mediaEntries: 1 });
  });

  it('reads the transcript beside an attachment that would expand into megabytes', () => {
    const read = readWhatsAppExport(zip([
      { name: '_chat.txt', data: encoder.encode(TRANSCRIPT) },
      { name: 'video.mp4', data: bomb(16 * 1024 * 1024) },
    ]));
    expect(read).toEqual({ ok: true, text: TRANSCRIPT, mediaEntries: 1 });
  });

  it('does not read the macOS resource-fork copy as a transcript', () => {
    const read = readWhatsAppExport(zip([
      { name: '__MACOSX/._chat.txt', data: new Uint8Array([0, 5, 22, 7]) },
      { name: '_chat.txt', data: encoder.encode(TRANSCRIPT) },
    ]));
    expect(read).toEqual({ ok: true, text: TRANSCRIPT, mediaEntries: 1 });
  });
});

describe('the limits, as the archive declares them', () => {
  it('refuses an entry whose header says it is over the ceiling, without inflating it', () => {
    // The data is not a valid deflate stream. A reader that inflated first
    // would answer `not_an_archive`; the declared-size check answers before it.
    const read = readWhatsAppExport(zip([{
      name: '_chat.txt',
      data: new Uint8Array([0x00, 0x11, 0x22]),
      method: 0,
      declaredCompressedSize: 3,
      declaredUncompressedSize: MAX_ENTRY_BYTES + 1,
    }]));
    expect(read).toEqual({ ok: false, problem: 'entry_too_large' });
  });

  it('refuses an entry whose header says it expands too sharply', () => {
    const read = readWhatsAppExport(zip([{
      name: '_chat.txt',
      data: new Uint8Array([0x00, 0x11, 0x22]),
      method: 0,
      declaredCompressedSize: 1024,
      declaredUncompressedSize: 1024 * (MAX_COMPRESSION_RATIO + 1),
    }]));
    expect(read).toEqual({ ok: false, problem: 'ratio_exceeded' });
  });
});

describe('the limit that cannot be lied to', () => {
  /** A bomb: both declarations inside the limits, the data expanding to 16 MB. */
  function lyingBomb(): Uint8Array {
    const payload = bomb(16 * 1024 * 1024);
    return zip([{
      name: '_chat.txt',
      data: payload,
      declaredUncompressedSize: 900 * 1024,
      declaredCompressedSize: deflateSync(payload).length,
    }]);
  }

  it('refuses an entry that lies about its size in the header', () => {
    expect(readWhatsAppExport(lyingBomb())).toEqual({ ok: false, problem: 'entry_too_large' });
  });

  /**
   * The finding, kept measurable — part one.
   *
   * `unzipSync` does bound an entry's output, but it bounds it at the size the
   * *archive declared*, which is the attacker's number: it allocates that many
   * bytes up front and stops there. An archive can therefore make it allocate
   * however much it likes, and nothing a caller passes can say otherwise —
   * there is no `maxOutputLength` anywhere in fflate.
   */
  it('fflate bounds an entry only by what the archive itself declared', () => {
    const declaredTiny = zip([{
      name: '_chat.txt', data: bomb(16 * 1024 * 1024), declaredUncompressedSize: 100,
    }]);
    expect(unzipSync(declaredTiny)['_chat.txt']!.length).toBe(100);

    // The other direction: 1 KB of real data declaring 64 MB makes it allocate
    // 64 MB before it can discover the stream was short.
    const declaredHuge = zip([{
      name: '_chat.txt', data: encoder.encode(bulky(1024)), declaredUncompressedSize: 64 * 1024 * 1024,
    }]);
    expect(unzipSync(declaredHuge)['_chat.txt']!.length).toBe(1024);
  });

  /**
   * The finding, kept measurable — part two, and the reason for `FEED_BYTES`.
   *
   * The streaming decoder this file actually uses has no bound of any kind:
   * `UnzipInflate`'s constructor takes no size argument, so it ignores the
   * declared one and grows. Pushed the whole archive at once it hands the
   * caller all sixteen megabytes in **one** `ondata` call — a byte counter in
   * that callback would be told about the allocation after it had happened.
   *
   * `readWhatsAppExport` feeds `FEED_BYTES` at a time for exactly this reason.
   * If this ever fails because fflate grew a ceiling, the chunking can go;
   * while it passes, the chunking is the enforcement.
   */
  it('fflate\u2019s streaming decoder has no ceiling at all when fed in one push', () => {
    let delivered = 0;
    let calls = 0;
    const unzip = new Unzip((file) => {
      file.ondata = (_error, chunk) => { delivered += chunk.length; calls += 1; };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.push(lyingBomb(), true);
    expect(delivered).toBe(16 * 1024 * 1024);
    expect(calls).toBe(1);
  });

  /**
   * A bomb that stays under the size ceiling is still a bomb.
   *
   * Half a megabyte of one byte deflates to a few hundred, and every number the
   * archive declares is inside the limits — under 1 MB, and a declared ratio of
   * about eighty to one. Only the measured ratio gives it away, which is why it
   * is checked separately from the size rather than folded into it.
   */
  it('refuses an entry whose real ratio is over the ceiling even though it fits under the size limit', () => {
    const payload = bomb(500 * 1024);
    // Derived rather than written down, so the fixture stays inside the
    // declared limits whichever way the deflater's output moves.
    const declaredUncompressedSize = deflateSync(payload).length * (MAX_COMPRESSION_RATIO - 1);
    expect(declaredUncompressedSize).toBeLessThan(MAX_ENTRY_BYTES);
    const read = readWhatsAppExport(zip([{ name: '_chat.txt', data: payload, declaredUncompressedSize }]));
    expect(read).toEqual({ ok: false, problem: 'ratio_exceeded' });
  });

  it('is a boundary: just under the ceiling reads, just over is refused', () => {
    const under = bulky(MAX_ENTRY_BYTES - 4096);
    const over = bulky(MAX_ENTRY_BYTES + 4096);
    expect(readWhatsAppExport(zip([{ name: '_chat.txt', data: encoder.encode(under) }])).ok).toBe(true);
    expect(readWhatsAppExport(zip([{ name: '_chat.txt', data: encoder.encode(over) }])))
      .toEqual({ ok: false, problem: 'entry_too_large' });
  });
});

describe('everything that is not a chat export', () => {
  it('refuses bytes that are not a zip', () => {
    expect(readWhatsAppExport(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))
      .toEqual({ ok: false, problem: 'not_an_archive' });
  });

  it('refuses an archive with no text file in it', () => {
    const read = readWhatsAppExport(zip([{ name: 'photo.jpg', data: new Uint8Array([0xff, 0xd8, 0xff]) }]));
    expect(read).toEqual({ ok: false, problem: 'no_transcript' });
  });

  it('refuses a transcript that is not valid UTF-8 rather than decoding it into replacement characters', () => {
    // Windows-1256 «صباح» — text in another encoding, and not UTF-8.
    const read = readWhatsAppExport(zip([{ name: '_chat.txt', data: new Uint8Array([0xd5, 0xc8, 0xc7, 0xcd]) }]));
    expect(read).toEqual({ ok: false, problem: 'not_text' });
  });
});
