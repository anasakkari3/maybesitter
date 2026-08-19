/**
 * Validation of a labelled decomposition example (Sprint 06, issue #26).
 *
 * This is the evaluator's half of the shared violation vocabulary. #27's
 * validator refuses proposals carrying these codes; this module counts them to
 * score a dataset. Both were written in parallel against
 * `DecompositionViolationCode`, which is why the codes live in the contract and
 * neither track names its own: two self-consistent, mutually incompatible ideas
 * of "a correct decomposition" would both pass their own suites.
 *
 * ── UNSOURCED_STEP has two shapes ───────────────────────────────────
 *
 * A step is unsourced when it cites no span and does not admit to being
 * inferred, **and** when it cites spans that do not source its `title`. The
 * second is the one a checker forgets, because every other rule here
 * interrogates the span and none interrogates the claim the span is offered in
 * support of: a provider returning a perfect citation of "Book the venue" under
 * the title "Wire $9,000 to account 12345" passes exactness, range, overlap,
 * timing and owner. #27 found that hole from the adapter side; the code is
 * shared, so the check has to be too, or the evaluator would score a corpus
 * clean that the validator rejects.
 *
 * ── Exactness is computed, never trusted ────────────────────────────
 *
 * `SPAN_MISMATCH` is decided by `sourceText.slice(start, end) !== span.text`.
 * The obvious shortcut — believe `span.text`, since the producer wrote it — is
 * the one thing that must not happen: a forged span is exactly a span whose
 * carried text disagrees with the offsets, and a validator that reads the text
 * back off the span cannot see the forgery it exists to catch. `text` is
 * carried so the claim is checkable; skipping the check makes carrying it
 * pointless.
 *
 * ── Out of range is checked before mismatch ─────────────────────────
 *
 * `String.prototype.slice` clamps out-of-bounds indices instead of throwing, so
 * an unchecked span reaching past the end of the text produces a *shorter*
 * slice and would fire `SPAN_MISMATCH` as well. Two codes for one defect sends
 * a maintainer looking for a text error where the real problem is an offset, so
 * a span that is out of range is reported once and not examined further.
 *
 * ── Details never carry raw user text ───────────────────────────────
 *
 * `DECOMPOSITION_PERSISTENCE_POLICY.rawInputInAudit` is `false`, and a
 * violation `detail` is the field most likely to reach a log. Every message
 * here is written from step ids, offsets and lengths — never from a title, a
 * span's text, an owner or a timing. The information a maintainer needs to find
 * the defect is the *location*, and the location is not sensitive.
 *
 * ── No clock, no randomness ─────────────────────────────────────────
 *
 * Validation is a pure function of the example. Two runs over the same input
 * produce identical violations in identical order, so a metric report built
 * from them is a committed artifact rather than a moving one.
 */
import { isConnectiveOnly, isEmptyTitle } from '../shared/connectives';
import type { ValidationIssue } from '../../evaluation/registry/contracts';
import { IssueCollector } from '../../evaluation/registry/validationPrimitives';
import type {
  DecompositionExample,
  DecompositionLabelKind,
  DecompositionStepProposal,
  DecompositionViolation,
  DecompositionViolationCode,
  SourceSpan,
} from '../../../src/contracts/v1/decompositionContracts';

/**
 * Titles that are a split artefact rather than a step.
 *
 * Held as whole normalised titles, not as substrings: "Review the terms and
 * conditions" contains "and" and is a perfectly good step, while a step whose
 * entire title is "and" is what a splitter emits when it cuts on a conjunction
 * it should have left alone. Matching on containment would reject the first,
 * which is the over-splitting failure this dataset is weighted to catch, only
 * inverted.
 *
 * Arabic and Hebrew entries include the bare clitic (`و`, `ו`) because a
 * splitter that strips the prefix and keeps it as its own token produces
 * exactly that.
 */

/**
 * Punctuation stripped before comparing a title against the connective list.
 *
 * Written as an explicit class rather than `\p{P}` with the `u` flag: this
 * repository targets ES5 in `tsconfig.json`, where a Unicode-property escape is
 * a compile error. The class covers the separators a splitter actually leaves
 * behind, including the Arabic comma and full stop.
 */


/**
 * The spans of a step, merged into non-overlapping ranges in offset order.
 *
 * Exported and shared with `metrics.ts` rather than written twice. "What text
 * does this step cover" has to mean one thing: if the coverage metric and the
 * title-provenance check computed it separately they could disagree, and the
 * disagreement would surface as a step that is unsourced according to one and
 * fully covered according to the other.
 */
