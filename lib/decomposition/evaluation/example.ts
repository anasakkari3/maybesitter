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
const CONJUNCTION_ONLY_TITLES: readonly string[] = Object.freeze([
  // English
  'and',
  'then',
  'and then',
  'also',
  'or',
  'plus',
  'after that',
  // Arabic
  'و',
  'ثم',
  'وثم',
  'بعدها',
  'وبعدها',
  'أو',
  'او',
  // Hebrew
  'ו',
  'ואז',
  'אז',
  'או',
  'ואחר כך',
]);

/**
 * Punctuation stripped before comparing a title against the connective list.
 *
 * Written as an explicit class rather than `\p{P}` with the `u` flag: this
 * repository targets ES5 in `tsconfig.json`, where a Unicode-property escape is
 * a compile error. The class covers the separators a splitter actually leaves
 * behind, including the Arabic comma and full stop.
 */
const TRIM_PUNCTUATION = /^[\s.,;:!?"'()[\]{}،؛؟۔׃–—-]+|[\s.,;:!?"'()[\]{}،؛؟۔׃–—-]+$/g;

function normaliseTitle(title: string): string {
  return title.replace(TRIM_PUNCTUATION, '').toLowerCase();
}

export interface ExampleValidationResult {
  readonly exampleId: string;
  readonly valid: boolean;
  readonly violations: readonly DecompositionViolation[];
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
  const usableSpans: { readonly stepId: string; readonly span: SourceSpan }[] = [];

  for (const step of steps) {
    const stepId = step.stepId;

    if (seenStepIds.has(stepId)) {
      violations.push(
        violation('DUPLICATE_STEP_ID', stepId, `step id '${stepId}' appears more than once in this decomposition`),
      );
    }
    seenStepIds.add(stepId);

    const normalised = normaliseTitle(step.title);
    if (step.title.trim().length === 0) {
      violations.push(violation('EMPTY_STEP', stepId, `step '${stepId}' has a blank title`));
    } else if (CONJUNCTION_ONLY_TITLES.indexOf(normalised) >= 0) {
      violations.push(
        violation(
          'CONJUNCTION_ONLY',
          stepId,
          `step '${stepId}' is a connective, not a step: a split artefact left behind by cutting on a conjunction`,
        ),
      );
    }

    if (step.inferred && step.sourceSpans.length > 0) {
      violations.push(
        violation(
          'INFERRED_WITH_SPAN',
          stepId,
          `step '${stepId}' claims to be inferred while citing ${step.sourceSpans.length} source span(s)`,
        ),
      );
    } else if (!step.inferred && step.sourceSpans.length === 0) {
      violations.push(
        violation(
          'UNSOURCED_STEP',
          stepId,
          `step '${stepId}' cites no source span and does not admit to being inferred`,
        ),
      );
    }

    step.sourceSpans.forEach((span, index) => {
      const where = `step '${stepId}' span[${index}]`;
      if (!spanIsInRange(span, length)) {
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
        violations.push(
          violation(
            'SPAN_MISMATCH',
            stepId,
            `${where} carries ${span.text.length} code units that are not what [${span.start}, ${span.end}) selects`,
          ),
        );
        return;
      }
      usableSpans.push({ stepId, span });
    });

    if (step.statedTiming !== null && sourceText.indexOf(step.statedTiming) < 0) {
      violations.push(
        violation(
          'INVENTED_TIMING',
          stepId,
          `step '${stepId}' states a timing of ${step.statedTiming.length} code units that does not occur in the ` +
            'source text; resolving a relative time against a clock is Capture\'s job, not a decomposer\'s',
        ),
      );
    }
    if (step.statedOwner !== null && sourceText.indexOf(step.statedOwner) < 0) {
      violations.push(
        violation(
          'INVENTED_OWNER',
          stepId,
          `step '${stepId}' names an owner of ${step.statedOwner.length} code units that does not occur in the source text`,
        ),
      );
    }

    for (const edge of step.dependsOn) {
      if (edge.dependsOnStepId === stepId) {
        // Reported as SELF_DEPENDENCY and deliberately kept out of the cycle
        // graph below. A self-loop *is* a cycle, so leaving it in would emit
        // CYCLIC_DEPENDENCY for the same edge and give #27 two rejections to
        // reconcile where there is one defect. The specific code wins.
        violations.push(violation('SELF_DEPENDENCY', stepId, `step '${stepId}' depends on itself`));
      } else if (!stepIds.has(edge.dependsOnStepId)) {
        violations.push(
          violation(
            'UNKNOWN_DEPENDENCY',
            stepId,
            `step '${stepId}' depends on '${edge.dependsOnStepId}', which is not a step in this decomposition`,
          ),
        );
      }
    }
  }

  // Pairwise, across steps only. The contract defines SPAN_OVERLAP as "two
  // steps claiming overlapping source text"; a step citing two overlapping
  // spans of its own is redundant rather than a provenance conflict, and
  // reporting it under this code would make the evaluator's count disagree with
  // #27's rejection over data neither considers broken.
  for (let i = 0; i < usableSpans.length; i += 1) {
    for (let j = i + 1; j < usableSpans.length; j += 1) {
      const left = usableSpans[i];
      const right = usableSpans[j];
      if (left.stepId === right.stepId) continue;
      // Half-open ranges: [0,4) and [4,10) are adjacent, not overlapping.
      if (left.span.start < right.span.end && right.span.start < left.span.end) {
        violations.push(
          violation(
            'SPAN_OVERLAP',
            right.stepId,
            `steps '${left.stepId}' and '${right.stepId}' both claim source code units ` +
              `[${Math.max(left.span.start, right.span.start)}, ${Math.min(left.span.end, right.span.end)})`,
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
 * `SPLIT_ATOMIC` in both directions.
 *
 * A `do_not_split` or `atomic` row carrying steps is the obvious direction. The
 * less obvious one is a `multi_step` row carrying fewer than two: a size-one
 * step list and an honest refusal to decompose are the same data, and the
 * contract removes that ambiguity on the proposal side by giving
 * `AtomicProposal` no `steps` field at all. The dataset has to hold the same
 * line, or a row labelled `multi_step` with one step would score as a correct
 * decomposition of something nobody decomposed.
 */
function detectSplitAtomic(label: DecompositionLabelKind, stepCount: number): DecompositionViolation | null {
  if (label === 'multi_step') {
    return stepCount >= 2
      ? null
      : violation(
          'SPLIT_ATOMIC',
          null,
          `labelled 'multi_step' but carries ${stepCount} step(s); a decomposition of size one is an atomic outcome`,
        );
  }
  return stepCount === 0
    ? null
    : violation(
        'SPLIT_ATOMIC',
        null,
        `labelled '${label}' but carries ${stepCount} step(s)`,
      );
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
  return Object.freeze({
    exampleId: example.exampleId,
    valid: violations.length === 0,
    violations,
  });
}

/** Convenience for a whole corpus; ordering follows the input, never a sort. */
export function validateDecompositionExamples(
  examples: readonly DecompositionExample[],
): readonly ExampleValidationResult[] {
  return Object.freeze(examples.map(validateDecompositionExample));
}
