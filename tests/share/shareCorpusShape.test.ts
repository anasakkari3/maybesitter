/**
 * The corpus is the right shape and the right size (#193 step 5, AC 1).
 *
 * The thresholds — ≥ 90 attacks, ≥ 30 per language, ≥ 8 per channel across all
 * eight, ≥ 45 benign — are asserted against the committed
 * `evaluation-data/share-injection-suite.jsonl` rather than against the builder
 * that wrote it, so a corpus that was hand-edited down is a red suite. The
 * builder is then asserted to still produce exactly that file, so the two
 * cannot drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACK_FAMILIES,
  buildShareFixture,
  CORPUS_CHANNELS,
  COLLISION_BENIGN,
  CORPUS_LANGUAGES,
  corpusJsonl,
} from '../../scripts/fixtures/build-share-injection-fixtures.ts';
import { committedCorpus, corpusText } from './shareInjectionCorpus.ts';

const CORPUS = committedCorpus();
/**
 * `collision` is a benign kind, not an attack.
 *
 * It is separate from `benign` only so a reader can see which cases exist
 * because review found a false positive; both halves must produce proposals
 * and neither may trip the guard.
 */
const HARMLESS: readonly string[] = ['benign', 'collision'];
const attacks = CORPUS.filter((entry) => !HARMLESS.includes(entry.attack));
const benign = CORPUS.filter((entry) => HARMLESS.includes(entry.attack));
const collision = CORPUS.filter((entry) => entry.attack === 'collision');

test('the committed corpus is what the builder produces', () => {
  assert.equal(corpusText(), corpusJsonl());
});

test('at least ninety attacks, thirty per language', () => {
  assert.ok(attacks.length >= 90, `${attacks.length} attacks`);
  for (const lang of CORPUS_LANGUAGES) {
    const count = attacks.filter((entry) => entry.lang === lang).length;
    assert.ok(count >= 30, `${lang}: ${count} attacks`);
  }
});

test('at least eight attacks on each of the eight channels', () => {
  assert.equal(CORPUS_CHANNELS.length, 8);
  for (const channel of CORPUS_CHANNELS) {
    const count = attacks.filter((entry) => entry.channel === channel).length;
    assert.ok(count >= 8, `${channel}: ${count} attacks`);
  }
});

test('at least forty-five benign cases, fifteen per language', () => {
  assert.ok(benign.length >= 45, `${benign.length} benign`);
  for (const lang of CORPUS_LANGUAGES) {
    const count = benign.filter((entry) => entry.lang === lang).length;
    assert.ok(count >= 15, `${lang}: ${count} benign`);
  }
});

test('the collision zone review found is in the corpus', () => {
  // Review's finding: the first draft of the three new families produced 33
  // new false positives on 34 realistic lines, and the 48 benign cases missed
  // every one because they were written from the same imagination as the
  // attacks. Each collision line must appear in the corpus at least once.
  const carried = new Set(collision.flatMap((entry) => entry.payload.visible));
  const missing = COLLISION_BENIGN.filter((entry) => !carried.has(entry.line));
  assert.deepEqual(missing.map((entry) => entry.line), []);
  assert.ok(collision.length >= 24, `${collision.length} collision cases`);
  for (const lang of CORPUS_LANGUAGES) {
    assert.ok(COLLISION_BENIGN.some((entry) => entry.lang === lang), lang);
  }
});

test('every attack family #193 names is exercised', () => {
  for (const family of ATTACK_FAMILIES) {
    const count = attacks.filter((entry) => entry.attack === family).length;
    assert.ok(count > 0, `no case for ${family}`);
  }
});

test('every case has a unique id, a declared fixture and a complete expectation', () => {
  const ids = new Set<string>();
  for (const entry of CORPUS) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(CORPUS_LANGUAGES.includes(entry.lang), entry.id);
    assert.ok(CORPUS_CHANNELS.includes(entry.channel), entry.id);
    assert.match(entry.fixture, /^tests\/fixtures\/share-injection\//, entry.id);
    assert.ok(entry.expected.mustNotCall.length >= 4, entry.id);
    assert.ok(entry.expected.forbiddenTitleSubstrings.length > 0, entry.id);
    assert.equal(typeof entry.expected.mayReject, 'boolean');
    // A benign case that may return nothing is a benign case that cannot fail
    // a reject-everything guard, which is the whole reason the benign half
    // exists.
    if (HARMLESS.includes(entry.attack)) {
      assert.equal(entry.expected.mayReject, false, entry.id);
      assert.ok(entry.expected.minItems >= 1, entry.id);
    }
  }
});

test('the builder really produces every declared fixture', () => {
  for (const entry of CORPUS) {
    const fixture = buildShareFixture(entry);
    assert.ok(fixture.artifact.byteLength > 0, entry.id);
    // Deterministic: the same case twice is the same bytes, so `--out` and the
    // CI suite cannot be reading two different corpora.
    assert.deepEqual(Array.from(buildShareFixture(entry).artifact), Array.from(fixture.artifact), entry.id);
  }
});

test('no fixture carries anything that could be a real person', () => {
  /*
   * #193's last acceptance criterion, as an assertion rather than as a review
   * note. Every address is in the reserved `.test` TLD, and no case carries a
   * phone number, an IBAN or an email at a registrable domain.
   */
  for (const entry of CORPUS) {
    const text = new TextDecoder().decode(buildShareFixture(entry).artifact);
    const addresses = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    for (const address of addresses) {
      assert.match(address, /\.test$/, `${entry.id}: ${address}`);
    }
    const hosts = text.match(/https?:\/\/[^\s/]+|webcal:\/\/[^\s/]+/g) ?? [];
    for (const host of hosts) assert.match(host, /\.test$/, `${entry.id}: ${host}`);
    assert.ok(!/\+\d{7,}/.test(text), `${entry.id} carries something shaped like a phone number`);
  }
});
