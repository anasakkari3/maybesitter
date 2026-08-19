/**
 * The Sprint 06 golden set: hand-written decomposition examples that #26's
 * evaluator and #27's validator must agree about.
 *
 * #26 and #27 are built in parallel and neither imports the other. Each is
 * verified against its own reading of the contracts, which is exactly how two
 * tracks end up with self-consistent, mutually incompatible ideas of what a
 * correct decomposition is — both suites green, the disagreement invisible.
 * Sprints 02-05 each needed a cross-track run to catch that class of drift.
 * This file is the shared ground truth that run compares them on.
 *
 * Spans are located by `indexOf` rather than written as literal offsets. Two
 * reasons: hand-counting UTF-16 offsets across Arabic, Hebrew and Latin text is
 * a source of silent error, and deriving them makes the fixture self-checking —
 * `span()` throws at import if a snippet is absent or ambiguous, so a fixture
 * that no longer matches its own source text cannot be loaded at all.
 *
 * Every row is `synthetic`. Nobody has reviewed these; they are written to
 * exercise the pipeline, and the corpus of human-reviewed examples ships empty
 * for the reason Sprint 04's judgment corpus did — a dataset that says it is
 * reviewed when it is not corrupts every number computed from it afterwards.
 */

import type {
  DecompositionExample,
  DecompositionStepProposal,
  SourceSpan,
} from '../../src/contracts/v1/decompositionContracts.ts';

/**
 * Locate `snippet` in `source` and return the span selecting it.
 *
 * Throws when the snippet is missing or occurs more than once: an ambiguous
 * snippet would silently pin the span to the first match, which is a coin flip
 * dressed as ground truth.
 */
export function span(source: string, snippet: string): SourceSpan {
  const start = source.indexOf(snippet);
  if (start < 0) {
    throw new Error(`golden fixture: snippet not found in source: ${JSON.stringify(snippet)}`);
  }
  if (source.indexOf(snippet, start + 1) >= 0) {
    throw new Error(`golden fixture: snippet is ambiguous in source: ${JSON.stringify(snippet)}`);
  }
  return { start, end: start + snippet.length, text: snippet };
}

interface StepSeed {
  readonly id: string;
  readonly snippet: string;
  readonly timing?: string;
  readonly owner?: string;
  readonly dependsOn?: readonly string[];
}

function steps(source: string, seeds: readonly StepSeed[]): DecompositionStepProposal[] {
  return seeds.map((seed) => ({
    stepId: seed.id,
    title: seed.snippet,
    sourceSpans: [span(source, seed.snippet)],
    inferred: false,
    dependsOn: (seed.dependsOn ?? []).map((dependsOnStepId) => ({
      dependsOnStepId,
      kind: 'temporal' as const,
    })),
    statedTiming: seed.timing ?? null,
    statedOwner: seed.owner ?? null,
  }));
}

function multiStep(
  exampleId: string,
  locale: string,
  sourceText: string,
  seeds: readonly StepSeed[],
  note: string,
): DecompositionExample {
  return {
    exampleId,
    locale,
    sourceText,
    label: 'multi_step',
    provenance: 'synthetic',
    expectedSteps: steps(sourceText, seeds),
    note,
  };
}

function single(
  exampleId: string,
  locale: string,
  sourceText: string,
  label: 'atomic' | 'do_not_split',
  note: string,
): DecompositionExample {
  return { exampleId, locale, sourceText, label, provenance: 'synthetic', expectedSteps: [], note };
}

/* ── Multi-step ──────────────────────────────────────────────────── */

const EN_WEDDING = multiStep(
  'en-multi-wedding',
  'en',
  'Book the venue by Friday, then send the invitations and order the cake.',
  [
    { id: 's1', snippet: 'Book the venue', timing: 'by Friday' },
    { id: 's2', snippet: 'send the invitations', dependsOn: ['s1'] },
    { id: 's3', snippet: 'order the cake' },
  ],
  'Ordinary three-way split. "then" is a real sequencing marker, so s2 waits on s1; "and" between s2 and s3 orders nothing, and asserting a dependency there would invent one.',
);

const AR_WEDDING = multiStep(
  'ar-multi-wedding',
  'ar',
  'احجز القاعة ثم أرسل الدعوات واطلب الكعكة.',
  [
    { id: 's1', snippet: 'احجز القاعة' },
    { id: 's2', snippet: 'أرسل الدعوات', dependsOn: ['s1'] },
    { id: 's3', snippet: 'اطلب الكعكة' },
  ],
  'The third conjunction is the clitic "و" prefixed onto "اطلب" — there is no whitespace to split on. A tokenizer that splits on separate conjunction words misses this boundary entirely, and one that strips the prefix must leave it outside the span or the span stops matching its own text.',
);

