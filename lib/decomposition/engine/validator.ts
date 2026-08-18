/**
 * Structural and provenance validation of a set of proposed steps.
 *
 * The validator is the only thing standing between a detector's guess and a
 * proposal offered to a user, so it is deliberately paranoid about provenance:
 * every claim a step makes about where it came from is re-derived from the
 * source text rather than trusted.
 *
 * Two design decisions worth stating, because both had a tempting alternative:
 *
 *  1. **Codes have a precedence order, and a defect reports one code.** Several
 *     conditions imply each other — a span reaching past the end of the text
 *     also fails the slice round-trip; a self-edge is also a cycle. Reporting
 *     every technically-true code would hand a reviewer four findings for one
 *     defect with no signal about which is the cause. Precedence is encoded by
 *     `continue`-ing past the implied checks, and pinned by tests asserting the
 *     *exact* code set rather than membership.
 *
 *  2. **`detail` never quotes the input.** Violations travel with proposals and
 *     into audit records, and a message that echoes the offending text would
 *     put raw user content everywhere a violation goes — silently defeating the
 *     `rawInputInAudit: false` policy from a direction nobody inspects. Details
 *     carry indices, ids and lengths only.
 */

import type {
  DecompositionStepProposal,
  DecompositionViolation,
  SourceSpan,
} from '../../../src/contracts/v1/decompositionContracts';

/**
 * Titles that are only a connective: the residue a splitter leaves when it
 * cuts on both sides of a conjunction. Listed per script because the Arabic and
 * Hebrew forms also appear as prefixed clitics, and a step whose entire title is
 * the clitic is the same artefact.
 */
const CONNECTIVE_ONLY = new Set([
  'and',
  'then',
  'and then',
  'also',
  'plus',
  'or',
  'after',
  'after that',
  'ثم',
  'و',
  'وبعدها',
  'بعدها',
  'بعد ذلك',
  'ואז',
  'ו',
  'וגם',
  'ואחר כך',
]);

export interface DecompositionValidationInput {
  readonly sourceText: string;
  readonly steps: readonly DecompositionStepProposal[];
  /**
   * The commitment is known to be one action. Set by a caller that has ground
   * truth (the golden set, an annotator); the engine never sets it about its
   * own output, which would make the check circular.
   */
  readonly declaredAtomic?: boolean;
}

function normalizeConnective(title: string): string {
  // Strip trailing punctuation only; interior spacing is significant because
  // "and then" is a connective while "and thennews" is not a word at all.
  return title.trim().replace(/[.,;:،؛!?]+$/, '').trim().toLowerCase();
}

/**
 * Steps in a cycle, excluding self-edges and edges to unknown steps.
 *
 * Both exclusions matter: a self-edge is reported as `SELF_DEPENDENCY` and
 * would otherwise also surface here, and a dangling edge cannot be part of a
 * cycle at all — following it would either crash or invent one.
 */
function stepsInCycle(steps: readonly DecompositionStepProposal[]): ReadonlySet<string> {
  const known = new Set(steps.map((step) => step.stepId));
  const edges = new Map<string, readonly string[]>();
  for (const step of steps) {
    edges.set(
      step.stepId,
      step.dependsOn
        .map((dependency) => dependency.dependsOnStepId)
        .filter((id) => id !== step.stepId && known.has(id)),
    );
  }

  const inCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      for (let index = stack.lastIndexOf(id); index >= 0 && index < stack.length; index += 1) {
        inCycle.add(stack[index]);
      }
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 'done');
  };

  for (const step of steps) visit(step.stepId);
  return inCycle;
}

