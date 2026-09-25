/**
 * What a fixed appointment looks like, in Arabic, Hebrew and English (L4).
 *
 * «سجّل موعد دكتور يوم الأحد» reached the review card as «يُفضّل» (should):
 * nothing knew that a doctor on a named day is not optional. The rule, read by
 * both engines — the rule-based extractor infers with it, the schema validator
 * holds the model to it:
 *
 *   an appointment (doctor, dentist, clinic, hospital, exam, test, interview,
 *   flight, court) with a fixed day or time is `high`, source `inferred`;
 *   a meeting counts only with a clock time.
 *
 * `inferred`, never `user_explicit`: it is our reading, so the review card
 * keeps its «حزرناها» chip and the user can change it in one tap.
 *
 * ── Arranging one is a task, not the appointment ──────────────────
 *
 * "Call the dentist tomorrow", «احجز موعد دكتور», «לקבוע תור לרופא» name an
 * appointment and are ordinary tasks — a phone call, a booking. Raising them
 * would be exactly the "plain task marked Must" this rule must not do, so a
 * contacting or arranging verb anywhere in the sentence declines.
 *
 * Deliberately a short list. A miss leaves the level where it always was
 * (Should, and still editable); a false hit marks a plain task as a Must.
 */

/** Things that happen at a fixed time and place and do not move. */
const APPOINTMENT = new RegExp(
  [
    /\b(?:doctor|doctor's|dr|gp|dentist|dentist's|orthodontist|clinic|hospital|appointment|appt|check-?up|physio|therapist|exam|exams|midterm|interview|flight|court|hearing)\b/.source,
    /\b(?:blood|lab|driving|eye|hearing)\s+tests?\b/.source,
    // Substrings on purpose: Arabic fuses «ال», «بال», «عال», «لل» and the
    // possessives onto the noun — «عالعيادة», «طيارتي», «بالمحكمة».
    /دكتور|دكتورة|طبيب|عيادة|عياده|عيادت|موعد|مستشفى|مشفى|امتحان|إمتحان|مقابلة|مقابله|مقابلت|طيارة|طيّارة|طياره|طيارت|رحلة|رحلت|طيران|محكمة|محكمه|تحليل دم|فحص دم/.source,
    // Hebrew prefixes (ה, ל, ב, ו, מ, ש) fuse onto the noun too: «לרופא».
    /(?:^|[\s,.،])[והבלמש]{0,3}(?:רופא|רופאה|רופאת|מרפאה|מרפאת|קופת\s+חולים|בית\s+ה?חולים|תור|בדיקת\s+דם|מבחן|בחינה|בחינת|ראיון|טיסה|טיסת|בית\s+ה?משפט)(?=$|[\s,.،?!])/.source,
  ].join('|'),
  'i',
);

/** A meeting is fixed only when it has a clock time. */
const MEETING = /\bmeeting\b|اجتماع|(?:^|[\s,.،])[והבלמש]{0,2}פגישה(?=$|[\s,.،?!])/i;

/** Contacting or arranging — a task about an appointment, not the appointment. */
const ARRANGING = new RegExp(
  [
    /\b(?:call|phone|ring|email|e-mail|text|message|book|schedule|reschedule|cancel|arrange|confirm)\b/.source,
    /\bmake\s+(?:an?\s+|the\s+)?(?:\w+\s+)?(?:appointment|appt)\b/.source,
    /احجز|أحجز|حجز|اتصل|أتصل|تصل|رن\s|رنّ|كلّم|كلم|احكي مع|ابعث|راسل|الغي|ألغي|الغ\s|اعمل موعد|أعمل موعد|اطلب موعد|أطلب موعد|آخد موعد|اخد موعد|أخذ موعد|اخذ موعد/.source,
    /(?:^|[\s,.،])(?:להתקשר|תתקשר|תתקשרי|להזמין|תזמין|לקבוע|תקבע|תקבעי|לבטל|תבטל|לשלוח|לכתוב|לתאם|תתאם)(?=$|[\s,.،])/.source,
  ].join('|'),
  'i',
);

export interface FixedTime {
  /** The sentence resolved to a day. */
  hasDay: boolean;
  /** The sentence resolved to a clock time on it. */
  hasClock: boolean;
}

/**
 * True when the sentence is an appointment with a fixed day or time, and not a
 * task about arranging one.
 */
export function isFixedAppointment(rawText: string, time: FixedTime): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  if (!time.hasDay && !time.hasClock) return false;
  if (ARRANGING.test(rawText)) return false;
  if (APPOINTMENT.test(rawText)) return true;
  return time.hasClock && MEETING.test(rawText);
}
