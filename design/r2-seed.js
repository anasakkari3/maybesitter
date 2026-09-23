// MaybeSitter Round-2 sample persona · Layla — product manager, part-time master's student, mother of Adam (6). Amman, local time.
// "Today" is Tuesday 22 September 2026, 15:42. Day numbers are offsets from today (0 = today, -1 = yesterday).
export const NOW = { y: 2026, mo: 8, d: 22, dow: 2, h: 15, mi: 42, tz: "Asia/Amman" };
export const PERSONA = { name: { ar: "ليلى", en: "Layla", he: "לילה" }, email: "layla.k@gmail.com", provider: "google" };

const T = (ar, en, he) => ({ ar, en, he });

export const COMMITMENTS = [
  { id: "c1", title: T("ابعت تقرير الربع لسامي", "Send the Q3 report to Sami", "לשלוח את דוח הרבעון לסמי"), day: 0, h: 17, m: 0, dur: 45, imp: "must", status: "active", cat: "work", src: "capture", srcDate: T("أمس", "yesterday", "אתמול"), deadline: true },
  { id: "c3", title: T("مراجعة محاضرة الإحصاء 4", "Review statistics lecture 4", "לחזור על הרצאה 4 בסטטיסטיקה"), day: 0, h: 12, m: 0, dur: 60, imp: "should", status: "done", cat: "study", src: "capture" },
  { id: "c4", title: T("استلام آدم من المدرسة", "Pick up Adam from school", "לאסוף את אדם מבית הספר"), day: 0, h: 15, m: 30, dur: 30, imp: "must", status: "done", cat: "family", src: "routine", fixed: true },
  { id: "c5", title: T("اتصل بالدكتور احجز لآدم", "Call the dentist to book Adam", "להתקשר לרופא השיניים לקבוע לאדם"), day: 0, h: null, m: 0, dur: 10, imp: "should", status: "active", cat: "health", src: "capture" },
  { id: "c6", title: T("تمارين العلاج الطبيعي", "Physio exercises", "תרגילי פיזיותרפיה"), day: 0, h: 20, m: 0, dur: 20, imp: "nice", status: "active", cat: "health", src: "routine" },
  { id: "c7", title: T("أشتري هدية لأمي", "Buy a gift for mom", "לקנות מתנה לאמא"), day: 1, h: null, m: 0, dur: null, imp: "nice", status: "active", cat: "family", src: "capture" },
  { id: "c11", title: T("قهوة مع رنا", "Coffee with Rana", "קפה עם רנא"), day: 2, h: 17, m: 30, dur: 60, imp: "nice", status: "active", cat: "social", src: "capture" },
  { id: "c8", title: T("موعد تجديد الجواز", "Passport renewal appointment", "תור לחידוש דרכון"), day: 3, h: 10, m: 0, dur: 60, imp: "must", status: "active", cat: "errands", src: "share", srcName: "civil-status.gov.jo" },
  { id: "c12", title: T("مخطط مقترح الرسالة", "Thesis proposal outline", "מתווה הצעת התזה"), day: 4, h: null, m: 0, dur: 90, imp: "should", status: "active", cat: "study", src: "capture" },
  { id: "c10", title: T("تحويل الإيجار", "Rent transfer", "העברת שכר דירה"), day: 6, h: 9, m: 0, dur: 15, imp: "must", status: "active", cat: "finance", src: "share", srcName: "rental-contract.pdf" },
  { id: "c9", title: T("امتحان الإحصاء النصفي", "Statistics midterm", "מבחן אמצע בסטטיסטיקה"), day: 9, h: 9, m: 0, dur: 120, imp: "must", status: "active", cat: "study", src: "capture", deadline: true },
  { id: "c2", title: T("الجيم", "Gym", "חדר כושר"), day: -1, h: 7, m: 0, dur: 60, imp: "nice", status: "done", cat: "health", src: "routine" },
  { id: "c13", title: T("أدفع فاتورة الكهرباء", "Pay the electricity bill", "לשלם חשבון חשמל"), day: -1, h: null, m: 0, dur: 5, imp: "should", status: "postponed", cat: "finance", src: "capture", movedTo: 1 },
];