export function validateDecomposition(
  input: DecompositionValidationInput,
): readonly DecompositionViolation[] {
  const { sourceText, steps } = input;
  const violations: DecompositionViolation[] = [];
  const add = (
    code: DecompositionViolation['code'],
    stepId: string | null,
    detail: string,
  ): void => {
    violations.push({ code, stepId, detail });
  };

  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.stepId)) {
      add('DUPLICATE_STEP_ID', step.stepId, 'step id occurs more than once in this proposal');
    }
    seenIds.add(step.stepId);
  }

  // Spans whose offsets are in range, per step index. Overlap is computed over
  // these alone: an out-of-range span is not a range, so asking whether it
  // intersects another one produces a second finding about the same defect and
  // sends the reviewer to the wrong step.
  const inRangeSpans: SourceSpan[][] = steps.map(() => []);

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const trimmed = step.title.trim();

    if (trimmed.length === 0) {
      // An empty title is also, trivially, "only a connective". Reporting the
      // emptier fact is the actionable one.
      add('EMPTY_STEP', step.stepId, `step ${index} has a blank title`);
    } else if (CONNECTIVE_ONLY.has(normalizeConnective(trimmed))) {
      add('CONJUNCTION_ONLY', step.stepId, `step ${index} title is a connective, not an action`);
    }

    if (step.inferred && step.sourceSpans.length > 0) {
      add('INFERRED_WITH_SPAN', step.stepId, 'step claims inference while citing source spans');
    } else if (!step.inferred && step.sourceSpans.length === 0) {
      add('UNSOURCED_STEP', step.stepId, 'step cites no source span and does not admit inference');
    }

    for (let spanIndex = 0; spanIndex < step.sourceSpans.length; spanIndex += 1) {
      const span = step.sourceSpans[spanIndex];
      if (
        !Number.isInteger(span.start)
        || !Number.isInteger(span.end)
        || span.start < 0
        || span.end > sourceText.length
        || span.start > span.end
      ) {
        add(
          'SPAN_OUT_OF_RANGE',
          step.stepId,
          `span ${spanIndex} is not a valid range within a source of length ${sourceText.length}`,
        );
        continue;
      }
      inRangeSpans[index].push(span);
      if (sourceText.slice(span.start, span.end) !== span.text) {
        add(
          'SPAN_MISMATCH',
          step.stepId,
          `span ${spanIndex} does not round-trip: sourceText.slice(start, end) !== text`,
        );
      }
    }

    if (step.statedTiming !== null && !sourceText.includes(step.statedTiming)) {
      add('INVENTED_TIMING', step.stepId, 'statedTiming does not occur verbatim in the source text');
    }
    if (step.statedOwner !== null && !sourceText.includes(step.statedOwner)) {
      add('INVENTED_OWNER', step.stepId, 'statedOwner does not occur verbatim in the source text');
    }

    for (const dependency of step.dependsOn) {
      if (dependency.dependsOnStepId === step.stepId) {
        add('SELF_DEPENDENCY', step.stepId, 'step depends on itself');
      } else if (!seenIds.has(dependency.dependsOnStepId)) {
        add('UNKNOWN_DEPENDENCY', step.stepId, 'dependency names a step absent from this proposal');
      }
    }
  }

  // Overlap is pairwise across *different* steps. Two spans on one step may
  // abut or nest without lying about anything; two steps claiming the same
  // words means at least one of them did not come from where it says.
  for (let left = 0; left < steps.length; left += 1) {
    for (let right = left + 1; right < steps.length; right += 1) {
      for (const a of inRangeSpans[left]) {
        for (const b of inRangeSpans[right]) {
          if (a.start < b.end && b.start < a.end) {
            add(
              'SPAN_OVERLAP',
              steps[right].stepId,
              `source range overlaps the range claimed by step index ${left}`,
            );
          }
        }
      }
    }
  }

  for (const stepId of Array.from(stepsInCycle(steps))) {
    add('CYCLIC_DEPENDENCY', stepId, 'step participates in a dependency cycle');
  }

  if (input.declaredAtomic === true && steps.length > 1) {
    add('SPLIT_ATOMIC', null, `commitment is declared atomic but carries ${steps.length} steps`);
  }

  return violations;
}
