/**
 * The two metadata strippers, held to one answer (UC-3.6, #190).
 *
 * The same idea as `exportEmailDetectorCases.test.ts`, and the same reason: a
 * thing that exists twice is written down once and both copies are checked
 * against the writing. There the two copies are a detector; here they are
 * `stripImageMetadata` on the server and `stripImageMetadata` in the app, which
 * cannot import each other across the workspace boundary.
 *
 * This file does two things, and the order is the point:
 *
 *  1. asserts the **backend** stripper against properties declared here — the
 *     fixture carried metadata, the output carries none, nothing hidden in the
 *     input survives into the output, and a file with nothing to remove comes
 *     back unchanged;
 *  2. writes the inputs and the outputs to
 *     `mobile/src/features/share/__fixtures__/imageStripCases.json`, which
 *     `mobile/src/features/share/__tests__/prepareImages.test.ts` runs the
 *     **RN** stripper over byte for byte.
 *
 * A backend stripper that disagreed with the declared properties therefore
 * cannot launder its disagreement into the fixture and make the RN suite green
 * against a defect. The criterion is that no APP1/EXIF is in the upload, and
 * the upload is built by the device — so the device's copy is the one that has
 * to be right, and this is what keeps it in step with the one the server also
 * runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataSegmentsIn, stripImageMetadata } from '../../lib/services/share/imageMetadata.ts';
import { HIDDEN_ATTACK, HIDDEN_LOCATION, INJECTION_POSTER, POSTERS } from '../fixtures/share/images/posters.ts';
import type { ShareMediaType } from '../../lib/services/share/shareTypes.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'mobile', 'src', 'features', 'share', '__fixtures__',
);

interface StripCase {
  readonly name: string;
  readonly mediaType: ShareMediaType | 'image/heif' | 'text/plain';
  readonly bytes: Uint8Array;
  /** Declared, never computed: what a person says should happen to this file. */
  readonly expected: 'stripped' | 'unchanged' | 'refused';
  /**
   * Strings that are in this file's metadata and must not be in its output.
   *
   * Per case rather than one list, because `injection_en` has the attack
   * *printed on the poster* as well as hidden in its EXIF — and the printed
   * copy is meant to survive the strip. It is the model's answer that drops it,
   * which is a different guard in a different file.
   */
  readonly secrets: readonly string[];
  readonly because: string;
}

/** A JPEG with nothing to take out: three bytes of marker and a scan. */
const CLEAN_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x41, 0x42, 0x43, 0x44,
  0xff, 0xd9,
]);

/** A PNG with a payload glued on after `IEND`. */
function pngWithTrailer(): Uint8Array {
  const png = POSTERS[1]!.bytes;
  const trailer = new TextEncoder().encode(HIDDEN_ATTACK);
  const out = new Uint8Array(png.length + trailer.length);
  out.set(png, 0);
  out.set(trailer, png.length);
  return out;
}

/** What an iPhone photograph's first bytes look like. */
const HEIC_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
  0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
]);

export const STRIP_CASES: readonly StripCase[] = [
  ...[...POSTERS, INJECTION_POSTER].map((poster): StripCase => ({
    name: poster.name,
    mediaType: poster.mediaType,
    bytes: poster.bytes,
    expected: 'stripped',
    secrets: poster === INJECTION_POSTER ? [HIDDEN_LOCATION] : [HIDDEN_ATTACK, HIDDEN_LOCATION],
    because: 'a poster with EXIF, a comment and an XMP block in it',
  })),
  {
    name: 'clean_jpeg',
    mediaType: 'image/jpeg',
    bytes: CLEAN_JPEG,
    expected: 'unchanged',
    secrets: [],
    because: 'a JPEG with no APPn at all comes back byte for byte, so this is not "always shrink"',
  },
  {
    name: 'png_with_trailer',
    mediaType: 'image/png',
    bytes: pngWithTrailer(),
    expected: 'stripped',
    secrets: [HIDDEN_ATTACK, HIDDEN_LOCATION],
    because: 'a payload glued on after IEND is not part of the picture',
  },
  {
    name: 'heic_photo',
    mediaType: 'image/heic',
    bytes: HEIC_HEADER,
    expected: 'refused',
    secrets: [],
    because: 'HEIF keeps EXIF as an item located by iloc, and a rewrite nobody can test is not a promise',
  },
  {
    name: 'truncated_png',
    mediaType: 'image/png',
    bytes: POSTERS[1]!.bytes.slice(0, 40),
    expected: 'refused',
    secrets: [],
    because: 'a file that ends mid-chunk is one this cannot account for',
  },
  {
    name: 'not_an_image',
    mediaType: 'image/jpeg',
    bytes: new TextEncoder().encode('Parents evening on Thursday at seven.'),
    expected: 'refused',
    secrets: [],
    because: 'bytes that are not the container they claim are refused rather than guessed at',
  },
];

