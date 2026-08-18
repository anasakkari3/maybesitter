/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Acceptance criterion for issue #11: "Arabic and Hebrew logical text is
 * preserved."
 *
 * Asserted concretely rather than by eyeballing: every string in the corpus
 * must survive JSON.stringify/parse and a UTF-8 file write/read
 * byte-identically, in the same code-point order, with no bidi control
 * characters anywhere. The interesting strings are the bidirectional ones —
 * an RTL run with Latin words or digits embedded — because a pure Arabic or
 * pure Hebrew string round-trips trivially, while a mixed-direction one is
 * where reordering and control-character damage actually appear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIFE_STATE_MEMORY_FIXTURES,
  corpusStrings,
  fixtureFor,
} from './lifeStateMemoryFixtures.ts';

/** LRM, RLM, ALM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI. */
const BIDI_CONTROL_CHARACTERS = /[‎‏؜‪-‮⁦-⁩]/;
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const HEBREW_SCRIPT = /[֐-׿יִ-ﭏ]/;
const LATIN_SCRIPT = /[A-Za-z]/;
const ASCII_DIGIT = /[0-9]/;

const ALL_STRINGS = corpusStrings();

/** Code points, not UTF-16 units, so surrogate damage shows up as a difference. */
function codePoints(value: string): number[] {
  return Array.from(value, (character) => character.codePointAt(0) ?? -1);
}

test('bidi: the corpus carries text worth round-tripping', () => {
  assert.ok(ALL_STRINGS.length >= 40, `expected a substantial corpus, got ${ALL_STRINGS.length} strings`);
  const bidirectional = ALL_STRINGS.filter(
    (s) => (ARABIC_SCRIPT.test(s) || HEBREW_SCRIPT.test(s)) && (LATIN_SCRIPT.test(s) || ASCII_DIGIT.test(s)),
  );
  assert.ok(
    bidirectional.length >= 20,
    `expected many bidirectional strings, got ${bidirectional.length}; simple RTL strings do not exercise the hard case`,
  );
});

test('bidi: no fixture string contains a bidi control character', () => {
  for (const value of ALL_STRINGS) {
    assert.equal(
      BIDI_CONTROL_CHARACTERS.test(value),
      false,
      `"${value}" contains a bidi control character; fixture text must be stored in logical order`,
    );
  }
});

test('bidi: every fixture string is NFC-normalized', () => {
  // Without this, a write/read cycle through a normalizing layer would change
  // bytes while comparing equal as strings.
  for (const value of ALL_STRINGS) {
    assert.equal(value.normalize('NFC'), value, `"${value}" is not NFC-normalized`);
  }
});

test('bidi: strings survive JSON.stringify/parse with identical code points', () => {
  for (const value of ALL_STRINGS) {
    const roundTripped = JSON.parse(JSON.stringify(value)) as string;
    assert.equal(roundTripped, value);
    assert.deepEqual(Array.from(roundTripped), Array.from(value), 'code point order must be preserved exactly');
    assert.deepEqual(codePoints(roundTripped), codePoints(value));
  }
});

test('bidi: the whole corpus survives a UTF-8 file write/read byte-identically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-lifestate-fixtures-'));
  try {
    const file = join(dir, 'corpus.json');
    const payload = JSON.stringify(LIFE_STATE_MEMORY_FIXTURES, null, 2);
    writeFileSync(file, payload, 'utf8');

    const bytes = readFileSync(file);
    assert.ok(
      bytes.equals(Buffer.from(payload, 'utf8')),
      'the file on disk must be byte-identical to the serialized corpus',
    );

    const parsed = JSON.parse(bytes.toString('utf8')) as typeof LIFE_STATE_MEMORY_FIXTURES;
    assert.equal(JSON.stringify(parsed), JSON.stringify(LIFE_STATE_MEMORY_FIXTURES));

    LIFE_STATE_MEMORY_FIXTURES.forEach((fixture, index) => {
      fixture.memory.records.forEach((record, recordIndex) => {
        const readBack = parsed[index].memory.records[recordIndex].input.content;
        assert.deepEqual(
          codePoints(readBack),
          codePoints(record.input.content),
          `${fixture.id} record ${record.handle} changed code points across a file round trip`,
        );
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bidi: embedded Latin keeps its position inside an RTL run across a round trip', () => {
  // A concrete no-reordering check: the Latin clinic name sits in the middle of
  // an Arabic sentence, and must still sit at the same code-point offset after
  // serialization and a file round trip.
  const arabic = fixtureFor('ar', 'sensitive');
  assert.ok(arabic);
  const clinical = arabic.memory.records.find((r) => r.handle === 'clinical');
  assert.ok(clinical);

  const original = clinical.input.content;
  const latinIndex = original.indexOf('Clalit');
  assert.ok(latinIndex > 0, 'the Latin run must be embedded, not leading');
  assert.ok(ARABIC_SCRIPT.test(original.slice(0, latinIndex)), 'Arabic text must precede the Latin run');
  assert.ok(ASCII_DIGIT.test(original), 'the string must also carry digits, the other hard bidi case');

  const dir = mkdtempSync(join(tmpdir(), 'ms-lifestate-bidi-'));
  try {
    const file = join(dir, 'one-string.json');
    writeFileSync(file, JSON.stringify({ content: original }), 'utf8');
    const readBack = (JSON.parse(readFileSync(file, 'utf8')) as { content: string }).content;

    assert.equal(readBack, original);
    assert.equal(readBack.indexOf('Clalit'), latinIndex, 'the embedded Latin run moved');
    assert.deepEqual(codePoints(readBack), codePoints(original));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bidi: each language fixture carries script-appropriate text', () => {
  for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
    for (const record of fixture.memory.records) {
      const content = record.input.content;
      const where = `${fixture.id}/${record.handle}`;
      switch (fixture.language) {
        case 'ar':
          assert.ok(ARABIC_SCRIPT.test(content), `${where} must contain Arabic script`);
          assert.equal(HEBREW_SCRIPT.test(content), false, `${where} must not contain Hebrew script`);
          break;
        case 'he':
          assert.ok(HEBREW_SCRIPT.test(content), `${where} must contain Hebrew script`);
          assert.equal(ARABIC_SCRIPT.test(content), false, `${where} must not contain Arabic script`);
          break;
        case 'en':
          assert.equal(ARABIC_SCRIPT.test(content), false, `${where} must not contain Arabic script`);
          assert.equal(HEBREW_SCRIPT.test(content), false, `${where} must not contain Hebrew script`);
          assert.ok(LATIN_SCRIPT.test(content), `${where} must contain Latin script`);
          break;
        case 'mixed':
          assert.ok(
            ARABIC_SCRIPT.test(content) || HEBREW_SCRIPT.test(content),
            `${where} must contain an RTL script`,
          );
          assert.ok(LATIN_SCRIPT.test(content), `${where} must contain Latin script`);
          break;
      }
    }
  }
});

test('bidi: Arabic-Indic digits round-trip as themselves', () => {
  // Arabic-Indic digits are a separate hazard from ASCII digits: a naive
  // normalization pass folds them to 0-9 and silently changes the content.
  const arabic = fixtureFor('ar', 'sensitive');
  assert.ok(arabic);
  const medication = arabic.memory.records.find((r) => r.handle === 'medication');
  assert.ok(medication);

  const content = medication.input.content;
  assert.match(content, /[٠-٩]/, 'the Arabic medication fixture must carry an Arabic-Indic digit');
  const roundTripped = JSON.parse(JSON.stringify(content)) as string;
  assert.equal(roundTripped, content);
  assert.deepEqual(codePoints(roundTripped), codePoints(content));
});