// Busy blocks read from the calendar — times only, titles never shown.
export const BUSY = [
  { day: 0, h: 9, m: 30, dur: 30 }, { day: 0, h: 11, m: 0, dur: 60 }, { day: 0, h: 14, m: 0, dur: 30 },
  { day: 1, h: 10, m: 0, dur: 90 }, { day: 1, h: 13, m: 0, dur: 60 },
  { day: 2, h: 9, m: 30, dur: 30 }, { day: 2, h: 15, m: 0, dur: 60 },
  { day: 3, h: 9, m: 0, dur: 60 }, { day: 5, h: 12, m: 0, dur: 120 },
];

// Today's plan as the morning proposal (generated 07:00). Items reference commitments.
export const PLAN = {
  generatedAt: "07:00",
  items: [
    { cid: "c3", h: 12, m: 0, movable: true },
    { cid: "c5", h: 13, m: 15, movable: true },
    { cid: "c4", h: 15, m: 30, movable: false, from: "routine" },
    { cid: "c1", h: 16, m: 0, movable: true },
    { cid: "c6", h: 20, m: 0, movable: true },
  ],
  kept: [ { cid: "c7", reason: "planReasonNoLength" }, { cid: "c12", reason: "planReasonNoRoom" } ],
  why: [
    { code: "whyFixed", items: T("استلام آدم 15:30", "Pick up Adam 15:30", "לאסוף את אדם 15:30") },
    { code: "whyDue", cid: "c1", t: "17:00" },
    { code: "whyEnergy", level: "energySteady", when: "noonW" },
    { code: "whyQuiet", t: "21:30" },
    { code: "whyLocal", tz: "Asia/Amman" },
  ],
  regenLeft: 2,
};

export const NEXT = { cid: "c1", evidence: ["evDue24", "evMust", "evFits"], alt: "c5" };

export const MEMORY = [
  { id: "m1", text: T("بتنام حوالي 23:30", "You sleep around 23:30", "הולכת לישון בסביבות 23:30"), group: "told", src: "srcOnboarding", sure: "sureCertain", recorded: T("8 سبتمبر", "8 Sept", "8 בספטמבר"), uses: ["usedByPlan", "usedByReminders"], kept: "keptUntilChanged" },
  { id: "m2", text: T("بتركّز أحسن من 9 لـ 13", "You focus best from 9 to 13", "מתרכזת הכי טוב מ-9 עד 13"), group: "told", src: "srcYou", sure: "sureCertain", recorded: T("8 سبتمبر", "8 Sept", "8 בספטמבר"), uses: ["usedByPlan"], kept: "keptUntilChanged" },
  { id: "m3", text: T("آدم بيخلص مدرسة 15:30 كل يوم", "Adam finishes school at 15:30 every day", "אדם מסיים בית ספר ב-15:30 כל יום"), group: "told", src: "srcCapture", sure: "sureFairly", recorded: T("14 سبتمبر", "14 Sept", "14 בספטמבר"), uses: ["usedByPlan", "usedByNext"], kept: "keptUntilChanged" },
  { id: "m4", text: T("بتفضّل تذكيرات خفيفة مع متابعة", "You prefer gentle reminders with a follow-up", "מעדיפה תזכורות עדינות עם מעקב"), group: "told", src: "srcOnboarding", sure: "sureCertain", recorded: T("8 سبتمبر", "8 Sept", "8 בספטמבר"), uses: ["usedByReminders"], kept: "keptUntilChanged" },
  { id: "m5", text: T("غالباً بتخلّص أشغالك بين 10:00 و13:00", "You usually finish things between 10:00 and 13:00", "בדרך כלל מסיימת דברים בין 10:00 ל-13:00"), group: "noticed", src: "srcNoticed", sure: "sureFairly", recorded: T("20 سبتمبر", "20 Sept", "20 בספטמבר"), uses: ["usedByPlan", "usedByNext"], kept: T("20 ديسمبر", "20 Dec", "20 בדצמבר"), evidence: { days: 30, total: 12, matching: 9, range: "10:00–13:00" } },
  { id: "m6", text: T("كتير بتأجّل الأشياء اللي بعد 20:00", "You often push back things after 20:00", "לעיתים קרובות דוחה דברים אחרי 20:00"), group: "suggested", src: "srcNoticed", sure: "sureNot", recorded: T("اليوم", "today", "היום"), uses: [], evidence: { days: 14, total: 6, matching: 4, range: "20:00–22:00" } },
];