const HE_EVENT = multiStep(
  'he-multi-event',
  'he',
  'תזמין את האולם, תשלח את ההזמנות ותזמין עוגה.',
  [
    { id: 's1', snippet: 'תזמין את האולם' },
    { id: 's2', snippet: 'תשלח את ההזמנות' },
    { id: 's3', snippet: 'תזמין עוגה' },
  ],
  'Same prefixed-conjunction shape in Hebrew ("ותזמין"), plus a repeated verb: "תזמין" occurs twice, so a step located by verb alone would bind to the wrong clause. Spans are increasing in storage order even though the text renders right-to-left.',
);

const AR_EN_INVOICE = multiStep(
  'ar-en-multi-invoice',
  'ar-EN',
  'أرسل الـ invoice للعميل وبعدها اعمل follow up يوم الاثنين',
  [
    { id: 's1', snippet: 'أرسل الـ invoice للعميل' },
    { id: 's2', snippet: 'اعمل follow up', timing: 'يوم الاثنين', dependsOn: ['s1'] },
  ],
  'Code-switching mid-sentence: each step spans both scripts, so a span that stops at the first direction change would cut "invoice" and "follow up" off their own verbs. The timing is carried verbatim; resolving "يوم الاثنين" to a date is Capture\'s job and computing one here is the invention #26 measures.',
);

/* ── Atomic: genuinely one action ────────────────────────────────── */

const EN_DENTIST = single(
  'en-atomic-dentist',
  'en',
  'Call the dentist.',
  'atomic',
  'One verb, one object, no conjunction. The baseline that must not produce a one-step "decomposition".',
);

const AR_MOTHER = single(
  'ar-atomic-mother',
  'ar',
  'اتصل بأمي.',
  'atomic',
  'Arabic single action, no conjunction present at all.',
);

const AR_EN_APPOINTMENT = single(
  'ar-en-atomic-appointment',
  'ar-EN',
  'ذكّرني بـ meeting مع Dr. Levi يوم 12/3',
  'atomic',
  'Mixed script and a Latin abbreviation with a period. "Dr." must not be read as a sentence boundary, and digits inside RTL text must not shift the offsets of anything around them.',
);

/* ── Do-not-split: a conjunction that is not a step boundary ─────── */

const EN_TERMS = single(
  'en-nosplit-terms',
  'en',
  'Review the terms and conditions before Friday.',
  'do_not_split',
  '"and" sits inside the noun phrase "terms and conditions". A splitter keyed on the conjunction produces "Review the terms" and "conditions before Friday" — two steps the user never described, the second not even an action.',
);

const AR_TERMS = single(
  'ar-nosplit-terms',
  'ar',
  'راجع الشروط والأحكام قبل الجمعة.',
  'do_not_split',
  'The same trap with the Arabic clitic: "والأحكام" carries the conjunction as a prefix inside a fixed noun phrase, so the very handling that makes ar-multi-wedding splittable must not fire here.',
);

const HE_TERMS = single(
  'he-nosplit-terms',
  'he',
  'לבדוק את התנאים וההגבלות לפני יום שישי.',
  'do_not_split',
  'Hebrew equivalent: "וההגבלות" is a prefixed conjunction inside one noun phrase.',
);

const EN_THANKS = single(
  'en-nosplit-thanks',
  'en',
  'Send a thank-you note to Sarah and Omar.',
  'do_not_split',
  'One action with two recipients. The conjunction joins objects, not steps; splitting invents a second errand and would let a step claim an owner the sentence never assigned.',
);

/* ── The set ─────────────────────────────────────────────────────── */

/**
 * Eleven examples across four locales.
 *
 * Deliberately weighted toward `do_not_split`: over-splitting is the failure
 * mode that survives a green suite, because a splitter that fires on every
 * conjunction scores well on the multi-step rows and its damage only shows on
 * the rows where firing is wrong.
 */
export const DECOMPOSITION_GOLDEN: readonly DecompositionExample[] = Object.freeze([
  EN_WEDDING,
  AR_WEDDING,
  HE_EVENT,
  AR_EN_INVOICE,
  EN_DENTIST,
  AR_MOTHER,
  AR_EN_APPOINTMENT,
  EN_TERMS,
  AR_TERMS,
  HE_TERMS,
  EN_THANKS,
]);

export function goldenByLabel(label: DecompositionExample['label']): readonly DecompositionExample[] {
  return DECOMPOSITION_GOLDEN.filter((example) => example.label === label);
}

export function goldenById(exampleId: string): DecompositionExample {
  const found = DECOMPOSITION_GOLDEN.find((example) => example.exampleId === exampleId);
  if (!found) throw new Error(`golden fixture: no example ${exampleId}`);
  return found;
}