test('the backend stripper does to every case what a person said it should', () => {
  for (const shared of STRIP_CASES) {
    const result = stripImageMetadata(shared.bytes, shared.mediaType as ShareMediaType);
    if (shared.expected === 'refused') {
      assert.equal(result.ok, false, `${shared.name}: ${shared.because}`);
      continue;
    }
    assert.equal(result.ok, true, `${shared.name}: ${shared.because}`);
    if (!result.ok) continue;

    // Nothing is left that a second walk can find.
    assert.deepEqual(
      metadataSegmentsIn(result.bytes, shared.mediaType as ShareMediaType),
      [],
      `${shared.name}: a metadata segment survived`,
    );

    if (shared.expected === 'unchanged') {
      assert.equal(result.removedSegments, 0, shared.name);
      assert.deepEqual(Array.from(result.bytes), Array.from(shared.bytes), `${shared.name}: it was changed`);
      continue;
    }

    // It really did carry something, and that something really is gone.
    assert.ok(result.removedSegments > 0, `${shared.name}: nothing was removed`);
    assert.ok(result.bytes.length < shared.bytes.length, `${shared.name}: nothing got smaller`);
    const before = new TextDecoder().decode(shared.bytes);
    const after = new TextDecoder().decode(result.bytes);
    assert.ok(shared.secrets.length > 0, `${shared.name}: nothing declared to disappear`);
    for (const secret of shared.secrets) {
      assert.ok(before.includes(secret), `${shared.name}: the fixture never had "${secret}"`);
      assert.ok(!after.includes(secret), `${shared.name}: "${secret}" survived`);
    }
  }
});

test('the case list is worth running', () => {
  // A list that is all posters passes against a stripper that only reads
  // JPEG; a list with no `unchanged` case passes against one that truncates
  // every file to its header; a list with no `refused` case passes against one
  // that never fails closed.
  const by = (expected: StripCase['expected']) => STRIP_CASES.filter((shared) => shared.expected === expected).length;
  assert.ok(by('stripped') >= 5, 'too few files with something to remove');
  assert.ok(by('unchanged') >= 1, 'nothing proves a clean file is left alone');
  assert.ok(by('refused') >= 3, 'nothing proves this fails closed');
  assert.ok(new Set(STRIP_CASES.map((shared) => shared.mediaType)).size >= 3, 'one container is not a test');
  assert.equal(new Set(STRIP_CASES.map((shared) => shared.name)).size, STRIP_CASES.length, 'two cases share a name');
});

test('the cases are exported for the RN suite to run the app stripper over', () => {
  mkdirSync(FIXTURES, { recursive: true });
  const exported = STRIP_CASES.map((shared) => {
    const result = stripImageMetadata(shared.bytes, shared.mediaType as ShareMediaType);
    return {
      name: shared.name,
      mediaType: shared.mediaType,
      // Declared, never computed. See the note at the top of this file.
      expected: shared.expected,
      because: shared.because,
      input: Buffer.from(shared.bytes).toString('base64'),
      /*
       * The backend's *output*, which — unlike `expected` — is computed.
       *
       * Safe to compute because `expected` is not: the assertions above have
       * already refused to let a wrong backend reach here. The RN suite
       * compares its own output against this byte for byte, so a rule edited on
       * one side and not the other is a red run rather than two strippers that
       * quietly stopped being the same function.
       */
      output: result.ok ? Buffer.from(result.bytes).toString('base64') : null,
      removedSegments: result.ok ? result.removedSegments : 0,
      removedBytes: result.ok ? result.removedBytes : 0,
    };
  });
  writeFileSync(join(FIXTURES, 'imageStripCases.json'), `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
  assert.equal(exported.length, STRIP_CASES.length);
});