export function mergedSpanRanges(
  spans: readonly SourceSpan[],
): readonly { readonly start: number; readonly end: number }[] {
  const ordered = spans
    .slice()
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));

  const merged: { start: number; end: number }[] = [];
  for (const span of ordered) {
    if (span.end <= span.start) continue;
    const open = merged.length > 0 ? merged[merged.length - 1] : null;
    if (open === null || open.end < span.start) merged.push({ start: span.start, end: span.end });
    else if (span.end > open.end) open.end = span.end;
  }
  return merged;
}

/**
 * Whitespace is not provenance.
 *
 * Two spans joined across a gap produce one space where the source had a comma
 * and a space, and a title carrying a trailing newline is the same title. The
 * comparison is over what the words are, not how they were spaced.
 */
function normaliseForSourcing(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The text a step's spans actually cover, segments joined in offset order. */
function coveredTextOf(sourceText: string, spans: readonly SourceSpan[]): string {
  return mergedSpanRanges(spans)
    .map((range) => sourceText.slice(range.start, range.end))
    .join(' ');
}

/**
 * Ids safe to interpolate into a violation `detail`.
 *
 * Deliberately narrow — the shape every id in this repository already has.
 * Anything else is replaced by the step's position.
 */
const SAFE_STEP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * How a step is named inside a `detail`.
 *
 * `DecompositionViolation.detail` is documented in the contract as never
 * carrying raw user text, and this module repeated the claim for itself. Both
 * were false: a `stepId` is caller-supplied, and on the engine-facing path this
 * file documents — proposals produced by a model — it is exactly as untrusted
 * as the source text is. A step id of
 * `Tell my therapist I relapsed on Tuesday, account 4111-…` went verbatim into
 * five different messages.
 *
 * Redacting every id would make the messages useless for the ordinary case, so
 * a benign id is kept and anything else falls back to the position, which
 * locates the step just as well and carries nothing.
 *
 * The `stepId` *field* is untouched: the contract types it to carry the id a
 * violation is attributed to, and a consumer needs it to find the step. The
 * audit clause is about `detail`.
 */
function stepRef(stepId: unknown, index: number): string {
  return typeof stepId === 'string' && SAFE_STEP_ID.test(stepId) ? `'${stepId}'` : `#${index}`;
}

/**
 * The same, for a dependency target.
 *
 * An unknown target has no position to fall back on — that is what makes it
 * unknown — so an unsafe one is described by length alone.
 */
function dependencyRef(stepId: unknown): string {
  if (typeof stepId === 'string' && SAFE_STEP_ID.test(stepId)) return `'${stepId}'`;
  return `an id of ${typeof stepId === 'string' ? stepId.length : 0} code units`;
}

export interface ExampleValidationResult {
  readonly exampleId: string;
  /** False when either list below is non-empty. */
  readonly valid: boolean;
  /** Findings in the shared vocabulary. #27's validator emits the same codes. */
  readonly violations: readonly DecompositionViolation[];
  /**
   * Findings about the example *as ground truth*, in this module's own
   * namespace.
   *
   * Kept separate from `violations` because the shared vocabulary describes
   * what can be wrong with a *proposal*, and some things that can be wrong with
   * a corpus row have no proposal counterpart — a `multi_step` row carrying one
   * step being the case in point: `DecomposedProposal.steps` is typed
   * `[Step, Step, ...Step[]]`, so #27 cannot produce that shape and cannot ever
   * emit a code for it. Reporting it under a shared code would make the
   * cross-track comparison disagree over data neither side considers broken.
   */
  readonly corpusIssues: readonly ValidationIssue[];
}

function violation(
  code: DecompositionViolationCode,
  stepId: string | null,
  detail: string,
): DecompositionViolation {
  return Object.freeze({ code, stepId, detail });
}

/** True when the span is a usable half-open range inside the text. */
function spanIsInRange(span: SourceSpan, length: number): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= length
  );
}

/**
 * Validates the steps of one decomposition against the text they claim to come
 * from.
 *
 * Exported separately from `validateDecompositionExample` because the same
 * rules have to run over *produced* steps — a proposal from an engine — and
 * wrapping those in a synthetic `DecompositionExample` just to reach the checks
 * would mean inventing an `exampleId`, a `locale` and a `note` that no producer
 * supplied. `metrics.ts` calls this directly for that reason.
 *
 * `label` is needed because `SPLIT_ATOMIC` is a statement about the pairing of
 * a label with a step list, not about either alone.
 */
