/**
 * The clock word is a whole word, and a title never pays for it with a letter.
 *
 * Colloquial Levantine contracts «على الساعة» to «عالساعة», so the Arabic
 * clock word tolerates a leading «ع» («ع الساعة 5», «عالساعة 5»). The
 * tolerance is right; its reach was not. The «ع» was optional with no
 * boundary in front of it, so when the word *before* «الساعة» genuinely ends
 * in «ع» that letter was read as the clock word and taken out of the title
 * with the time:
 *
 *   «عندي اجتماع بكرا الساعة 17:00»   → 17:00, title «عندي اجتما»
 *   «تسليم المشروع بكرا الساعة 10»    → 10:00, title «تسليم المشرو»
 *   «نحكي بالموضوع بكرا الساعة 9»     → 09:00, title «نحكي بالموضو»
 *   «تقرير الأسبوع بكرا الساعة 9»     → 09:00, title «تقرير الأسبو»
 *
 * «اجتماع» is one of the commonest words a commitment can carry, and the
 * phrasing that breaks it is the most obvious one. Any word in between hid
 * it: «عندي اجتماع مهم بكرا الساعة 17:00» was always right, because «مهم»
 * stood where the «ع» would have been eaten.
 *
 * The rule is the one the neighbouring patterns already follow
 * (`AR_CLOCK_WITH_PERIOD`'s bare «ع», and «عال»): the spoken «ع» is a clock
 * word only where no Arabic letter precedes it. Found while recording the
 * promo reel on the rules path, with the model off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { stripTimeExpressions } from '../../src/extraction/ruleBasedExtractor.ts';

const TZ = 'Asia/Jerusalem';
/** Saturday 26 Sep 2026, 10:00 in Jerusalem. */
const NOW = new Date('2026-09-26T07:00:00.000Z');

async function proposeRules(text: string) {
  setStorageForTests(createMemoryStorage());
  try {
    // No participant: no AI consent, so the capture is read by the rules.
    return await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
  } finally {
    resetStorageForTests();
  }
}

type Item = Awaited<ReturnType<typeof proposeRules>>['items'][number];
/** The hour an item landed on, on the user's clock, or null for none. */
const localTime = (item: Item): string | null => item.resolvedTime
  ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time ?? null
  : null;

async function oneItem(text: string): Promise<Item> {
  const proposal = await proposeRules(text);
  assert.equal(proposal.items.length, 1, `${text}: ${JSON.stringify(proposal)}`);
  return proposal.items[0]!;
}

// ── The defect, through the real capture service ─────────────────────
//
// Each row: what the user types, the title it must keep, the hour it must
// read. The hour is asserted beside the title on purpose: a fix that saved
// the letter by dropping the clock word would stop reading the time.

const AYN_BEFORE_CLOCK: ReadonlyArray<readonly [string, string, string]> = [
  ['عندي اجتماع بكرا الساعة 17:00', 'عندي اجتماع', '17:00'],
  ['اجتماع بكرا الساعة 17:00', 'اجتماع', '17:00'],
  ['تسليم المشروع بكرا الساعة 10', 'تسليم المشروع', '10:00'],
  ['نحكي بالموضوع بكرا الساعة 9', 'نحكي بالموضوع', '09:00'],
  ['تقرير الأسبوع بكرا الساعة 9', 'تقرير الأسبوع', '09:00'],
  ['ندفع الربع بكرا الساعة 9', 'ندفع الربع', '09:00'],
  ['عندي توديع بكرا الساعة 20:00', 'عندي توديع', '20:00'],
];

for (const [text, title, time] of AYN_BEFORE_CLOCK) {
  test(`«${text}» keeps the «ع» of the word before «الساعة»`, async () => {
    const item = await oneItem(text);
    assert.equal(item.title, title);
    assert.equal(localTime(item), time);
  });
}

test('the stripper leaves the preceding word whole', () => {
  // The same rule one layer down, where the letter was being taken: the
  // clause's own text, with its time removed.
  assert.equal(stripTimeExpressions('عندي اجتماع بكرا الساعة 17:00'), 'عندي اجتماع');
  assert.equal(stripTimeExpressions('تسليم المشروع بكرا الساعة 10'), 'تسليم المشروع');
});

// ── The tolerance that made it necessary, still working ──────────────

const SPOKEN_CLOCK_WORD: ReadonlyArray<readonly [string, string, string]> = [
  ['عندي اجتماع بكرا عالساعة 17:00', 'عندي اجتماع', '17:00'],
  ['عندي اجتماع بكرا ع الساعة 17:00', 'عندي اجتماع', '17:00'],
  ['عندي اجتماع بكرا على الساعة 17:00', 'عندي اجتماع', '17:00'],
  ['عندي موعد بكرا عالساعة 8 المسا', 'عندي موعد', '20:00'],
  // The «و» connector before it is part of the clock word, as it is before a
  // part of the day («وبالمسا»): the title keeps neither it nor the time.
  ['الاجتماع بكرا وعالساعة 8 المسا', 'الاجتماع', '20:00'],
];

for (const [text, title, time] of SPOKEN_CLOCK_WORD) {
  test(`«${text}» still reads the spoken clock word`, async () => {
    const item = await oneItem(text);
    assert.equal(item.title, title);
    assert.equal(localTime(item), time);
  });
}

// ── Controls: what was already right stays right ─────────────────────

test('a word ending in another letter was never affected', async () => {
  const item = await oneItem('عندي موعد بكرا الساعة 17:00');
  assert.equal(item.title, 'عندي موعد');
  assert.equal(localTime(item), '17:00');
});

test('a word in between is still no protection anyone needs', async () => {
  const item = await oneItem('عندي اجتماع مهم بكرا الساعة 17:00');
  assert.equal(item.title, 'عندي اجتماع');
  assert.equal(localTime(item), '17:00');
});

test('a part of the day after the hour was never affected either', async () => {
  // Measured by mutating the fix: «الساعة 9 الصبح» is read by the
  // clock-with-its-part-of-day pattern, whose own clock word is optional, and
  // that match never started on the «ع». So the user-visible bug needed a
  // bare «الساعة 17:00» with nothing after it — the commonest way to type an
  // hour, which is why it reached a screen recording.
  const item = await oneItem('عندي اجتماع بكرا الساعة تسعة الصبح');
  assert.equal(item.title, 'عندي اجتماع');
  assert.equal(localTime(item), '09:00');
});

test('with no time named, the title was and stays whole', async () => {
  const item = await oneItem('عندي اجتماع بكرا');
  assert.equal(item.title, 'عندي اجتماع');
  assert.equal(localTime(item), null);
});

test('Hebrew and English clock words did not move', async () => {
  const hebrew = await oneItem('פגישה מחר בשעה 17:00');
  assert.equal(hebrew.title, 'פגישה');
  assert.equal(localTime(hebrew), '17:00');
  const english = await oneItem('meeting tomorrow at 17:00');
  assert.equal(english.title, 'meeting');
  assert.equal(localTime(english), '17:00');
});
