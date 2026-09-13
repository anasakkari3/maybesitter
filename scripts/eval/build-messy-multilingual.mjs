/**
 * Builds evaluation-data/capture-messy-multilingual-v1.jsonl (UC-2.2, #162).
 *
 * A generator rather than a hand-written file, for three reasons: every case
 * needs a reference time and a timezone and getting those consistent by hand is
 * where suites rot; the expected local date has to be computed from the
 * reference time rather than typed; and #166 extends the same file, so the shape
 * has to come from one place.
 *
 * Everything here is synthetic. The repository is public, so no case may contain
 * a real message, a real name beyond a common first name, a phone number, an
 * address or an email. `tests/evaluation/messyMultilingualDataset.test.ts`
 * enforces that.
 *
 * Run: node scripts/eval/build-messy-multilingual.mjs
 */
import { writeFileSync } from 'node:fs';

const OUT = 'evaluation-data/capture-messy-multilingual-v1.jsonl';

/** One fixed "now" for the whole suite: 2026-09-14 is a Monday. */
const TZ = 'Asia/Jerusalem';
const REF = '2026-09-14T10:00:00+03:00';
const TODAY = '2026-09-14';
const TOMORROW = '2026-09-15';
const DAY_AFTER = '2026-09-16';
/** The next Sunday strictly after Monday 2026-09-14. */
const NEXT_SUNDAY = '2026-09-20';
const NEXT_WEDNESDAY = '2026-09-16';
const NEXT_THURSDAY = '2026-09-17';

const rows = [];
let counters = {};

/**
 * @param language ar|he|en|mixed
 * @param slice    multilingual|multi_item|safety_negative
 */
function add(language, slice, message, expected, extra = {}) {
  const key = `${slice === 'safety_negative' ? 'safety' : 'messy'}-${language}`;
  counters[key] = (counters[key] ?? 0) + 1;
  rows.push({
    id: `${key}-${String(counters[key]).padStart(3, '0')}`,
    slice,
    language,
    ...(extra.variant ? { variant: extra.variant } : {}),
    message,
    referenceTime: REF,
    timezone: TZ,
    expected,
  });
}

/** A commitment the engine should read, with a local date and time. */
const task = (titleKeywords, localDate, localTime, over = {}) => ({
  type: 'task',
  titleKeywords,
  localDate,
  localTime,
  ...over,
});

/** A day was named but no hour: the time must be null and flagged. */
const dayOnly = (titleKeywords, localDate, over = {}) => ({
  type: 'task',
  titleKeywords,
  localDate,
  localTime: null,
  ambiguityFlagsInclude: ['vague_time'],
  ...over,
});

/** Nothing may be created. Shared shape with UC-2.6 (#166). */
const nothing = (reason, over = {}) => ({
  createsNothing: true,
  noCommitmentReason: reason,
  localTime: null,
  ...over,
});

