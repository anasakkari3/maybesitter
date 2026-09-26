/**
 * The appointment nouns, in one place (L4; shared with the phone since CL5a).
 *
 * The extractor reads these as "what follows «سجّل» / «תרשום לי» is itself a
 * commitment" (`captureCommand.ts`), and the appointment rule names the same
 * things to the model (`ollamaExtractor.ts`: doctor, dentist, clinic, hospital,
 * exam, interview, flight, court, a meeting). The phone reads them to decide
 * which of the person's commitments is a meeting or an appointment worth
 * offering «حضّرني» on (`mobile/src/features/meetings/prepTargets.ts`).
 *
 * Plain strings and nothing else, on purpose: the app bundles this file
 * (`mobile/metro.config.js` watches this directory and no other part of
 * `src/extraction`), so it must not compile a regular expression Hermes might
 * read differently from Node, or pull in anything from the server.
 *
 * Arabic and Hebrew are bare nouns: each reader adds the prefixes its own
 * sentences need (the article, «و», «ב»…) and its own word edges.
 */
export const APPOINTMENT_NOUNS = {
  ar: [
    'موعد', 'موعدي', 'دكتور', 'دكتورة', 'طبيب', 'طبيبة', 'عيادة', 'عياده', 'مستشفى',
    'امتحان', 'إمتحان', 'مقابلة', 'مقابله', 'طيارة', 'طيارتي', 'طيران', 'محكمة', 'محكمه',
    'جلسة', 'اجتماع', 'ميتنغ', 'ميتينغ', 'فحص', 'تحليل',
  ],
  he: ['תור', 'פגישה', 'מבחן', 'בחינה', 'ראיון', 'טיסה', 'דיון'],
  en: [
    'appointment', 'appt', 'doctor', 'dentist', 'clinic', 'hospital', 'exam', 'interview',
    'flight', 'court', 'meeting',
  ],
} as const;
