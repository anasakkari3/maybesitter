/**
 * What a fixed appointment looks like, in Arabic, Hebrew and English (L4).
 *
 * «سجّل موعد دكتور يوم الأحد» reached the review card as «يُفضّل» (should):
 * nothing knew that a doctor on a named day is not optional. The rule, read by
 * both engines — the rule-based extractor infers with it, the schema validator
 * raises a model's default with it:
 *
 *   the user *attending* an appointment-type event (doctor, dentist, clinic,
 *   hospital, exam, interview, flight, court) with a fixed day or time is
 *   `high`, source `inferred`; a meeting counts only with a clock time.
 *
 * `inferred`, never `user_explicit`: it is our reading, so the review card
 * keeps its «حزرناها» chip and the user can change it in one tap.
 *
 * ══ PRECISION OVER RECALL (controller ruling, fix round 1) ═══════
 *
 * The first version matched the nouns anywhere, and review found plain tasks
 * it marked Must: «أرسل للدكتور الملف», "look up flight prices", "basketball
 * court", "study for the exam", "meeting notes", «ما في دكتور», "appointment
 * cancelled", and Hebrew «בתור» ("as", "in line") read as «תור». So:
 *
 *   - a positive needs an *attending* frame — «موعد دكتور», «عندي امتحان»,
 *     «عند الدكتور», "dentist appointment", "at the doctor", "my flight",
 *     "court hearing", «תור לרופא», «יש לי מבחן», or the noun opening the note
 *     ("dentist tomorrow at 4pm", «امتحان رياضيات الأحد»);
 *   - anything that makes it someone else's appointment, or no appointment —
 *     contacting or arranging it (send/email/call, book, «احجز», «ابعت»), a
 *     negation or cancellation, or a loose-noun context (prices, basketball,
 *     watch, study, notes, deadline) — declines outright;
 *   - the professional as a bare recipient («للدكتور») declines too, unless an
 *     attend verb says the user is going («رايح للدكتور», «הולך לרופא») —
 *     fix round 2. "Don't forget the dentist" is not a negation.
 *
 * A miss leaves the level where it always was (Should, and editable). A false
 * hit marks a plain task as a Must. When in doubt, this returns false.
 */

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';

function words(list: readonly string[]): string {
  return `${B}(?:${list.join('|')})${A}`;
}

/** The note may open with a command word before the appointment itself. */
const LEAD = '^\\s*(?:(?:please\\s+)?(?:remind\\s+me(?:\\s+(?:about|of))?|reminder|note|add|(?:don\'?t|do\\s+not)\\s+forget(?:\\s+about)?)\\s*:?\\s*|(?:لا|ما)\\s+تنس(?:ى|ي|ا)?\\s+|אל\\s+תשכח(?:י|ו)?\\s+(?:את\\s+)?|(?:ذكرني|ذكريني|سجّل|سجل|سجلي|سجّلي|ضيف|ضيفي)\\s+|(?:תזכיר\\s+לי|תזכירי\\s+לי|לרשום|תרשום|תוסיף)\\s+)?';

const EN_MEDICAL = "(?:doctor|doctor's|dr|gp|dentist|dentist's|orthodontist|physio|therapist|clinic|hospital|optician|dermatologist|pediatrician|paediatrician|vet)";
const AR_MEDICAL = '(?:دكتور|دكتورة|الدكتور|الدكتورة|طبيب|طبيبة|الطبيب|الطبيبة|أسنان|اسنان|الأسنان|الاسنان|عيادة|عياده|العيادة|العياده|مستشفى|المستشفى|مشفى|المشفى)';