// ── Arabic: 40 cases, 20+ dialectal ────────────────────────────────
// Levantine, the way it is actually typed: بكرا/بكرة both appear, الصبح rather
// than صباحاً, and Arabic-Indic digits mixed with Latin ones.
add('ar', 'multilingual', 'بكرا بعد الشغل لازم أمرّ على الصيدلية', dayOnly(['صيدلية'], TOMORROW), { variant: 'levantine' });
add('ar', 'multilingual', 'ذكرني بكرة الساعة ٧ مساءً أحكي مع أحمد', task(['أحكي'], TOMORROW, '19:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'بكرة الصبح لازم أروح عالشغل', task(['أروح'], TOMORROW, '09:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'بعد بكرا الساعة ٣ العصر عندي دكتور', task(['دكتور'], DAY_AFTER, '15:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'لازم أدفع الكهربا بكرا', dayOnly(['أدفع'], TOMORROW), { variant: 'levantine' });
add('ar', 'multilingual', 'ذكرني الساعة ٥ بالليل أحضّر العرض', task(['أحضّر'], TODAY, '17:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'الخميس الجاي عندي اجتماع الساعة ١١ الصبح', task(['اجتماع'], NEXT_THURSDAY, '11:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'بكرا الساعة تسعة الصبح عندي موعد', task(['موعد'], TOMORROW, '09:00'), { variant: 'spoken-hour' });
add('ar', 'multilingual', 'اليوم بالليل بدي أرتب الغرفة', task(['أرتب'], TODAY, '20:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'ضروري أحجز تذكرة بكرة', dayOnly(['أحجز'], TOMORROW), { variant: 'levantine' });
add('ar', 'multilingual', 'عندي محاضرة إحصاء يوم الأحد الجاي', dayOnly(['محاضرة'], NEXT_SUNDAY), { variant: 'levantine' });
add('ar', 'multilingual', 'بكرة الساعة ٤ و نص عندي حلاق', task(['حلاق'], TOMORROW, '04:30'), { variant: 'levantine-minutes-bare-hour' });
add('ar', 'multilingual', 'ذكريني أتصل بالبنك الساعة ١٠ الصبح', task(['أتصل'], TODAY, '10:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'لازم أجيب خبز وحليب بكرا الصبح', task(['خبز'], TOMORROW, '09:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'بكره بدي اروح عند امي', dayOnly(['اروح'], TOMORROW), { variant: 'levantine-no-punctuation' });
add('ar', 'multilingual', 'الاربعاء الجاي الساعه ٦ المسا عندي تمرين', task(['تمرين'], NEXT_WEDNESDAY, '18:00'), { variant: 'levantine-typos' });
add('ar', 'multilingual', 'ذكرني اراجع الحساب بعد بكره', dayOnly(['اراجع'], DAY_AFTER), { variant: 'levantine-typos' });
add('ar', 'multilingual', 'بدي اغير الزيت للسياره بكرا الساعه ٨ الصبح', task(['الزيت'], TOMORROW, '08:00'), { variant: 'levantine-typos' });
add('ar', 'multilingual', 'مهم: بكرة الساعة ١٢ الضهر عندي مقابلة', task(['مقابلة'], TOMORROW, '12:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'لازم أرسل التقرير بكرا قبل الساعة ٩ الصبح', task(['التقرير'], TOMORROW, '09:00'), { variant: 'levantine' });
// Gulf spellings.
add('ar', 'multilingual', 'باچر الساعة ٧ عندي عشاء', task(['عشاء'], TOMORROW, '07:00'), { variant: 'gulf-bare-hour' });
add('ar', 'multilingual', 'ذكرني أروح للدوام الساعة ٨ الصبح', task(['الدوام'], TODAY, '08:00'), { variant: 'gulf' });
add('ar', 'multilingual', 'الليلة لازم أخلص الواجب', task(['أخلص'], TODAY, '20:00'), { variant: 'gulf' });
add('ar', 'multilingual', 'عندي موعد عند الطبيب الساعة ٢ بعد الظهر', task(['الطبيب'], TODAY, '14:00'), { variant: 'gulf' });
add('ar', 'multilingual', 'بكرة أبي أراجع الفواتير', dayOnly(['الفواتير'], TOMORROW), { variant: 'gulf' });
// Bare and ambiguous hours.
add('ar', 'multilingual', 'بكرة الساعة ٨ عندي شغلة', task(['شغلة'], TOMORROW, '08:00'), { variant: 'bare-hour' });
add('ar', 'multilingual', 'ذكرني الساعة ٦ أطلع', task(['أطلع'], TODAY, '06:00'), { variant: 'bare-hour' });
add('ar', 'multilingual', 'لازم أنهي الشغل الأسبوع الجاي', nothingOrVague(['أنهي']), { variant: 'vague-week' });
add('ar', 'multilingual', 'بكرا أو بعد بكرا لازم أمر على الجيران', { type: 'task', titleKeywords: ['أمر'], localTime: null, ambiguityFlagsInclude: ['vague_time'] }, { variant: 'two-days' });
add('ar', 'multilingual', 'ذكرني أدفع الإيجار أول الشهر', nothingOrVague(['أدفع']), { variant: 'vague-month' });
add('ar', 'multilingual', 'بكرة الساعة ١٠ و ربع عندي موعد أسنان', task(['أسنان'], TOMORROW, '10:15'), { variant: 'levantine-minutes-bare-hour' });
add('ar', 'multilingual', 'يوم الجمعة الساعة ١ عندي غداء عند خالتي', task(['غداء'], '2026-09-18', '01:00'), { variant: 'levantine-bare-hour' });
add('ar', 'multilingual', 'بكرا الصبح بدي أعمل رياضة نص ساعة', task(['رياضة'], TOMORROW, '09:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'ذكرني بكرة المسا أكلم سامي', task(['أكلم'], TOMORROW, '18:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'لازم أراجع الرياضيات بكرا بعد المدرسة', dayOnly(['الرياضيات'], TOMORROW), { variant: 'levantine' });
add('ar', 'multilingual', 'بعد بكرا الساعة ٩ الصبح عندي فحص', task(['فحص'], DAY_AFTER, '09:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'ذكرني أشتري هدية لأختي بكرا', dayOnly(['هدية'], TOMORROW), { variant: 'levantine' });
add('ar', 'multilingual', 'بكرة الساعة ٥ العصر بدي أحكي مع أحمد وسامي', task(['أحكي'], TOMORROW, '17:00'), { variant: 'two-people-one-errand' });
add('ar', 'multilingual', 'اليوم الساعة ١١ بالليل لازم أرسل الإيميل', task(['أرسل'], TODAY, '23:00'), { variant: 'levantine' });
add('ar', 'multilingual', 'بكرا لازم أوصل الأولاد عالمدرسة الساعة ٧ و نص الصبح', task(['أوصل'], TOMORROW, '07:30'), { variant: 'levantine-minutes' });

// ── Hebrew: 30 cases ───────────────────────────────────────────────
add('he', 'multilingual', 'תזכיר לי מחר בשמונה להתקשר לדוד', task(['להתקשר'], TOMORROW, null, { ambiguityFlagsInclude: ['vague_time'] }));
add('he', 'multilingual', 'מחר בערב צריך לשלם את החשבון', task(['לשלם'], TOMORROW, '18:00'));
add('he', 'multilingual', 'מחר בבוקר יש לי פגישה', task(['פגישה'], TOMORROW, '09:00'));
add('he', 'multilingual', 'תזכיר לי בשעה 15:00 לשלוח את הדוח', task(['לשלוח'], TODAY, '15:00'));
add('he', 'multilingual', 'מחרתיים בשעה 9 בבוקר יש לי רופא', task(['רופא'], DAY_AFTER, '09:00'));
add('he', 'multilingual', 'צריך לקנות חלב מחר', dayOnly(['לקנות'], TOMORROW));
add('he', 'multilingual', 'מחר בלילה אני צריך לסיים את המצגת', task(['לסיים'], TOMORROW, '20:00'));
add('he', 'multilingual', 'תזכיר לי להזמין מקום ליום שישי', dayOnly(['להזמין'], '2026-09-18'));
add('he', 'multilingual', 'בשעה 7 בערב יש לי אימון', task(['אימון'], TODAY, '19:00'));
add('he', 'multilingual', 'מחר אחרי העבודה צריך לעבור בסופר', dayOnly(['לעבור'], TOMORROW));
add('he', 'multilingual', 'תזכיר לי מחר בשלוש לאסוף את הילדים', task(['לאסוף'], TOMORROW, null, { ambiguityFlagsInclude: ['vague_time'] }));
add('he', 'multilingual', 'היום בצהריים יש לי שיחה', task(['שיחה'], TODAY, '12:00'));
add('he', 'multilingual', 'מחר בשעה 8:30 בבוקר יש לי בדיקה', task(['בדיקה'], TOMORROW, '08:30'));
add('he', 'multilingual', 'צריך להחזיר את הספר לספרייה מחר', dayOnly(['להחזיר'], TOMORROW));
add('he', 'multilingual', 'תזכיר לי לשלם ארנונה בתחילת החודש', nothingOrVague(['ארנונה']));
add('he', 'multilingual', 'מחר בערב לבשל משהו לילדים', task(['לבשל'], TOMORROW, '18:00'));
add('he', 'multilingual', 'ביום רביעי בשעה 11 יש לי שיעור', task(['שיעור'], NEXT_WEDNESDAY, '11:00'));
add('he', 'multilingual', 'צריך להתקשר לבנק מחר בבוקר', task(['להתקשר'], TOMORROW, '09:00'));
add('he', 'multilingual', 'תזכיר לי מחר לקבוע תור', dayOnly(['לקבוע'], TOMORROW));
add('he', 'multilingual', 'היום בלילה לסדר את המזוודה', task(['לסדר'], TODAY, '20:00'));
add('he', 'multilingual', 'מחר בשעה 16:45 יש לי פגישה עם המורה', task(['פגישה'], TOMORROW, '16:45'));
add('he', 'multilingual', 'צריך לשלוח את הטופס עד יום חמישי', dayOnly(['לשלוח'], NEXT_THURSDAY));
add('he', 'multilingual', 'תזכיר לי בעשר בבוקר לבדוק מיילים', task(['לבדוק'], TODAY, '10:00'), { variant: 'spoken-hour' });
add('he', 'multilingual', 'מחר לקחת את האוטו לטיפול', dayOnly(['לקחת'], TOMORROW));
add('he', 'multilingual', 'היום בשעה 21:00 לצפות בהרצאה', task(['בהרצאה'], TODAY, '21:00'));
add('he', 'multilingual', 'מחר בבוקר מוקדם לרוץ', task(['לרוץ'], TOMORROW, '09:00'));
add('he', 'multilingual', 'תזכיר לי להביא מטרייה מחר', dayOnly(['להביא'], TOMORROW));
add('he', 'multilingual', 'ביום ראשון הבא בשעה 13:00 יש לי תור', task(['תור'], NEXT_SUNDAY, '13:00'));
add('he', 'multilingual', 'מחר צריך לעדכן את הקובץ', dayOnly(['לעדכן'], TOMORROW));
add('he', 'multilingual', 'היום בערב לכבס', task(['לכבס'], TODAY, '18:00'));

// ── English: 30 cases, typos and no punctuation ────────────────────
add('en', 'multilingual', 'remind me tmrw at 4pm to email the landlord', task(['email'], TOMORROW, '16:00'), { variant: 'typos' });
add('en', 'multilingual', 'need to book the dentist sometime next week', nothingOrVague(['dentist']), { variant: 'vague-week' });
add('en', 'multilingual', 'pick up the parcel tomorrow morning', task(['parcel'], TOMORROW, '09:00'));
add('en', 'multilingual', 'call the clinic tomorrow at 9', task(['clinic'], TOMORROW, '09:00'), { variant: 'bare-hour' });
add('en', 'multilingual', 'team meeting tomorrow from 14:00 to 15:00', task(['meeting'], TOMORROW, '14:00'));
add('en', 'multilingual', 'gotta renew the passport tomorrow', dayOnly(['passport'], TOMORROW), { variant: 'typos' });
add('en', 'multilingual', 'remind me at 8 tonight to call mom', task(['call'], TODAY, '20:00'));
add('en', 'multilingual', 'submit the tax report by friday 5 pm', task(['report'], '2026-09-18', '17:00'));
add('en', 'multilingual', 'buy milk', { type: 'task', titleKeywords: ['milk'], localTime: null, ambiguityFlagsInclude: ['vague_time'] });
add('en', 'multilingual', 'dentist appointment on wednesday at 11:30', task(['dentist'], NEXT_WEDNESDAY, '11:30'));
add('en', 'multilingual', 'remind me to water the plants tomorrow evening', task(['plants'], TOMORROW, '18:00'));
add('en', 'multilingual', 'need to fix the sink tomorrow', dayOnly(['sink'], TOMORROW));
add('en', 'multilingual', 'pay the electricity bill day after tomorrow at 10am', task(['electricity'], DAY_AFTER, '10:00'));
add('en', 'multilingual', 'remind me tomorrow at 6:15 pm to collect the keys', task(['keys'], TOMORROW, '18:15'));
add('en', 'multilingual', 'i have to drop the car for service thursday', dayOnly(['car'], NEXT_THURSDAY));
add('en', 'multilingual', 'remind me to send the invoice today at 4pm', task(['invoice'], TODAY, '16:00'));
add('en', 'multilingual', 'grocery run tomorrow afternoon', task(['grocery'], TOMORROW, '14:00'));
add('en', 'multilingual', 'call the insurance people tomorrow at noon', task(['insurance'], TOMORROW, '12:00'));
add('en', 'multilingual', 'remind me at 7 in the morning to take the pills', task(['pills'], TODAY, '07:00'));
add('en', 'multilingual', 'book flights next sunday at 13:00', task(['flights'], NEXT_SUNDAY, '13:00'));
add('en', 'multilingual', 'clean the kitchen tonight', task(['kitchen'], TODAY, '20:00'));
add('en', 'multilingual', 'remind me tomorrow to review the contract', dayOnly(['contract'], TOMORROW));
add('en', 'multilingual', 'meeting with the accountant at 15:45 tomorrow', task(['accountant'], TOMORROW, '15:45'));
add('en', 'multilingual', 'pls remind me to charge the laptop tonight', task(['laptop'], TODAY, '20:00'), { variant: 'typos' });
add('en', 'multilingual', 'return the library books wednesday morning', task(['library'], NEXT_WEDNESDAY, '09:00'));
add('en', 'multilingual', 'i need to call the school tomorrow at 8 am', task(['school'], TOMORROW, '08:00'));
add('en', 'multilingual', 'remind me to back up the photos tomorrow night', task(['photos'], TOMORROW, '20:00'));
add('en', 'multilingual', 'dentist tmrw 11am dont forget', task(['dentist'], TOMORROW, '11:00'), { variant: 'typos' });
add('en', 'multilingual', 'remind me to pay rent tomorrow at midnight', task(['rent'], TOMORROW, '00:00'));
add('en', 'multilingual', 'sort out the paperwork tomorrow', dayOnly(['paperwork'], TOMORROW));

// ── Code-switched: 20 cases ────────────────────────────────────────
add('mixed', 'multilingual', 'call ماما tmrw morning', task(['ماما'], TOMORROW, '09:00'));
add('mixed', 'multilingual', 'תזכיר לי to pay the ארנונה בשלוש', task(['ארנונה'], TODAY, null, { ambiguityFlagsInclude: ['vague_time'] }));
add('mixed', 'multilingual', 'Please remember to call دانيال tomorrow morning', task(['دانيال'], TOMORROW, '09:00'));
add('mixed', 'multilingual', 'meeting مع أحمد بكرة الساعة ٣ العصر', task(['أحمد'], TOMORROW, '15:00'));
add('mixed', 'multilingual', 'ذكرني call the bank بكرا الصبح', task(['bank'], TOMORROW, '09:00'));
add('mixed', 'multilingual', 'מחר בבוקר pick up the laundry', task(['laundry'], TOMORROW, '09:00'));
add('mixed', 'multilingual', 'لازم أعمل booking للفندق بكرا', dayOnly(['booking'], TOMORROW));
add('mixed', 'multilingual', 'remind me بكرة at 5pm أحكي مع سامي', task(['سامي'], TOMORROW, '17:00'));
add('mixed', 'multilingual', 'צריך לשלוח the report מחר בערב', task(['report'], TOMORROW, '18:00'));
add('mixed', 'multilingual', 'dentist بكرة الساعة ١١ الصبح', task(['dentist'], TOMORROW, '11:00'));
add('mixed', 'multilingual', 'ذكرني submit التقرير tomorrow at 9am', task(['التقرير'], TOMORROW, '09:00'));
add('mixed', 'multilingual', 'tomorrow لازم أروح للـ pharmacy', dayOnly(['pharmacy'], TOMORROW));
add('mixed', 'multilingual', 'תזכיר לי tomorrow at 16:00 לשלם', task(['לשלם'], TOMORROW, '16:00'));
add('mixed', 'multilingual', 'اتصل بـ Dr Sami بكرة الساعة ٢ بعد الظهر', task(['Sami'], TOMORROW, '14:00'));
add('mixed', 'multilingual', 'need to أجيب دوا tonight', task(['دوا'], TODAY, '20:00'));
add('mixed', 'multilingual', 'מחר at 10 בבוקר יש לי call', task(['call'], TOMORROW, '10:00'));
add('mixed', 'multilingual', 'ذكرني بكرا email المدير', dayOnly(['email'], TOMORROW));
add('mixed', 'multilingual', 'gym بكرة الصبح الساعة ٧', task(['gym'], TOMORROW, '07:00'));
add('mixed', 'multilingual', 'תזכיר לי buy מטרייה מחר', dayOnly(['מטרייה'], TOMORROW));
add('mixed', 'multilingual', 'بكرة meeting الساعة ٩ الصبح مع الفريق', task(['meeting'], TOMORROW, '09:00'));

// ── Multi-item: connectors in three languages ──────────────────────
add('ar', 'multi_item', 'بكرة الساعة ٩ الصبح عندي دكتور وبعدين الساعة ٣ العصر عندي جامعة', { type: 'task', titleKeywords: ['دكتور'], localDate: TOMORROW, localTime: '09:00' });
add('ar', 'multi_item', 'لازم أجيب خبز، وبعدها أدفع الفاتورة بكرا الصبح', { type: 'task', titleKeywords: ['خبز'], localTime: null });
add('he', 'multi_item', 'מחר בבוקר פגישה ואז בשעה 15:00 רופא', { type: 'task', titleKeywords: ['פגישה'], localDate: TOMORROW, localTime: '09:00' });
add('en', 'multi_item', 'buy groceries then call the plumber tomorrow at 3pm', { type: 'task', titleKeywords: ['groceries'], localTime: null });
add('en', 'multi_item', 'doctor at 9am, university at 2pm, then visit at 7pm', { type: 'task', titleKeywords: ['doctor'], localDate: TODAY, localTime: '09:00' });

// ── Safety: 40 non-actionable cases, shared with UC-2.6 (#166) ─────
// 12 ar
add('ar', 'safety_negative', 'مبارح شفت أحمد بالسوق', nothing('past_event'));
add('ar', 'safety_negative', 'مبارح قابلت أحمد الساعة ٧', nothing('past_event'));
add('ar', 'safety_negative', 'صباح الخير', nothing('greeting_or_chat'));
add('ar', 'safety_negative', 'كيفك شو الأخبار', nothing('greeting_or_chat'));
add('ar', 'safety_negative', 'اليوم كان يوم طويل وتعبان', nothing('informational'));
add('ar', 'safety_negative', 'حسّيت بضغط اليوم من الشغل', nothing('informational'));
add('ar', 'safety_negative', 'شو الطقس بكرا؟', nothing('question'));
add('ar', 'safety_negative', 'كيف أستخدم التطبيق؟', nothing('question'));
add('ar', 'safety_negative', 'لا تذكرني بالجيم بعد اليوم', nothing('negated_request'));
add('ar', 'safety_negative', 'مش بدي تذكير عن الفاتورة', nothing('negated_request'));
add('ar', 'safety_negative', 'أمي سألتني عن الصور', nothing('informational'));
add('ar', 'safety_negative', 'الأسعار زادت هالشهر', nothing('informational'));
// 10 he
add('he', 'safety_negative', 'אתמול ראיתי את דוד', nothing('past_event'));
add('he', 'safety_negative', 'בוקר טוב', nothing('greeting_or_chat'));
add('he', 'safety_negative', 'מה קורה', nothing('greeting_or_chat'));
add('he', 'safety_negative', 'היה לי יום ארוך', nothing('informational'));
add('he', 'safety_negative', 'אני מרגיש עייף היום', nothing('informational'));
add('he', 'safety_negative', 'מה השעה?', nothing('question'));
add('he', 'safety_negative', 'איך מוסיפים תזכורת?', nothing('question'));
add('he', 'safety_negative', 'אל תזכיר לי יותר על החדר כושר', nothing('negated_request'));
add('he', 'safety_negative', 'דוד שאל אותי על החשבון', nothing('informational'));
add('he', 'safety_negative', 'בשבוע שעבר היינו בחוף', nothing('past_event'));
// 10 en
add('en', 'safety_negative', 'i met Ahmad yesterday at 7', nothing('past_event'));
add('en', 'safety_negative', 'good morning', nothing('greeting_or_chat'));
add('en', 'safety_negative', 'hey how are you', nothing('greeting_or_chat'));
add('en', 'safety_negative', 'i had a long day today', nothing('informational'));
add('en', 'safety_negative', 'feeling pretty tired lately', nothing('informational'));
add('en', 'safety_negative', "what's the weather tomorrow?", nothing('question'));
add('en', 'safety_negative', 'how do i change the language?', nothing('question'));
add('en', 'safety_negative', "don't remind me anymore", nothing('negated_request'));
add('en', 'safety_negative', 'no need to remind me about the gym', nothing('negated_request'));
add('en', 'safety_negative', 'Maya is waiting on the invoice', nothing('informational'));
// 8 mixed / forwarded-message style
add('mixed', 'safety_negative', 'مبارح كان عندي meeting طويل', nothing('past_event'));
add('mixed', 'safety_negative', 'good morning صباح الخير', nothing('greeting_or_chat'));
add('mixed', 'safety_negative', 'אתמול היה לי long day', nothing('past_event'));
add('mixed', 'safety_negative', 'شو رأيك بالـ app؟', nothing('question'));
add('mixed', 'safety_negative', 'FWD: الاجتماع انتهى امبارح', nothing('past_event'));
add('mixed', 'safety_negative', 'FWD: the meeting was cancelled last week', nothing('past_event'));
add('mixed', 'safety_negative', 'תזכיר לי not to worry about it', nothing('negated_request'));
add('mixed', 'safety_negative', 'حسّيت tired اليوم', nothing('informational'));

/**
 * A time the sentence gestures at without naming — "next week", "start of the
 * month". No hour may be produced; whether a day can be is a judgement the
 * engines are allowed to differ on, so only the absence of a time is asserted.
 */
function nothingOrVague(titleKeywords) {
  return { type: 'task', titleKeywords, localTime: null, ambiguityFlagsInclude: ['vague_time'] };
}

writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const bySlice = {};
const byLanguage = {};
for (const row of rows) {
  bySlice[row.slice] = (bySlice[row.slice] ?? 0) + 1;
  byLanguage[row.language] = (byLanguage[row.language] ?? 0) + 1;
}
console.log(`wrote ${rows.length} cases to ${OUT}`);
console.log('  by slice:   ', JSON.stringify(bySlice));
console.log('  by language:', JSON.stringify(byLanguage));
