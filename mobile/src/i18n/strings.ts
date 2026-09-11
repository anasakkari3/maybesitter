// Copy for the round-1 design (Claude Design · MaybeSitter.dc.html).
// Arabic is the default language; English mirrors it.

export type Lang = 'ar' | 'en';

export const strings = {
  ar: {
    tabToday: 'اليوم', tabCalendar: 'التقويم', tabCapture: 'احكيها', tabSettings: 'الإعدادات',
    dateToday: 'الخميس، 10 أيلول', todayTitle: 'يومك', budgetPill: 'تذكيران باقيين هذا الأسبوع', offline: 'بدون إنترنت. اللي بتحكيه بنحفظه هون لحدّ ما نرجع.',
    closeoutBanner: 'أمس بقي شيئان بدون قرار.', closeoutCta: 'نرتّبهم؟',
    emptyTitle: 'يومك فاضي.', emptyBody: 'احكي أول التزام زي ما بتفكر فيه، وبنحطّه بيومك.', sayIt: 'احكيها',
    allDone: 'تمّت كلها. يوم هادئ.',
    nextStepLabel: 'خطوتك التالية', nextStepText: '«أدرس للامتحان» كبيرة. نقسمها 5 جلسات على 5 أيام؟', suggestionNote: 'هذا اقتراح. لم يتغيّر أي شيء بعد.', splitIt: 'شوف التقسيم', notNow: 'ليس الآن',
    timelineTitle: 'اليوم بالساعة', busy: 'مشغول', calConnected: 'أوقات مشغولة من تقويم الجوال', calNot: 'التقويم غير موصول', noTime: 'بدون وقت بعد',
    weekRange: '6 – 12 أيلول', calendarTitle: 'الأسبوع', legendCommit: 'التزام', legendBusy: 'مشغول (من التقويم)', dayFree: 'ما في شي هذا اليوم.',
    loadLight: 'خفيف', loadNormal: 'عادي', loadFull: 'مليان',
    settingsTitle: 'الإعدادات', settingsNote: 'الإعدادات، الثقة والخصوصية، وميزانية المقاطعات تُصمَّم بالجولة القادمة. السجل ينتقل هنا كتاريخ محايد.',
    back: 'رجوع', cancel: 'إلغاء', close: 'إغلاق', ok: 'تمام', done: 'تمّت', notYet: 'لسّا', rearrange: 'نعيد ترتيبها', dropIt: 'أسقطه بوعي', dayLabel: 'اليوم', timeLabel: 'الوقت',
    captureTitle: 'احكيها', sayItLikeYouThink: 'بس احكيها زي ما بتفكر فيها', tapToTalk: 'اضغط وتكلّم، أو خلّي إصبعك عليه وهو بيسمع', orType: 'أو اكتب', tryOne: 'جرّب واحدة',
    listening: 'بسمعك', stopReview: 'وقّف وراجع', checkTranscript: 'هذا اللي سمعناه. عدّل إذا بدك.', sayAgain: 'احكيها من جديد', privacyVoice: 'الصوت لا يُحفظ. يُرسل النص فقط بعد ما تراجعه.', privacyText: 'النص يُرسل لخادمنا لنفهمه، ولا نحتفظ به.', analyze: 'فهمها', understanding: 'بنفهمها…', typePlaceholder: 'بكرا الساعة 9 دكتور وبعدين شغل',
    nothingTitle: 'ما لقينا التزام', nothingBody: 'فهمنا الجملة، بس ما فيها شي ننزّله بيومك.', rephrase: 'احكيها بطريقة ثانية',
    reviewTitle: 'مراجعة', cancelAll: 'إلغاء الكل', confirmOne: 'أكّد التزام واحد', confirmN: 'أكّد {n} التزامات', confirmNone: 'ما في شي لتأكيده',
    readingsBanner: 'فهمناها بطريقتين. اختار الصح ←',
    savedToday: 'نزلت بيومك اليوم', savedTomorrow: 'نزلت بيومك بكرا', savedDay: 'نزلت بيومك يوم {d}', undo: 'تراجع', viewToday: 'شوف اليوم', viewTomorrow: 'شوف بكرا', viewDay: 'شوف {d}',
    yesterday: 'أمس، الأربعاء', closeoutTitle: 'تمّت أو لسّا؟', movedTo: 'راحت لـ{d} الساعة {t}', closeoutSummary: 'اللي «لسّا» راحت لبكرا وبعد بكرا، بأوقات فاضية. ما في شي متراكم.', closeoutDone: 'تمام', closeoutAnswer: 'جاوب على الكل',
    firstMoveTitle: 'أول خطوة', fmHeadline: '«أدرس للامتحان» بدها وقت. كيف نبلّشها؟', fmSessions: '5 جلسات', fmTwoMin: 'خطوة بدقيقتين', fmSessionsBody: 'ساعة كل يوم، بأوقات فاضية من تقويمك:', fmSessionsNote: 'المحتوى ما يتغيّر. بس الوقت يتوزّع.', fmTwoMinLabel: 'الآن، بدقيقتين', fmTwoMinStep: 'افتح ملخّص المادة واقرأ عناوين الفصول فقط.', fmTwoMinWhy: 'أول خطوة صغيرة بتكسر الحاجز. الباقي بنرتّبه بعدين.', accept: 'قبول', edit: 'عدّل', keepAsOne: 'خلّيها وحدة',
    oneQuestion: 'سؤال واحد', clarifyQ: 'أيمتى بدك تسلّم التقرير؟', morning: 'الصبح', noon: 'الظهر', evening: 'المسا', orTypeTime: 'أو اكتب وقت', skipNoTime: 'خلّيها بدون وقت',
    readingsTitle: 'فهمناها بطريقتين', readingsBody: '«موعد مع سامي الخميس». أي خميس؟', readingsPrivacy: 'هذي الجملة راحت لخادمنا لنفهمها بطريقتين. ما نحتفظ بها بعد ما تختار.',
    rearrangeTitle: 'نعيد ترتيبها؟', rearrangeReason: '«{t}» بدها ساعة، والوقت الباقي قبلها أقل من هيك. اختار اللي يريّحك.',
    intensify: 'كثّف', intensifyHint: 'نفس المحتوى، وقت أقصر', extend: 'مدّد الموعد', extendHint: 'نفس المحتوى، يوم ثاني', shrink: 'قلّص المحتوى', shrinkHint: 'أقل شوي، بنفس الوقت', dropHint: 'قرار، مش فشل',
    toastIntensify: 'تمام. صارت نص ساعة بنفس الوقت.', toastExtend: 'تمام. راحت لبكرا الساعة 10.', toastShrink: 'تمام. قلّصناها، بنفس الوقت.', toastDrop: 'تمام. أسقطتها بوعي.', toastDone: 'تمّت.', toastFm: 'تمام. 5 جلسات نزلت بأسبوعك.',
    mustL: 'ضروري', shouldL: 'مستحسن', niceL: 'اختياري', active: 'قائم', doneS: 'تمّت', dropped: 'أُسقطت بوعي',
    today: 'اليوم', tomorrow: 'بكرا',
    days: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
    daysShort: ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'],
    exDoctor: 'بكرا الساعة 9 دكتور وبعدين شغل', exReport: 'لازم أسلّم التقرير', exSami: 'موعد مع سامي الخميس', exStudy: 'أدرس للامتحان', exHi: 'كيفك',
    pDoctor: 'موعد الدكتور', pWork: 'شغل', pReport: 'تسليم التقرير', pSami: 'موعد مع سامي', pStudy: 'أدرس للامتحان',
    doctorPart: 'بكرا الساعة 9 دكتور', joinPart: ' وبعدين ', workPart: 'شغل',
    thisThu: 'الخميس هذا', nextThu: 'الخميس الجاي', thisThuWhen: 'اليوم، 10 أيلول', nextThuWhen: '17 أيلول، بعد أسبوع', noTimeYet: 'بدون وقت',
    sAppearance: 'المظهر', sLanguage: 'اللغة', sNotif: 'الإشعارات', sBudget: 'ميزانية المقاطعات', sTrust: 'الثقة والخصوصية', sHistory: 'السجل',
    vSystem: 'النظام', vLight: 'فاتح', vDark: 'داكن', vLang: 'العربية', vQuiet: 'هادئة فقط', vBudget: '3 من 5 هذا الأسبوع',
    lockedTitle: 'اليوم، {n} أشياء', progressWords: 'تمّت {d} من {n}',
  },
  en: {
    tabToday: 'Today', tabCalendar: 'Calendar', tabCapture: 'Say it', tabSettings: 'Settings',
    dateToday: 'Thursday, 10 Sept', todayTitle: 'Your day', budgetPill: '2 reminders left this week', offline: 'No internet. What you say is kept here until we’re back.',
    closeoutBanner: 'Two things from yesterday have no decision yet.', closeoutCta: 'Sort them?',
    emptyTitle: 'Your day is empty.', emptyBody: 'Say the first commitment the way you think of it, and it lands in your day.', sayIt: 'Say it',
    allDone: 'All done. A quiet day.',
    nextStepLabel: 'Your next step', nextStepText: '“Study for the exam” is big. Split it into 5 sessions over 5 days?', suggestionNote: 'This is a suggestion. Nothing has changed yet.', splitIt: 'See the split', notNow: 'Not now',
    timelineTitle: 'The day by the hour', busy: 'Busy', calConnected: 'Busy times from your phone calendar', calNot: 'Calendar not connected', noTime: 'No time yet',
    weekRange: '6 – 12 Sept', calendarTitle: 'The week', legendCommit: 'Commitment', legendBusy: 'Busy (from calendar)', dayFree: 'Nothing on this day.',
    loadLight: 'Light', loadNormal: 'Normal', loadFull: 'Full',
    settingsTitle: 'Settings', settingsNote: 'Settings, Trust & privacy and the interruption budget are designed in the next round. Activity moves here as a neutral history.',
    back: 'Back', cancel: 'Cancel', close: 'Close', ok: 'OK', done: 'Done', notYet: 'Not yet', rearrange: 'Rearrange', dropIt: 'Drop on purpose', dayLabel: 'Day', timeLabel: 'Time',
    captureTitle: 'Say it', sayItLikeYouThink: 'Just say it the way you think it', tapToTalk: 'Tap and talk, or hold while you speak', orType: 'Or type', tryOne: 'Try one',
    listening: 'LISTENING', stopReview: 'Stop and check', checkTranscript: 'This is what we heard. Fix anything.', sayAgain: 'Say it again', privacyVoice: 'Audio is never saved. Only the text is sent, after you check it.', privacyText: 'The text goes to our server to be understood. We don’t keep it.', analyze: 'Understand it', understanding: 'Understanding…', typePlaceholder: 'Doctor at 9 tomorrow, then work',
    nothingTitle: 'No commitment found', nothingBody: 'We understood the sentence, but there’s nothing to put in your day.', rephrase: 'Say it another way',
    reviewTitle: 'Review', cancelAll: 'Cancel all', confirmOne: 'Confirm 1 commitment', confirmN: 'Confirm {n} commitments', confirmNone: 'Nothing to confirm',
    readingsBanner: 'We read this two ways. Pick the right one →',
    savedToday: 'Landed in your day today', savedTomorrow: 'Landed in your day tomorrow', savedDay: 'Landed in your day on {d}', undo: 'Undo', viewToday: 'See today', viewTomorrow: 'See tomorrow', viewDay: 'See {d}',
    yesterday: 'Yesterday, Wednesday', closeoutTitle: 'Done, or not yet?', movedTo: 'Moved to {d} at {t}', closeoutSummary: 'The “not yet” ones went to tomorrow and the day after, in free slots. Nothing piles up.', closeoutDone: 'OK', closeoutAnswer: 'Answer all',
    firstMoveTitle: 'First move', fmHeadline: '“Study for the exam” needs time. How do we start it?', fmSessions: '5 sessions', fmTwoMin: '2‑minute step', fmSessionsBody: 'One hour a day, in free slots from your calendar:', fmSessionsNote: 'The content doesn’t change. Only the time is spread.', fmTwoMinLabel: 'NOW, IN 2 MINUTES', fmTwoMinStep: 'Open the course summary and read only the chapter titles.', fmTwoMinWhy: 'A small first step breaks the wall. We’ll arrange the rest later.', accept: 'Accept', edit: 'Edit', keepAsOne: 'Keep it as one',
    oneQuestion: 'One question', clarifyQ: 'When do you want to hand in the report?', morning: 'Morning', noon: 'Noon', evening: 'Evening', orTypeTime: 'Or type a time', skipNoTime: 'Leave it without a time',
    readingsTitle: 'We read it two ways', readingsBody: '“Meeting with Sami on Thursday.” Which Thursday?', readingsPrivacy: 'This sentence went to our server to be read two ways. We don’t keep it after you choose.',
    rearrangeTitle: 'Rearrange it?', rearrangeReason: '“{t}” needs an hour, and there’s less than that left before it. Pick what suits you.',
    intensify: 'Intensify', intensifyHint: 'Same content, shorter time', extend: 'Move the deadline', extendHint: 'Same content, another day', shrink: 'Do less of it', shrinkHint: 'A bit less, same time', dropHint: 'A decision, not a failure',
    toastIntensify: 'OK. Now half an hour, same time.', toastExtend: 'OK. Moved to tomorrow at 10:00.', toastShrink: 'OK. Trimmed, same time.', toastDrop: 'OK. Dropped on purpose.', toastDone: 'Done.', toastFm: 'OK. 5 sessions landed in your week.',
    mustL: 'Must', shouldL: 'Should', niceL: 'Nice', active: 'Active', doneS: 'Done', dropped: 'Dropped on purpose',
    today: 'Today', tomorrow: 'Tomorrow',
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    exDoctor: 'Doctor at 9 tomorrow, then work', exReport: 'I have to hand in the report', exSami: 'Meeting with Sami on Thursday', exStudy: 'Study for the exam', exHi: 'How are you',
    pDoctor: 'Doctor appointment', pWork: 'Work', pReport: 'Hand in the report', pSami: 'Meeting with Sami', pStudy: 'Study for the exam',
    doctorPart: 'Doctor at 9 tomorrow', joinPart: ', then ', workPart: 'work',
    thisThu: 'This Thursday', nextThu: 'Next Thursday', thisThuWhen: 'Today, 10 Sept', nextThuWhen: '17 Sept, in a week', noTimeYet: 'No time',
    sAppearance: 'Appearance', sLanguage: 'Language', sNotif: 'Notifications', sBudget: 'Interruption budget', sTrust: 'Trust & privacy', sHistory: 'History',
    vSystem: 'System', vLight: 'Light', vDark: 'Dark', vLang: 'English', vQuiet: 'Quiet only', vBudget: '3 of 5 this week',
    lockedTitle: 'Today, {n} things', progressWords: '{d} of {n} done',
  },
};

export type Strings = typeof strings.ar;

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''));
}

// Keeps times such as "9:00" left-to-right inside Arabic sentences.
export const ltr = (s: string) => `⁦${s}⁩`;