export function validateProposedSteps(
  sourceText: string,
  steps: readonly DecompositionStepProposal[],
  label: DecompositionLabelKind,
): readonly DecompositionViolation[] {
  const violations: DecompositionViolation[] = [];
  const length = sourceText.length;
  const seenStepIds = new Set<string>();
  const stepIds = new Set(steps.map((step) => step.stepId));

  // Spans that survived the range and exactness checks, kept for the pairwise
  // overlap pass. A span that failed either is excluded: it does not reliably
  // denote a region of the text, so an overlap computed against it would be a
  // second report of the first defect.
  const usableSpans: {
    readonly stepId: string;
    readonly stepIndex: number;
    readonly span: SourceSpan;
  }[] = [];

  let stepIndex = -1;
  for (const step of steps) {
    stepIndex += 1;
    const stepId = step.stepId;
    const ref = stepRef(stepId, stepIndex);
    const stepUsableSpans: SourceSpan[] = [];
    let stepHadUnusableSpan = false;

    if (seenStepIds.has(stepId)) {
      violations.push(
        violation('DUPLICATE_STEP_ID', stepId, `step id ${ref} appears more than once in this decomposition`),
      );
    }
    seenStepIds.add(stepId);

    if (isEmptyTitle(step.title)) {
      violations.push(violation('EMPTY_STEP', stepId, `step ${ref} has a blank title`));
    } else if (isConnectiveOnly(step.title)) {
      violations.push(
        violation(
          'CONJUNCTION_ONLY',
          stepId,
          `step ${ref} is a connective, not a step: a split artefact left behind by cutting on a conjunction`,
        ),
      );
    }

    if (step.inferred && step.sourceSpans.length > 0) {
      violations.push(
        violation(
          'INFERRED_WITH_SPAN',
          stepId,
          `step ${ref} claims to be inferred while citing ${step.sourceSpans.length} source span(s)`,
        ),
      );
    } else if (!step.inferred && step.sourceSpans.length === 0) {
      violations.push(
        violation(
          'UNSOURCED_STEP',
          stepId,
          `step ${ref} cites no source span and does not admit to being inferred`,
        ),
      );
    }

    step.sourceSpans.forEach((span, index) => {
      const where = `step ${ref} span[${index}]`;
      if (!spanIsInRange(span, length)) {
        stepHadUnusableSpan = true;
        violations.push(
          violation(
            'SPAN_OUT_OF_RANGE',
            stepId,
            `${where} is [${span.start}, ${span.end}) over a source of ${length} code units`,
          ),
        );
        return;
      }
      if (sourceText.slice(span.start, span.end) !== span.text) {
        stepHadUnusableSpan = true;
        violations.push(
          violation(
            'SPAN_MISMATCH',
            stepId,
            `${where} carries ${span.text.length} code units that are not what [${span.start}, ${span.end}) selects`,
          ),
        );
        return;
      }
      usableSpans.push({ stepId, stepIndex, span });
      stepUsableSpans.push(span);
    });

    // `UNSOURCED_STEP`, second shape: the spans check out and the *title* is
    // something they do not support.
    //
    // The first shape (no span at all, no admission of inference) is checked
    // above. This one is what a hostile or hallucinating provider produces: a
    // span that round-trips perfectly beside a title that was never in the
    // text — `Wire $9,000 to account 12345` next to a clean citation of
    // something else entirely. Every other provenance check passes it, because
    // every other check interrogates the span and none interrogates the claim
    // the span is offered in support of.
    //
    // Skipped in two cases, each because the defect is already named and a
    // second code would send a maintainer to the wrong place:
    //
    //  - a blank title is `EMPTY_STEP`; whether nothing is sourced is not a
    //    meaningful question;
    //  - a step carrying an unusable span has no trustworthy text to compare
    //    against, so its title cannot be judged at all. Same reasoning as an
    //    out-of-range span not also being a mismatch.
    if (
      !step.inferred &&
      step.sourceSpans.length > 0 &&
      !stepHadUnusableSpan &&
      step.title.trim().length > 0 &&
      normaliseForSourcing(step.title) !== normaliseForSourcing(coveredTextOf(sourceText, stepUsableSpans))
    ) {
      violations.push(
        violation(
          'UNSOURCED_STEP',
          stepId,
          `step ${ref} has a title of ${step.title.length} code units that its ${stepUsableSpans.length} ` +
            'span(s) do not source; the spans check out and the title is not what they select',
        ),
      );
    }

    // A blank string is checked before the containment test, because
    // `indexOf('')` is 0: an empty timing "occurs verbatim" in every source text
    // ever written and would sail through. It is neither a real claim nor
    // `null`, and the field already has a way to say nothing.
    if (step.statedTiming !== null) {
      if (step.statedTiming.trim().length === 0) {
        violations.push(
          violation(
            'INVENTED_TIMING',
            stepId,
            `step ${ref} carries a blank statedTiming; a field that means "no timing" is null, and a blank ` +
              'string claims a timing while naming none',
          ),
        );
      } else if (sourceText.indexOf(step.statedTiming) < 0) {
        violations.push(
          violation(
            'INVENTED_TIMING',
            stepId,
            `step ${ref} states a timing of ${step.statedTiming.length} code units that does not occur in the ` +
              'source text; resolving a relative time against a clock is Capture\'s job, not a decomposer\'s',
          ),
        );
      }
    }
    if (step.statedOwner !== null) {
      if (step.statedOwner.trim().length === 0) {
        violations.push(
          violation('INVENTED_OWNER', stepId, `step ${ref} carries a blank statedOwner; use null to name nobody`),
        );
      } else if (sourceText.indexOf(step.statedOwner) < 0) {
        violations.push(
          violation(
            'INVENTED_OWNER',
            stepId,
            `step ${ref} names an owner of ${step.statedOwner.length} code units that does not occur in the source text`,
          ),
        );
      }
    }

    for (const edge of step.dependsOn) {
      if (edge.dependsOnStepId === stepId) {
        // Reported as SELF_DEPENDENCY and deliberately kept out of the cycle
        // graph below. A self-loop *is* a cycle, so leaving it in would emit
        // CYCLIC_DEPENDENCY for the same edge and give #27 two rejections to
        // reconcile where there is one defect. The specific code wins.
        violations.push(violation('SELF_DEPENDENCY', stepId, `step ${ref} depends on itself`));
      } else if (!stepIds.has(edge.dependsOnStepId)) {
        violations.push(
          violation(
            'UNKNOWN_DEPENDENCY',
            stepId,
            `step ${ref} depends on ${dependencyRef(edge.dependsOnStepId)}, which is not a step in this decomposition`,
          ),
        );
      }
    }
  }

  // Pairwise over every span in the example, including two spans of the *same*
  // step. The acceptance criterion is unqualified — source segments are exact
  // and non-overlapping — and a step double-claiming its own text is a
  // duplicated segment like any other. It is also the one that hides best:
  // `coveredCodeUnits` unions the duplication away, so no coverage figure
  // moves, and nothing else in the pipeline would ever notice.
  //
  // A step citing two *disjoint* spans stays legal; that is why `sourceSpans`
  // is a list at all.
  for (let i = 0; i < usableSpans.length; i += 1) {
    for (let j = i + 1; j < usableSpans.length; j += 1) {
      const left = usableSpans[i];
      const right = usableSpans[j];
      // Half-open ranges: [0,4) and [4,10) are adjacent, not overlapping.
      if (left.span.start < right.span.end && right.span.start < left.span.end) {
        const region =
          `[${Math.max(left.span.start, right.span.start)}, ${Math.min(left.span.end, right.span.end)})`;
        violations.push(
          violation(
            'SPAN_OVERLAP',
            right.stepId,
            left.stepId === right.stepId
              ? `step ${stepRef(left.stepId, left.stepIndex)} claims source code units ${region} twice`
              : `steps ${stepRef(left.stepId, left.stepIndex)} and ${stepRef(right.stepId, right.stepIndex)} ` +
                `both claim source code units ${region}`,
          ),
        );
      }
    }
  }

  if (hasCycle(steps)) {
    violations.push(
      violation('CYCLIC_DEPENDENCY', null, 'the dependency graph contains a cycle, so no step can be scheduled first'),
    );
  }

  const splitAtomic = detectSplitAtomic(label, steps.length);
  if (splitAtomic) violations.push(splitAtomic);

  return Object.freeze(violations);
}

