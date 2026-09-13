/**
 * Words that mean a suggestion must be thrown away (UC-2.7b, #168).
 *
 * ── This is the second line, not the first ───────────────────────
 *
 * The prompt already tells the model not to extract health conditions,
 * diagnoses, medication, mental health, religion, ethnicity, sexual
 * orientation, political views or finances. This exists because a prompt is a
 * request and a filter is a rule, and the thing being filtered is the category
 * of fact that does real harm when a product writes it down about somebody and
 * shows it back to them.
 *
 * ── Deliberately blunt ───────────────────────────────────────────
 *
 * It over-matches, and that is the trade being made. "I want to run a
 * marathon" survives; "I want to stop taking my pills" does not, and neither
 * does an innocent sentence that happens to contain «دواء». Losing a
 * legitimate fitness goal costs the user one manual entry. Storing "has ADHD,
 * takes Ritalin" costs them something they cannot take back.
 *
 * ── Substring matching, on purpose ───────────────────────────────
 *
 * Arabic and Hebrew are agglutinative enough that a word-boundary match misses
 * the common forms — «بالدواء», «התרופות» — so matching is on the normalised
 * substring. For Latin script that risks the Scunthorpe problem, so those
 * terms are matched on word boundaries instead. The two scripts get the rule
 * that actually works for them rather than one rule that half-works for both.
 */

/** Latin-script terms, matched on word boundaries. */
const LATIN_TERMS: readonly string[] = [
  // Diagnoses and conditions.
  'adhd', 'add', 'autism', 'autistic', 'asperger', 'bipolar', 'schizophreni',
  'depression', 'depressed', 'anxiety', 'ptsd', 'ocd', 'diabetes', 'diabetic',
  'epilepsy', 'cancer', 'hiv', 'aids', 'disorder', 'diagnosis', 'diagnosed',
  'syndrome', 'chronic', 'disability', 'disabled',
  // Care and medication.
  'therapy', 'therapist', 'psychiatr', 'psycholog', 'counsell', 'counsel',
  'medication', 'medicine', 'prescription', 'prescribed', 'antidepressant',
  'ritalin', 'adderall', 'prozac', 'xanax', 'insulin', 'chemo', 'dosage',
  'clinic', 'hospital', 'surgery', 'treatment',
  // Religion.
  'muslim', 'islam', 'christian', 'jewish', 'judaism', 'orthodox', 'atheist',
  'religious', 'religion', 'church', 'mosque', 'synagogue', 'ramadan',
  'shabbat', 'kosher', 'halal', 'pray', 'prayer',
  // Ethnicity, orientation, politics.
  'arab', 'jew', 'palestinian', 'israeli', 'ethnic', 'race', 'racial',
  'gay', 'lesbian', 'bisexual', 'transgender', 'queer', 'sexuality',
  'political', 'politics', 'vote', 'voting', 'party', 'zionist',
  // Money.
  'salary', 'wage', 'debt', 'loan', 'mortgage', 'bankrupt', 'income',
  'overdraft', 'benefits', 'welfare', 'unemployed',
];

/** Arabic and Hebrew terms, matched as substrings. */
const RTL_TERMS: readonly string[] = [
  // Arabic — health and care.
  'دواء', 'أدوية', 'ادوية', 'علاج', 'طبيب', 'مستشفى', 'عيادة', 'تشخيص',
  'اكتئاب', 'قلق', 'مرض', 'مريض', 'سكري', 'سرطان', 'نفسي', 'معالج',
  'وصفة', 'جرعة', 'عملية', 'إعاقة', 'اعاقة',
  // Arabic — religion, identity, politics, money.
  'صلاة', 'مسجد', 'كنيسة', 'صيام', 'رمضان', 'حلال', 'دين', 'مسلم', 'مسيحي',
  'يهودي', 'عربي', 'سياسة', 'انتخاب', 'حزب',
  'راتب', 'دين مالي', 'قرض', 'ديون', 'بطالة',
  // Hebrew — health and care.
  'תרופה', 'תרופות', 'טיפול', 'רופא', 'בית חולים', 'מרפאה', 'אבחון',
  'דיכאון', 'חרדה', 'מחלה', 'חולה', 'סוכרת', 'סרטן', 'נפשי', 'מטפל',
  'מרשם', 'מנה', 'ניתוח', 'נכות',
  // Hebrew — religion, identity, politics, money.
  'תפילה', 'בית כנסת', 'כנסייה', 'צום', 'כשר', 'שבת', 'דת', 'מוסלמי',
  'נוצרי', 'יהודי', 'ערבי', 'פוליטי', 'בחירות', 'מפלגה',
  'משכורת', 'חוב', 'הלוואה', 'משכנתא', 'אבטלה',
];

/**
 * Normalises for matching: lowercase, and Arabic diacritics and tatweel
 * removed so «دَواء» and «دواء» are the same word.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا');
}

const LATIN_PATTERN = new RegExp(`\\b(${LATIN_TERMS.join('|')})`, 'i');

/**
 * The term that made this text sensitive, or null.
 *
 * Returns the term rather than a boolean so a test failure names what matched,
 * and so a caller can log *which category* fired without logging the content.
 */
export function sensitiveTermIn(text: string): string | null {
  if (typeof text !== 'string' || text === '') return null;
  const normalised = normalise(text);

  const latin = LATIN_PATTERN.exec(normalised);
  if (latin) return latin[1] ?? null;

  for (const term of RTL_TERMS) {
    if (normalised.includes(normalise(term))) return term;
  }
  return null;
}

export function isSensitive(text: string): boolean {
  return sensitiveTermIn(text) !== null;
}

/** Exposed so a test can assert the list covers all three languages. */
export const SENSITIVE_TERM_COUNT = LATIN_TERMS.length + RTL_TERMS.length;