export const ACTIVITY = [
  { kind: "kCompleted", cid: "c4", when: "15:35", day: 0 },
  { kind: "kCompleted", cid: "c3", when: "12:50", day: 0 },
  { kind: "kCaptured", cid: "c1", when: "18:20", day: -1 },
  { kind: "kPostponed", cid: "c13", when: "17:05", day: -1, to: 1 },
  { kind: "kCompleted", cid: "c2", when: "08:05", day: -1 },
  { kind: "kPlanAccepted", when: "07:40", day: -1 },
  { kind: "kConfirmed", cid: "c8", when: "20:12", day: -2 },
  { kind: "kReminderAck", cid: "c8", when: "09:00", day: -2 },
];
export const ANSWERS = [
  { d: "dAccept", cid: "c3", day: 0, when: "11:58" },
  { d: "dDefer", cid: "c5", day: -1, when: "16:10" },
  { d: "dDismiss", cid: "c7", day: -2, when: "19:30" },
  { d: "dEdit", cid: "c1", day: -1, when: "18:25" },
];
export const WEEK_STATS = { done: 4, planned: 2, kept: 3 };
export const MOMENTS = [ { k: "mFirstPlan", date: T("15 سبتمبر", "15 Sept", "15 בספטמבר") }, { k: "mDone10", date: T("19 سبتمبر", "19 Sept", "19 בספטמבר") } ];

// Something another app handed over: a PDF rental contract with two dates inside.
export const SHARE = {
  kind: "pdf", name: "rental-contract.pdf", size: 412, app: "Files",
  proposals: [
    { id: "s1", title: T("تحويل الإيجار", "Rent transfer", "העברת שכר דירה"), day: 6, h: 9, m: 0, imp: "must", cat: "finance" },
    { id: "s2", title: T("تجديد عقد الإيجار", "Renew the rental contract", "לחדש את חוזה השכירות"), day: 38, h: null, m: 0, imp: "should", cat: "finance" },
  ],
};
export const SHARE_LINK = { kind: "link", name: "civil-status.gov.jo/appointments", app: "Safari", proposals: [ { id: "s3", title: T("موعد تجديد الجواز", "Passport renewal appointment", "תור לחידוש דרכון"), day: 3, h: 10, m: 0, imp: "must", cat: "errands" } ] };

export const FEEDS = [ { id: "f1", name: T("تقويم الجامعة", "University calendar", "יומן האוניברסיטה"), updated: T("قبل ساعة", "an hour ago", "לפני שעה"), deadlines: 2, busy: 6, error: false } ];
export const CLUBS = [ { id: "k1", name: "Al-Faisaly", following: true }, { id: "k2", name: "Al-Wehdat", following: false }, { id: "k3", name: "Real Madrid", following: false } ];

export const ONBOARDING_FACTS = [
  T("بتشتغل مديرة منتج", "You work as a product manager", "עובדת כמנהלת מוצר"),
  T("بتدرس ماستر بالمسا", "You study for a master's in the evenings", "לומדת לתואר שני בערבים"),
  T("عندك ولد بالمدرسة", "You have a child at school", "יש לך ילד בבית הספר"),
  T("بتحاول تلاقي وقت للجيم", "You are trying to find time for the gym", "מנסה למצוא זמן לחדר כושר"),
];