/**
 * `SPLIT_ATOMIC`: the over-split direction, and only that one.
 *
 * The contract defines this as "a commitment marked do-not-split was split
 * anyway". The opposite direction — a `multi_step` row carrying fewer than two
 * steps — is also a defect, but it is not *this* one, and #27 cannot reach it:
 * `DecomposedProposal.steps` is typed `[Step, Step, ...Step[]]`, so a
 * sub-two-step decomposition is unrepresentable on the proposal side. A shared
 * code that one track can emit and the other cannot is a cross-track
 * disagreement waiting to be discovered over data neither side thinks is
 * broken.
 *
 * That defect is still caught. It is reported as `DXC031` on
 * `ExampleValidationResult.corpusIssues`, where it belongs: a statement about
 * the corpus, in the corpus's own namespace.
 */
function detectSplitAtomic(label: DecompositionLabelKind, stepCount: number): DecompositionViolation | null {
  // Above one, not above zero. The contract's wording is "a commitment marked
  // do-not-split was *split* anyway", and one step is not a split — it is a
  // decomposition that did not happen. #27 fires only above one, and on this
  // case #26 was the side that was wrong.
  //
  // One step on an unsplittable row is still bad ground truth, since the
  // contract says `expectedSteps` is empty for both labels. It is reported as
  // `DXC032` on `corpusIssues`, for the same reason the under-split direction
  // is: #27 cannot represent the shape, so a shared code would diverge again.
  if (label === 'multi_step' || stepCount <= 1) return null;
  return violation('SPLIT_ATOMIC', null, `labelled '${label}' but carries ${stepCount} step(s)`);
}

