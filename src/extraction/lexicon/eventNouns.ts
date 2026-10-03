/**
 * What makes a timed entry an *event* — something that happens at its hour —
 * rather than a task given an hour (black-box audit 2026-10-03, #2 and #3).
 *
 * «سجّل إني لازم أحضّر الغداء الساعة 2» and «Remind me to send the report at
 * 3pm» are `scheduled_event`s just as «عندي امتحان الساعة 10» and «سهرة مع
 * الصحاب الليلة 21:00» are (`timeAnchor: 'event'` is any clock time). The
 * first two are work to do; the last two are not something to "start" hours
 * ahead. These lists, with the appointment nouns, are how the next step tells
 * them apart (`lib/services/nextStepPreparation.ts`).
 *
 * ── PREPARATION_NOUNS ────────────────────────────────────────────
 *
 * Events a person prepares for over time, not just shows up to.
 *
 * «عندي امتحان رياضيات بكرا الساعة 10» is an event with a start time, like a
 * dentist or a night out — but unlike them it is the kind of thing whose
 * outcome depends on what the person does *before* it. The next step offers a
 * preparation action for these (`lib/services/nextStepPreparation.ts`), and
 * «حضّرني» plans them with a day of lead rather than an hour
 * (`lib/services/mobile/meetingPrepService.ts`).
 *
 * Deliberately narrow: exams, interviews, presentations, defences. Not a
 * meeting (an hour before is what «حضّرني» has always planned for one), not a
 * doctor, not a flight, and not a bare English "test" — a blood test is not
 * studied for. A word missing here costs a suggestion; a word wrongly here
 * puts "prepare for your dinner" on someone's Today.
 *
 * Plain strings, like `appointmentNouns.ts` next to it: each reader adds its
 * own prefixes and word edges.
 */
export const PREPARATION_NOUNS = {
  ar: [
    'امتحان', 'إمتحان', 'امتحانات', 'اختبار', 'إختبار', 'كويز', 'مقابلة', 'مقابله',
    'انترفيو', 'إنترفيو', 'مناقشة', 'مناقشه', 'برزنتيشن', 'بريزنتيشن', 'عرض تقديمي',
  ],
  he: ['מבחן', 'בחינה', 'בוחן', 'ראיון', 'מצגת'],
  en: ['exam', 'exams', 'midterm', 'midterms', 'final exam', 'quiz', 'interview', 'presentation', 'thesis defense', 'viva'],
} as const;

/**
 * ── GATHERING_NOUNS ──────────────────────────────────────────────
 *
 * Going out, celebrations, a match: plans with a start time. No food words —
 * «حضّر العشا» is cooking, a task — and the going-out verbs only with «مع»,
 * the way people say it («تطلع مع أصحابك»), never bare.
 */
export const GATHERING_NOUNS = {
  ar: [
    'سهرة', 'سهره', 'سهرات', 'طلعة', 'طلعه', 'حفلة', 'حفله', 'حفل', 'عرس', 'خطوبة', 'خطوبه', 'عزومة', 'عزومه',
    'عيد ميلاد', 'رحلة', 'رحله', 'مباراة', 'مباراه', 'ماتش', 'سينما', 'كونسيرت',
    'اطلع مع', 'نطلع مع', 'تطلع مع', 'بطلع مع', 'منطلع مع', 'طالع مع', 'طالعين مع',
  ],
  he: ['מסיבה', 'מסיבת', 'חתונה', 'יום הולדת', 'בילוי', 'הופעה', 'קונצרט', 'יציאה עם', 'לצאת עם'],
  en: ['party', 'wedding', 'birthday', 'concert', 'night out', 'hangout', 'hang out with', 'go out with', 'going out with', 'drinks with', 'dinner with', 'movie night', 'game night'],
} as const;
