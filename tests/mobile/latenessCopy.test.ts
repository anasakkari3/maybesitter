/**
 * Lateness is a ranking signal. "Overdue" is a word the user never reads (#383).
 *
 * ── Three surfaces, three stories ────────────────────────────────
 *
 * A device run against staging had all three on screen at once:
 *
 *   onboarding  — "There is no \"overdue\". Only active, done, moved, or
 *                  dropped on purpose."
 *   Next Step   — "Based on overdue and importance: high."
 *   Today and Upcoming — that commitment does not exist.
 *
 * The third is `listBoundaryRule.test.ts`. This file is the second. The owner's
 * decision (2026-09-15) is that the ranking keeps using lateness — it is real
 * signal, and making the recommender blind to it would be a worse product —
 * while the *word* stops shipping. So `latenessBand` and the `overdue` evidence
 * code are untouched internals, and every string the code turns into is checked
 * here instead.
 *
 * ── Why a scan and not a golden string ───────────────────────────
 *
 * The thing that regresses is nobody adding "overdue" back to
 * `nextStepEvidence.ts`; it is somebody adding a *new* label, or a new locale
 * key, that happens to use the word. A test pinned to today's strings would
 * pass through that. So this walks every label the server can produce and every
 * string the three locale bundles can render — **nested ones included**, since
 * `days` and `daysShort` are arrays and `_meta` is an object — and fails on
 * both the Latin word and the language's own word for it.
 *
 * An earlier version of this file was porous three ways, and each hole is now
 * a test: it kept only top-level strings, so a nested `{"badge": "…"}` or a new
 * element in `days` went unscanned; it checked the native word on two
 * hand-picked keys, so a brand-new `todayBadgeLate` saying «متأخر» passed; and
 * it matched `overdue` but not `over-due`.
 *
 * Permitted occurrences are named one by one in `EXEMPT`, each with its reason,
 * and each is asserted to still contain the word — so an exemption that has
 * gone stale fails rather than silently widening the hole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEXT_STEP_EVIDENCE_CODES,
  evidenceLabel,
  evidenceLabels,
} from '../../lib/services/nextStepEvidence.ts';
import { scoreBaselineCandidate, selectBaselineNextStep } from '../../lib/services/nextStepBaseline.ts';
import type { BaselineCandidate } from '../../lib/services/nextStepBaseline.ts';

/**
 * Case-insensitive, and hyphen-tolerant, because "over-due" is the same word
 * to a reader and a different string to a scan.
 */
const FORBIDDEN = /over[\s-]?due/i;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const localesDir = join(repoRoot, 'mobile/src/i18n/locales');
const LOCALES = ['en', 'ar', 'he'] as const;

/**
 * The one key entitled to the word, because saying it is the promise.
 * `mobile/src/i18n/locales/en.json` — "There is no "overdue"."
 */
const PROMISE_KEY = 'obWelcomeCard2';

/**
 * How each language says the word.
 *
 * Checked bundle-wide, not on a hand-picked pair of keys: an Arabic screen
 * reading «متأخر» about a commitment breaks the same promise an English one
 * reading "overdue" breaks, and scanning only `evidenceOverdue` and
 * `todayWhyOverdue` would pass a brand-new `todayBadgeLate` straight through.
 */
const WORD: Record<(typeof LOCALES)[number], string> = {
  en: 'overdue',
  ar: 'متأخر',
  he: 'באיחור',
};

/**
 * The keys entitled to their language's word, each for a stated reason.
 *
 * Named one by one so a new use has to be argued for in a diff rather than
 * pattern-matched in. `obWelcomeCard2` is the promise itself, which quotes the
 * word in order to deny it. `obRoutineSleepLate` — «متأخر — بعد نص الليل» — is
 * a bedtime: «متأخر» is also the ordinary Arabic word for "late", and saying it
 * about a sleep window is not a verdict on a commitment.
 */
const EXEMPT: Record<(typeof LOCALES)[number], string[]> = {
  en: ['obWelcomeCard2'],
  ar: ['obWelcomeCard2', 'obRoutineSleepLate'],
  he: ['obWelcomeCard2'],
};

/** The keys that render lateness to the user, on Next Step and on Today. */
const LATENESS_KEYS = ['evidenceOverdue', 'todayWhyOverdue'];

/**
 * Every string in a bundle, nested ones included, keyed by its path.
 *
 * Keeping only the top-level strings — which this did — is how a scan looks
 * thorough and is not: `days` and `daysShort` are arrays, `_meta` is an object,
 * and a future `{"badge": "…"}` would be a third. None of them were ever
 * looked at, so the word could re-enter through any of them and the guard
 * would stay green.
 */
function strings(locale: string): Record<string, string> {
  const bundle = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8')) as unknown;
  const out: Record<string, string> = {};
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') { out[path] = value; return; }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(bundle, '');
  return out;
}