/** Iterative depth-first cycle detection; no recursion, so a long chain cannot blow the stack. */
function hasCycle(steps: readonly DecompositionStepProposal[]): boolean {
  const edges = new Map<string, readonly string[]>();
  for (const step of steps) {
    edges.set(
      step.stepId,
      // Self-edges are excluded: they are SELF_DEPENDENCY, and counting them
      // here would report one defect under two codes.
      step.dependsOn.map((edge) => edge.dependsOnStepId).filter((id) => id !== step.stepId),
    );
  }

  const permanent = new Set<string>();
  const onStack = new Set<string>();

  for (const step of steps) {
    if (permanent.has(step.stepId)) continue;
    const stack: { readonly id: string; readonly entering: boolean }[] = [{ id: step.stepId, entering: true }];
    while (stack.length > 0) {
      const frame = stack.pop() as { readonly id: string; readonly entering: boolean };
      if (!frame.entering) {
        onStack.delete(frame.id);
        permanent.add(frame.id);
        continue;
      }
      if (permanent.has(frame.id)) continue;
      if (onStack.has(frame.id)) return true;
      onStack.add(frame.id);
      stack.push({ id: frame.id, entering: false });
      for (const next of edges.get(frame.id) ?? []) {
        // A dangling edge is UNKNOWN_DEPENDENCY, reported elsewhere; it cannot
        // close a cycle, so it is skipped rather than treated as a node.
        if (edges.has(next)) stack.push({ id: next, entering: true });
      }
    }
  }
  return false;
}

/**
 * Validates one labelled example.
 *
 * `expectedSteps` is what a correct decomposer would have produced, so the same
 * rules apply to it as to a produced proposal. Ground truth that violates the
 * vocabulary is worse than a wrong model: every score computed against it is
 * measured off a broken ruler.
 */
export function validateDecompositionExample(example: DecompositionExample): ExampleValidationResult {
  const violations = validateProposedSteps(example.sourceText, example.expectedSteps, example.label);
  const collector = new IssueCollector();

  // A size-one step list and an honest refusal to decompose are the same data.
  // The contract removes that ambiguity on the proposal side by giving
  // `AtomicProposal` no `steps` field; the dataset holds the same line here, in
  // its own namespace rather than the shared one. See `detectSplitAtomic`.
  if (example.label === 'multi_step' && example.expectedSteps.length < 2) {
    collector.error(
      'DXC031',
      `examples['${example.exampleId}'].expectedSteps`,
      `labelled 'multi_step' but carries ${example.expectedSteps.length} step(s); a decomposition of size one ` +
        'is an atomic outcome, and scoring it as a correct decomposition credits a split nobody made',
    );
  }

  if (example.label !== 'multi_step' && example.expectedSteps.length === 1) {
    collector.error(
      'DXC032',
      `examples['${example.exampleId}'].expectedSteps`,
      `labelled '${example.label}' but carries one step; the contract says expectedSteps is empty for ` +
        'atomic and do_not_split rows, and a single step there is a decomposition nobody made',
    );
  }

  const corpusIssues = collector.result().issues;
  return Object.freeze({
    exampleId: example.exampleId,
    valid: violations.length === 0 && corpusIssues.length === 0,
    violations,
    corpusIssues: Object.freeze(corpusIssues),
  });
}

/** Convenience for a whole corpus; ordering follows the input, never a sort. */
export function validateDecompositionExamples(
  examples: readonly DecompositionExample[],
): readonly ExampleValidationResult[] {
  return Object.freeze(examples.map(validateDecompositionExample));
}