/** Frames in which the user is going to the thing. */
const ATTENDING = new RegExp(
  [
    // en
    `\\b${EN_MEDICAL}\\s+(?:appointment|appt|visit|check-?up)\\b`,
    '\\b(?:appointment|appt|check-?up)\\b',
    `\\b(?:at|to|see|seeing|visit|visiting)\\s+(?:the\\s+|my\\s+|a\\s+)?${EN_MEDICAL}\\b`,
    `${LEAD}(?:(?:my|the)\\s+)?${EN_MEDICAL}\\b`,
    '\\b(?:blood|lab|driving|eye|hearing|covid|pcr)\\s+tests?\\b',
    '\\b(?:have|has|take|taking|sit|sitting)\\s+(?:my\\s+|an?\\s+|the\\s+)?(?:[a-z]+\\s+)?(?:exam|midterm)\\b',
    `${LEAD}(?:(?:my|the|an?)\\s+)?(?:[a-z]+\\s+)?(?:exam|midterm)\\b`,
    '\\b(?:job|work)\\s+interview\\b',
    '\\b(?:have|has|got)\\s+(?:an?\\s+|my\\s+)?interview\\b',
    '\\binterview\\s+(?:at|with)\\b',
    `${LEAD}(?:(?:my|an?)\\s+)?interview\\b`,
    '\\b(?:my|our)\\s+flight\\b',
    '\\bflight\\s+(?:to|at|from)\\b',
    '\\bcatch\\s+(?:the|my|a|our)\\s+flight\\b',
    `${LEAD}flight\\b`,
    '\\bcourt\\s+(?:hearing|date|case|appearance|session)\\b',
    '\\b(?:in|at|to)\\s+court\\b',
    '\\bhearing\\s+(?:at|in)\\s+(?:the\\s+)?court\\b',
    // ar
    `${B}(?:موعد|موعدي)\\s+(?:عند\\s+|مع\\s+|في\\s+|ب)?${AR_MEDICAL}${A}`,
    `${B}موعد\\s+(?:ال)?(?:فحص|تحليل|محكمة|محكمه|مقابلة|مقابله)${A}`,
    words(['موعدي']),
    `${B}(?:عندي|عندنا|الي|إلي)\\s+(?:موعد|دكتور|طبيب|امتحان|إمتحان|مقابلة|مقابله|محكمة|محكمه|جلسة|طيارة|طيران|فحص|تحليل)${A}`,
    `${B}(?:عند|لعند)\\s+${AR_MEDICAL}${A}`,
    `${B}(?:عال|على\\s+ال|ع\\s+ال)(?:دكتور|دكتورة|طبيب|عيادة|عياده|مستشفى|مشفى)${A}`,
    `${LEAD}(?:دكتور|دكتورة|طبيب|طبيبة|مستشفى|عيادة|عياده|امتحان|إمتحان|مقابلة|مقابله|طيارتي|طيارة|طيران|محكمة|محكمه|جلسة)${A}`,
    `${B}مقابلة\\s+(?:شغل|عمل|وظيفة)${A}`,
    words(['طيارتي', 'رحلة\\s+طيران', 'رحلتي\\s+بالطيارة']),
    `${B}طيارة\\s+(?:ل|إلى|الى|على|ع|الساعة)`,
    `${B}(?:جلسة|جلسه)\\s+(?:في\\s+|ب|عال|على\\s+)?(?:ال)?محكم(?:ة|ه)${A}`,
    words(['بالمحكمة', 'بالمحكمه', 'عالمحكمة', 'في\\s+المحكمة']),
    // he — «תור» only as a word of its own or with ה/ו, never «בתור»
    `${B}[הו]?תור\\s+(?:ל|אצל|ב)`,
    `${B}יש\\s+לי\\s+(?:תור|מבחן|בחינה|ראיון|טיסה|דיון)${A}`,
    `${B}אצל\\s+ה?(?:רופא|רופאה|רופאת|רופא\\s+שיניים)${A}`,
    `${LEAD}(?:רופא|רופאה|רופאת|מרפאה|מרפאת|מבחן|בחינה|בחינת|ראיון|טיסה|טיסת)${A}`,
    `${B}ראיון\\s+עבודה${A}`,
    `${B}הטיסה\\s+שלי${A}`,
    `${B}טיסה\\s+ל`,
    `${B}דיון\\s+(?:ב)?בית\\s+ה?משפט${A}`,
    `${B}[לב]בית\\s+ה?משפט${A}`,
  ].join('|'),
  'iu',
);

/** A meeting is fixed only when it has a clock time. */
const MEETING = new RegExp(`\\bmeeting\\b|${B}و?(?:اجتماع|الاجتماع)${A}|${B}[והלב]?פגישה${A}`, 'iu');

