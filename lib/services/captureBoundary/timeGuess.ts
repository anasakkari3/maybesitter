import { partOfDayOnlyHour } from '../../../src/extraction/timeLexicon';

/**
 * The words give a part of the day and no hour (UAT round 6, D2).
 *
 * «لازم أتصل بأمي اليوم المسا» reached the review card as «اليوم · 18:00»
 * with nothing on it: the person said «المسا», and 18:00 is the product's
 * hour for it (`dayPartHour`), on both engines. The hour stays — which one is
 * picked is pinned (`tests/extraction/dayPartBoundary.test.ts`) — but it is
 * marked as our guess (`timeEstimated`), the way «حزرنا التاريخ» marks a
 * guessed day.
 *
 * True when the text names a part of the day — المسا/العصر/الصبح/الضهر/
 * بالليل, "this evening"/"morning"/"tonight", «בערב»/«בבוקר»/«אחר הצהריים» —
 * and states no clock number anywhere: «5 المسا», «الساعة 7», «7pm»,
 * «ב-19:00», «الساعة سبعة المسا» are the person's hour. «12 المسا» is asked,
 * never settled, so it is never a guess shown as a time.
 *
 * The model path puts the same hour on its day (`partOfDayOnlyHour`, UAT
 * round 6 batch 4), so the words decide the hour as well as the mark.
 *
 * Content-free: it reads the words and answers a boolean; nothing of them is
 * kept.
 */
export function hourIsPartOfDayGuess(text: string): boolean {
  return partOfDayOnlyHour(text) !== null;
}
