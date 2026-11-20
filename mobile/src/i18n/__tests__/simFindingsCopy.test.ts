/**
 * Copy found on the simulator, 2026-11-20 (sim-1120 E and F).
 *
 * E — one dropped commitment was «أسقطته بوعي» in search and history,
 *     «أُسقطت بوعي» on its badge and «أسقطتها بوعي» in its details note. It is
 *     one thing, «التزام», and the button that drops it says «أسقطه بوعي»
 *     (mobile/AGENTS.md), so every line about it says «أسقطته» — the toast
 *     and the confirm too, and Details' delete beside it. Hebrew had two verbs
 *     (להוריד / להפיל) for the one action; it keeps the button's, להוריד.
 * F — the memory screen said «ما منحفظ الملخص» while the server keeps the
 *     latest summary (lib/services/mobile/memorySummary.ts, MEMORY_SUMMARIES)
 *     and serves it again while the memory is unchanged. It is erased when a
 *     memory row is edited or deleted (runtimeMemoryStore), with delete-all
 *     (lib/personalization/deletion.ts) and with the account. The line now
 *     says that, in all three languages.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const DROP_STATUS_KEYS = ['dropped', 'activityKindDropped', 'm6SearchDropped', 'detailsDroppedNote', 'toastDrop'] as const;

describe('E: one dropped commitment, one form', () => {
  it('Arabic says «أسقطته بوعي» wherever it names the drop, after the button «أسقطه بوعي»', () => {
    expect(ar.dropIt).toBe('أسقطه بوعي');
    for (const key of DROP_STATUS_KEYS) expect(ar[key]).toContain('أسقطته بوعي');
    expect(ar.confirmDropTitle).toBe('بدك تسقطه بوعي؟');
    expect(ar.detailsDroppedNote).toBe('أسقطته بوعي. بيضل بتاريخك.');
    // Details' other answer beside it speaks of the same thing the same way.
    expect(ar.detailsDelete).toBe('احذفه');
    expect(ar.confirmDeleteTitle).toBe('بدك تحذفه؟');
    expect(ar.activityKindDeleted).toBe('حذفته');
    const lines = [...DROP_STATUS_KEYS, 'confirmDropTitle', 'detailsDelete', 'confirmDeleteTitle', 'confirmDeleteBody'] as const;
    for (const key of lines) expect(ar[key]).not.toMatch(/أُسقطت|أسقطتها|تسقطها|تحذفها|احذفها|بتضل|بتطلع/);
  });

  it('Hebrew keeps the button\'s verb, להוריד, for every line about the drop', () => {
    expect(he.dropIt).toBe('להוריד במודע');
    for (const key of DROP_STATUS_KEYS) expect(he[key]).toMatch(/הורד/);
    expect(he.confirmDropTitle).toBe('להוריד את זה במודע?');
    for (const key of [...DROP_STATUS_KEYS, 'confirmDropTitle'] as const) expect(he[key]).not.toMatch(/הפל|הופל/);
  });

  it('English already says it one way', () => {
    for (const key of ['dropped', 'activityKindDropped', 'toastDrop'] as const) expect(en[key]).toMatch(/Dropped on purpose/);
    expect(en.m6SearchDropped).toBe('Dropped on purpose {date}');
  });
});

describe('F: the memory summary line says what is kept, and when it goes', () => {
  it('no language says the summary is not stored', () => {
    expect(ar.m5bSummaryDisclosure).not.toMatch(/ما منحفظ/);
    expect(en.m5bSummaryDisclosure).not.toMatch(/isn't stored|not stored/);
    expect(he.m5bSummaryDisclosure).not.toMatch(/לא נשמר/);
  });

  it('each says the latest summary is kept, and erased on an edit, a delete or the account going', () => {
    expect(ar.m5bSummaryDisclosure).toBe('لنكتبلك الملخص، بنبعت اللي بنعرفه عنك لـGemini من Google (Vertex AI) بالاتحاد الأوروبي. بنحفظ آخر ملخص عنّا لنعرضه بدون ما نبعت من جديد، وبنمسحه أول ما تعدّل أو تمسح إشي من ذاكرتك، أو تمسح حسابك.');
    expect(en.m5bSummaryDisclosure).toBe('To write this summary, what MaybeSitter knows about you is sent to Google\'s Gemini (Vertex AI, EU). We keep the latest summary so it can be shown again without sending anything, and erase it as soon as you edit or delete anything in your memory, or delete your account.');
    expect(he.m5bSummaryDisclosure).toBe('כדי לכתוב את הסיכום, אנחנו שולחים את מה שאנחנו יודעים עליך ל-Gemini של Google‏ (Vertex AI) באיחוד האירופי. אנחנו שומרים את הסיכום האחרון כדי להציג אותו שוב בלי לשלוח מחדש, ומוחקים אותו ברגע שעורכים או מוחקים משהו מהזיכרון, או מוחקים את החשבון.');
  });
});