/** No appointment, or not this one: negation, cancellation, postponement. */
const NEGATED = new RegExp(
  [
    "\\b(?:cancel(?:l?ed|l?ing|s)?|called\\s+off|postpone[ds]?|reschedul\\w*|moved|no|not|isn't|aren't|wasn't|don't|doesn't|won't|never|without)\\b",
    words(['ما\\s+في', 'مافي', 'ما\\s+عندي', 'ماعندي', 'مش', 'مو', 'ما\\s+رح', 'لغيت', 'لغيته', 'ألغيت', 'الغيت', 'لغى', 'ألغى', 'الغى', 'انلغى', 'إنلغى', 'اتلغى', 'ملغي', 'ملغى', 'تأجل', 'تأجّل', 'أجلت', 'أجّلت', 'اجلت', 'بدون', 'لا']),
    words(['בוטל', 'בוטלה', 'ביטלתי', 'ביטלו', 'לבטל', 'אין', 'לא', 'נדחה', 'נדחתה', 'דחיתי', 'בלי']),
  ].join('|'),
  'iu',
);

/** Arranging or contacting — a task about an appointment, not the appointment. */
const ARRANGING = new RegExp(
  [
    '\\b(?:call(?:ed|ing|s)?|phon(?:e|ed|ing)|ring|rang|email(?:ed|ing|s)?|e-mail|text(?:ed|ing)?|messag(?:e|ed|ing)|book(?:ed|ing|s)?|schedul(?:e|ed|ing)|arrang(?:e|ed|ing)|confirm(?:ed|ing)?|send|sent|mail(?:ed)?|forward(?:ed)?|give|hand|pay|buy|order)\\b',
    '\\bmake\\s+(?:an?\\s+|the\\s+)?(?:\\w+\\s+)?(?:appointment|appt)\\b',
    words(['احجز', 'أحجز', 'حجزت', 'بحجز', 'نحجز', 'احجزي', 'اتصل', 'أتصل', 'اتصلت', 'بتصل', 'اتصلي', 'رن', 'رنّ', 'كلّم', 'كلم', 'أكلم', 'اكلم', 'بكلم', 'احكي', 'أحكي', 'ابعت', 'ابعث', 'أبعت', 'بعتت', 'بعثت', 'أرسل', 'ارسل', 'راسل', 'اكتب', 'أكتب', 'ثبّت', 'ثبت', 'أكّد', 'أكد', 'اكد', 'اشتري', 'أشتري', 'جيب', 'اجيب', 'هدية', 'ادفع', 'أدفع']),
    words(['اعمل\\s+موعد', 'أعمل\\s+موعد', 'اطلب\\s+موعد', 'أطلب\\s+موعد', 'آخد\\s+موعد', 'اخد\\s+موعد', 'أخذ\\s+موعد', 'اخذ\\s+موعد']),
    words(['להתקשר', 'תתקשר', 'תתקשרי', 'התקשרתי', 'להזמין', 'תזמין', 'הזמנתי', 'לקבוע', 'תקבע', 'תקבעי', 'קבעתי', 'לתאם', 'תתאם', 'לשלוח', 'תשלח', 'שלחתי', 'לכתוב', 'לקנות', 'תקנה', 'לשלם']),
  ].join('|'),
  'iu',
);

/**
 * The professional as a recipient: «للدكتور», "a gift for the doctor". Not an
 * appointment — unless an attend verb says the user is the one going there
 * (`ATTEND_VERB`), because «رايح للدكتور» is the commonest way to say it.
 */
const RECIPIENT = new RegExp(
  [
    `${B}لل?(?:دكتور|دكتورة|طبيب|طبيبة|عيادة|عياده|مستشفى)${A}`,
    '\\bfor\\s+(?:the\\s+|my\\s+)?(?:doctor|dentist|dr)\\b',
  ].join('|'),
  'iu',
);