/** A commitment whose stated time has gone by, which is what `latenessBand` is. */
function lateCandidate(): BaselineCandidate {
  return {
    commitmentId: 'c-late',
    title: 'Submit report',
    confirmed: true,
    status: 'active',
    // An hour behind whatever clock the test hands `scoreBaselineCandidate`.
    dueAt: new Date(NOW.getTime() - 60 * 60 * 1_000).toISOString(),
    remindAt: null,
    importance: 'high',
    importanceIsStated: true,
    explicitEffortMinutes: null,
  };
}

/** The test's own clock. Nothing here reads the real one (#382). */
const NOW = new Date('2026-09-13T09:00:00.000Z');

test('no evidence label the server can produce says "overdue"', () => {
  for (const code of NEXT_STEP_EVIDENCE_CODES) {
    const label = evidenceLabel({ code, params: { level: 'high', minutes: 30 } });
    assert.ok(label.trim() !== '', `${code} has no label at all`);
    assert.ok(!FORBIDDEN.test(label), `the label for "${code}" says "overdue": ${label}`);
  }
});

test('the Next Step summary about a late commitment does not say "overdue"', () => {
  const selection = selectBaselineNextStep([lateCandidate()], NOW, 'en', 'p-1');
  const summary = selection.recommendation.explanation?.summary ?? '';
  assert.ok(summary !== '', 'the late commitment produced no summary to check');
  assert.ok(!FORBIDDEN.test(summary), `the Next Step card reads: ${summary}`);
  for (const label of selection.recommendation.explanation?.evidenceLabels ?? []) {
    assert.ok(!FORBIDDEN.test(label), `an evidence label reads: ${label}`);
  }
});

test('lateness still decides the order — the signal is kept, only the word is dropped', () => {
  // The owner's decision is explicit that the recommender must not get dumber.
  // A late commitment still outranks a merely-important one, and still carries
  // the evidence that says why.
  const late = scoreBaselineCandidate(lateCandidate(), NOW);
  assert.equal(late.latenessBand, 1, 'lateness stopped being a ranking signal');
  assert.deepEqual(late.evidenceCodes.map((item) => item.code), ['overdue', 'importance']);
  assert.deepEqual(late.evidenceLabels, evidenceLabels(late.evidenceCodes));

  const onTime = scoreBaselineCandidate(
    { ...lateCandidate(), commitmentId: 'c-soon', dueAt: new Date(NOW.getTime() + 60 * 60 * 1_000).toISOString() },
    NOW,
  );
  const chosen = selectBaselineNextStep(
    [lateCandidate(), { ...lateCandidate(), commitmentId: onTime.commitmentId, dueAt: new Date(NOW.getTime() + 60 * 60 * 1_000).toISOString() }],
    NOW,
    'en',
    'p-2',
  );
  assert.equal(chosen.selectedCommitmentId, 'c-late', 'the late commitment stopped being chosen first');
});

for (const locale of LOCALES) {
  test(`${locale}: no string the app can render says "overdue", except the keys entitled to`, () => {
    const bundle = strings(locale);
    const word = WORD[locale];
    assert.ok(
      (bundle[PROMISE_KEY] ?? '').includes(word),
      `${PROMISE_KEY} no longer carries the promise this test exempts — the exemption is stale, not the copy`,
    );
    for (const key of EXEMPT[locale]) {
      assert.ok(
        (bundle[key] ?? '').includes(word),
        `${locale}.json ${key} is exempted from this scan but no longer contains "${word}" — drop the exemption`,
      );
    }
    for (const [key, value] of Object.entries(bundle)) {
      if (EXEMPT[locale].includes(key)) continue;
      // Both spellings, over every string in the bundle: the Latin word in any
      // language's copy, and this language's own word for it.
      assert.ok(!FORBIDDEN.test(value), `${locale}.json ${key} says "overdue": ${value}`);
      assert.ok(!value.includes(word), `${locale}.json ${key} says "${word}": ${value}`);
    }
  });

  test(`${locale}: the scan reaches nested copy, not only the top level`, () => {
    // The guard above is only worth its name if it sees everything the app can
    // render. `days` and `daysShort` are arrays and `_meta` is an object, and a
    // scan that kept only top-level strings saw none of them.
    const bundle = strings(locale);
    const nested = Object.keys(bundle).filter((key) => key.includes('[') || key.includes('.'));
    assert.ok(nested.length > 0, `${locale}.json has no nested strings, so this test proves nothing — check the walker`);
    assert.ok(nested.some((key) => key.startsWith('days')), `${locale}.json: the weekday arrays were not walked`);
  });

  test(`${locale}: the lateness phrases describe the time, not a verdict on the user`, () => {
    const bundle = strings(locale);
    for (const key of LATENESS_KEYS) {
      const phrase = bundle[key];
      assert.ok(phrase && phrase.trim() !== '', `${locale}.json has no ${key}, so the reason renders as nothing`);
      assert.ok(!phrase.includes(WORD[locale]), `${locale}.json ${key} says "${WORD[locale]}": ${phrase}`);
    }
  });
}
