/**
 * What `looksLikeEmail` must answer, decided by hand (UC-3.8, #192 step 8).
 *
 * ── This list is the contract, not either implementation ─────────
 *
 * There are two detectors — `lib/services/share/emailDetector.ts` on the server
 * and `mobile/src/features/share/emailTextDetector.ts` in the app — because the
 * RN workspace cannot import across the boundary. Two copies of a decision
 * drift, and the drift is silent: the phone would route a paste one way and the
 * server would read it another, and the only symptom would be a user's school
 * email coming back as one run-on commitment.
 *
 * So neither detector grades itself. `expected` below is written out by a
 * person; `tests/share/exportEmailDetectorCases.test.ts` asserts the backend
 * against it *and* writes it to `mobile/src/features/share/__fixtures__/`, and
 * the RN suite asserts the app's detector against the same file. Changing one
 * implementation without the other fails on whichever side was not changed.
 *
 * ── The negative cases are the point ─────────────────────────────
 *
 * A detector that answers "email" to everything passes every positive case and
 * routes a typed sentence through a cleaner that will cut it off at the word
 * "Thanks". Half of these are things that must **not** be read as email.
 */

export interface EmailDetectorCase {
  /** A stable name, so a failure says which case rather than which index. */
  readonly name: string;
  readonly text: string;
  readonly expected: boolean;
  /** Why this is the answer. Carried into the exported fixture. */
  readonly because: string;
}

export const EMAIL_DETECTOR_CASES: readonly EmailDetectorCase[] = [
  {
    name: 'gmail_headers_en',
    text: 'From: Office <office@school.example>\nSubject: Consent form\nDate: Thu, 10 Sep 2026 09:14:00 +0300\n\nDear Anas,\n\nPlease return the form by Monday.\n\nBest regards,\nDana',
    expected: true,
    because: 'headers, an address, and a greeting with a sign-off — three of four',
  },
  {
    name: 'headers_without_an_address',
    text: 'From: The office\nSubject: Consent form\n\nPlease return the form by Monday.',
    expected: false,
    because: 'headers alone are one signal; a pasted note can start "From: the office"',
  },
  {
    name: 'headers_with_an_address',
    text: 'From: office@school.example\nSubject: Consent form\n\nPlease return the form by Monday.',
    expected: true,
    because: 'headers and an address are two',
  },
  {
    name: 'arabic_headers_and_address',
    text: 'من: إدارة المدرسة <idara@madrasa.example>\nالموضوع: استمارة الرحلة\n\nلازم ترجّع الاستمارة قبل الاثنين.',
    expected: true,
    because: 'the Arabic header names are headers',
  },
  {
    name: 'hebrew_headers_and_signoff',
    text: 'מאת: מיכל בר\nנושא: דוח רבעוני\n\nשלום אנס,\n\nצריך להעביר את הדוח עד יום חמישי.\n\nבברכה,\nמיכל',
    expected: true,
    because: 'Hebrew headers, and a greeting with a sign-off',
  },
  {
    name: 'english_reply_marker',
    text: 'Sure, I will bring it.\n\nOn Tue, 8 Sep 2026 at 10:02, Sami <sami@example.com> wrote:\n> Can you bring the form?',
    expected: true,
    because: 'an "On … wrote:" line and an address',
  },
  {
    name: 'arabic_reply_marker',
    text: 'تمام بجيبها.\n\nفي ٨ أيلول ٢٠٢٦، سامي <sami@example.com> كتب:\n> بتقدر تجيب الاستمارة؟',
    expected: true,
    because: 'the Arabic «كتب:» reply marker and an address',
  },
  {
    name: 'hebrew_reply_marker',
    text: 'בסדר.\n\nב-7 בספטמבר 2026, יוסי <yossi@work.example> כתב:\n> אפשר לדחות?',
    expected: true,
    because: 'the Hebrew «כתב:» reply marker and an address',
  },
  {
    name: 'outlook_original_message',
    text: 'Noted.\n\n-----Original Message-----\nFrom: Sami Haddad\nSent: Monday, 7 September 2026 09:00\nSubject: Invoice\n\nPlease transfer the deposit.',
    expected: true,
    because: 'the Outlook divider and the header block under it',
  },
  {
    name: 'gmail_forward',
    text: '---------- Forwarded message ---------\nFrom: Office <office@school.example>\nSubject: Sports day\n\nBring a hat on Tuesday.',
    expected: true,
    because: 'the forward divider and headers',
  },
  {
    name: 'a_typed_sentence',
    text: 'Remind me to bring the consent form on Monday',
    expected: false,
    because: 'no signal at all — the ordinary capture this must not touch',
  },
  {
    name: 'an_address_in_a_sentence',
    text: 'Email the office at office@school.example about the trip and let me know',
    expected: false,
    because: 'an address alone is one signal; people write addresses in notes',
  },
  {
    name: 'a_note_that_says_thanks',
    text: 'Hi Dana,\n\nSee you at the gate on Monday.\n\nThanks',
    expected: false,
    because: 'a greeting with a sign-off is one signal; that is also how a text message reads',
  },
  {
    name: 'a_note_that_says_thanks_with_an_address',
    text: 'Hi Dana,\n\nSend it to office@school.example when you can.\n\nThanks',
    expected: true,
    because: 'greeting with sign-off, and an address — two',
  },
  {
    name: 'arabic_note_with_signoff_and_address',
    text: 'أهلاً دانا،\n\nابعتيلي الاستمارة على idara@madrasa.example.\n\nمع التحية،',
    expected: true,
    because: 'the Arabic sign-off carries its Arabic comma, and there is an address',
  },
  {
    name: 'a_whatsapp_export',
    text: '[10/09/2026, 09:14:12] Dana: Please bring the form\n[10/09/2026, 09:15:01] Anas: Will do',
    expected: false,
    because: 'no signal — #189 owns this, and this must not claim it',
  },
  {
    name: 'a_shopping_list',
    text: 'milk\nbread\nform for school\n',
    expected: false,
    because: 'nothing here is a signal, and a cleaner would cut it',
  },
  {
    /*
     * The address signal, carried by a domain nobody would put on a shortlist.
     *
     * Added because a mutation proved the list needed it: narrowing the
     * address pattern to `com|org|example|co.il` left every other case
     * answering exactly what it answered before, so the two detectors could
     * have drifted apart in silence. An address is a shape, not a list of
     * top-level domains, and this is the case that says so.
     */
    name: 'headers_with_an_uncommon_top_level_domain',
    text: 'From: Office <office@greenfield.education>\nSubject: Consent form\n\nPlease return the form by Monday.',
    expected: true,
    because: 'headers and an address — and .education is as much an address as .com',
  },
  {
    name: 'a_long_country_address_in_a_reply',
    text: 'On Tue, 8 Sep 2026 at 10:02, Dana Levy <dana@greenfield.sch.uk>\nwrote:\n> Can you send the form?',
    expected: true,
    because: 'a reply marker and an address, neither of which is a common top-level domain',
  },
  {
    name: 'empty',
    text: '',
    expected: false,
    because: 'there is nothing to classify',
  },
];