/** The user going there: «رايح للدكتور», «بروح عالعيادة», «הולכת לרופא». */
const ATTEND_VERB = new RegExp(
  [
    `${B}(?:رايح|رايحة|رايحه|رايحين|بروح|بروحي|منروح|أروح|اروح|نروح|(?:رح|لازم)\\s+(?:أروح|اروح|روح|نروح))\\s+(?:لل|ل|لعند\\s+ال|لعند\\s+|عند\\s+ال|عند\\s+|عال|على\\s+ال|ع\\s+ال)?(?:دكتور|دكتورة|طبيب|طبيبة|عيادة|عياده|مستشفى|مشفى)${A}`,
    `${B}(?:הולך|הולכת|הולכים|אלך|ללכת|נוסע|נוסעת)\\s+(?:ל|אל\\s+)ה?(?:רופא|רופאה|רופאת|מרפאה|מרפאת|בית\\s+חולים)${A}`,
    "\\b(?:going|go|heading|head)\\s+to\\s+(?:the\\s+|my\\s+)?(?:doctor|doctor's|dentist|dentist's|gp|clinic|hospital)\\b",
  ].join('|'),
  'iu',
);

/** "Don't forget the dentist" is a reminder, not a negation. */
const DONT_FORGET = new RegExp(
  `\\b(?:don'?t|do\\s+not)\\s+forget\\b|${B}(?:لا|ما)\\s+تنس(?:ى|ي|ا)?${A}|${B}אל\\s+תשכח(?:י|ו)?${A}`,
  'giu',
);

/** The noun is there, and it is not an appointment being attended. */
const LOOSE_NOUN = new RegExp(
  [
    '\\b(?:prices?|tickets?|fares?|deals?|search(?:ing)?|look(?:ing)?\\s+up|basketball|tennis|squash|volleyball|badminton|food\\s+court|watch(?:ing)?|listen(?:ing)?|transcrib\\w*|stud(?:y|ying|ies)|revis\\w*|review(?:ing)?|prep(?:are|ared|aring|ping)?|grad(?:e|es|ing)|mark(?:ing)?|correct(?:ing)?|print(?:ing)?|write|writing|notes|minutes|agenda|deadline|due|hearing\\s+back)\\b',
    words(['أسعار', 'اسعار', 'سعر', 'تذاكر', 'تذكرة', 'أدرس', 'ادرس', 'بدرس', 'درس', 'دراسة', 'راجع', 'أراجع', 'اراجع', 'مراجعة', 'حضّر', 'حضر', 'أحضّر', 'جهّز', 'جهز', 'صحّح', 'صحح', 'أصحح', 'تصحيح', 'أشوف', 'اشوف', 'شوف', 'بشوف', 'أسمع', 'اسمع', 'محضر', 'ملاحظات', 'تسليم', 'نهائي', 'آخر\\s+موعد', 'اخر\\s+موعد', 'مع\\s+الشباب', 'مع\\s+الأصحاب', 'مع\\s+الاصحاب', 'سياحية', 'مدرسية']),
    words(['מחירים', 'מחיר', 'כרטיסים', 'כרטיס', 'ללמוד', 'לומד', 'לומדת', 'להתכונן', 'לבדוק', 'לתקן', 'לראות', 'צפייה', 'סיכום', 'פרוטוקול', 'הגשה', 'דדליין', 'כדורסל', 'טניס']),
  ].join('|'),
  'iu',
);

export interface FixedTime {
  /** The sentence resolved to a day. */
  hasDay: boolean;
  /** The sentence resolved to a clock time on it. */
  hasClock: boolean;
}

/**
 * True when the sentence clearly describes the user attending an
 * appointment-type event at a fixed day or time. False whenever in doubt.
 */
export function isFixedAppointment(rawText: string, time: FixedTime): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  if (!time.hasDay && !time.hasClock) return false;
  const text = rawText.trim();
  if (ARRANGING.test(text) || LOOSE_NOUN.test(text)) return false;
  if (NEGATED.test(text.replace(DONT_FORGET, ' '))) return false;
  const attends = ATTEND_VERB.test(text);
  if (RECIPIENT.test(text) && !attends) return false;
  if (attends || ATTENDING.test(text)) return true;
  return time.hasClock && MEETING.test(text);
}
