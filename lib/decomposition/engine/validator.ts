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
 *     *exact* code set rather than membership. The same principle sets the
 *     cardinality: a dependency cycle is one violation for the proposal, not
 *     one per step caught in it.
 *
 *  2. **Provenance is re-derived for every field a step asserts, including the
 *     title.** Checking the spans alone leaves the invention channel that
 *     matters open: a provider can cite real offsets and put anything at all in
 *     the title, and the title is the field the user reads and the adapter
 *     persists. "This step came from these words" is only a checkable claim if
 *     the words the step states are the words its spans select. This reports as
 *     `UNSOURCED_STEP`, which covers both shapes the name implies: a step with
 *     no span at all, and a step whose title its spans do not source. #26's
 *     evaluator counts them under the same code, so the two agree by
 *     construction rather than by coincidence. Coverage is measured against the
 *     *merged* span range, whitespace collapsed — the standard #26 states — so
 *     a step that duplicates one of its own ranges is billed for the
 *     duplication alone.
 *
 *     **What this check does and does not prove.** It proves the title's words
 *     were written by the user somewhere in this commitment. It does *not*
 *     prove the commitment says the step. Two gaps are real and neither is
 *     closed here:
 *
 *       - **Sub-span selection can drop a negation.** In "Do not cancel the
 *         wedding and call the caterer", the span `[7,25)` round-trips exactly
 *         and yields the title "cancel the wedding". The negation is simply
 *         outside the span.
 *       - **Disjoint spans stitch into a phrase nobody wrote.** Spans over
 *         "send the keys" and "delete the backups" join into
 *         "send the keys delete the backups", a sentence the user never typed.
 *         Multi-span steps are sanctioned by the contract — a step is often
 *         stated across discontinuous parts of one sentence — so requiring
 *         contiguity would contradict it, and is not done.
 *
 *     Closing these means reading the sentence, not checking offsets against
 *     it, which is a different piece of work. What is checkable is checked; the
 *     rest is stated rather than implied. The rules detector emits exactly one
 *     contiguous span per step, so both gaps are reachable only through a model
 *     provider's draft.
 *
 *  3. **`detail` never quotes the input.** Violations travel with proposals and
 *     into audit records, and a message that echoes the offending text would
 *     put raw user content everywhere a violation goes — silently defeating the
 *     `rawInputInAudit: false` policy from a direction nobody inspects. Details
 *     carry indices, ids and lengths only.
 */

import { isConnectiveOnly, isEmptyTitle } from '../shared/connectives';
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

/** Collapse runs of whitespace so a re-spaced title is not a different claim. */
function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * The text a step's spans jointly cover, with overlapping and touching ranges
 * merged first.
 *
 * Merging rather than concatenating is what keeps one defect to one code. A
 * step claiming `[0,14)` and `[5,14)` has duplicated a range, and `SPAN_OVERLAP`
 * already says so; concatenating the two texts would read its coverage as
 * "Book the venue the venue" and bill the same mistake a second time as an
 * unsourced title. Under merging the pair covers exactly `Book the venue`, so
 * the title is sourced and only the duplication is reported.
 *
 * Disjoint ranges stay separate and are joined by a single space, so a title
 * cannot quietly claim the words sitting in the gap between two spans.
 */
function mergedSpanText(sourceText: string, spans: readonly SourceSpan[]): string {
  const ordered = spans.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of ordered) {
    const last = merged[merged.length - 1];
    // `<=` so ranges that merely touch are merged too: `[0,4)` and `[4,8)` cover
    // one continuous stretch of the source, and treating them as two would
    // depend on where the caller happened to cut.
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return collapseWhitespace(
    merged.map((range) => sourceText.slice(range.start, range.end)).join(' '),
  );
}

/**
 * What is wrong with a title on its own, or null when nothing is.
 *
 * Exported because it is the *single* standard for "this is not a step",
 * applied both when a proposal is validated and when a user edits a step at the
 * boundary. Those were two different rules before — admission used this one,
 * the edit path used `trim().length === 0` — so a user could edit a step into
 * "and" and have it written, a string admission would have rejected outright.
 * Sharing the function is what makes the two agree by construction rather than
 * by two authors remembering the same thing.
 */
export type TitleAdmissionProblem = 'EMPTY_STEP' | 'CONJUNCTION_ONLY';

export function titleAdmission(title: string): TitleAdmissionProblem | null {
  // An empty title is also, trivially, "only a connective". Reporting the
  // emptier fact is the actionable one.
  if (isEmptyTitle(title)) return 'EMPTY_STEP';
  return isConnectiveOnly(title) ? 'CONJUNCTION_ONLY' : null;
}

/**
 * Steps in a cycle, excluding self-edges and edges to unknown steps.
 *
 * Both exclusions matter: a self-edge is reported as `SELF_DEPENDENCY` and
 * would otherwise also surface here, and a dangling edge cannot be part of a
 * cycle at all — following it would either crash or invent one.
 *
 * Iterative, with an explicit stack. The recursive version cost one JS frame
 * per edge, so a provider returning a few thousand chained steps threw a
 * `RangeError` out of the boundary — past the engine's only `try/catch`, which
 * wraps the provider call and not the validation of its output, so there was no
 * rejection, no audit event and no fallback. #26's twin is iterative for
 * exactly this reason, and the two now agree at depth as well as in verdict.
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
  /** The current gray path, mirrored as a set so a back edge is O(1) to spot. */
  const path: string[] = [];
  const onPath = new Set<string>();

  for (const root of Array.from(known)) {
    if (state.has(root)) continue;
    const stack: { readonly id: string; edgeIndex: number }[] = [{ id: root, edgeIndex: 0 }];
    state.set(root, 'visiting');
    path.push(root);
    onPath.add(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const outgoing = edges.get(frame.id) ?? [];
      if (frame.edgeIndex < outgoing.length) {
        const next = outgoing[frame.edgeIndex];
        frame.edgeIndex += 1;
        if (onPath.has(next)) {
          // Back edge: everything from `next` to the top of the path is in it.
          for (let index = path.lastIndexOf(next); index < path.length; index += 1) {
            inCycle.add(path[index]);
          }
        } else if (!state.has(next)) {
          state.set(next, 'visiting');
          path.push(next);
          onPath.add(next);
          stack.push({ id: next, edgeIndex: 0 });
        }
      } else {
        stack.pop();
        onPath.delete(frame.id);
        path.pop();
        state.set(frame.id, 'done');
      }
    }
  }
  return inCycle;
}

/**
 * A step id rendered safe to put in a `detail` string.
 *
 * `detail` is contractually free of raw user text. Naming the ids in a cycle is
 * the coordinator's cardinality ruling, and that was justified by ids being
 * engine-assigned — true for this detector, false for a provider-supplied
 * draft. A provider echoing the commitment as a step id put the user's sentence
 * into every log line that prints violations. Ids that look like ids are named;
 * anything else is reported positionally, the way the `SPAN_*` codes already do.
 */
const SAFE_STEP_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function safeStepId(steps: readonly DecompositionStepProposal[], stepId: string): string {
  if (SAFE_STEP_ID.test(stepId)) return stepId;
  const index = steps.findIndex((step) => step.stepId === stepId);
  return index >= 0 ? `step#${index}` : 'step#unknown';
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

  // Every in-range span in the proposal, tagged with the step that claimed it.
  // Flat rather than per-step because overlap is checked over *all* pairs: a
  // step double-claiming its own words is exactly as wrong as two steps
  // colliding, and the acceptance criterion ("source segments are exact and
  // non-overlapping") draws no distinction between the two.
  const claims: { readonly stepIndex: number; readonly span: SourceSpan }[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const trimmed = step.title.trim();

    const titleProblem = titleAdmission(step.title);
    if (titleProblem === 'EMPTY_STEP') {
      add('EMPTY_STEP', step.stepId, `step ${index} has a blank title`);
    } else if (titleProblem === 'CONJUNCTION_ONLY') {
      add('CONJUNCTION_ONLY', step.stepId, `step ${index} title is a connective, not an action`);
    }

    let spansUsable = true;
    for (let spanIndex = 0; spanIndex < step.sourceSpans.length; spanIndex += 1) {
      const span = step.sourceSpans[spanIndex];
      if (
        !Number.isInteger(span.start)
        || !Number.isInteger(span.end)
        || span.start < 0
        || span.end > sourceText.length
        // A degenerate `[n, n)` is in bounds and claims nothing, and
        // `slice(n, n) === ''` would match a `text` of `''`, so the round-trip
        // check passes it silently. Malformed, not exact.
        || span.start >= span.end
      ) {
        add(
          'SPAN_OUT_OF_RANGE',
          step.stepId,
          `span ${spanIndex} is not a valid non-empty range within a source of length ${sourceText.length}`,
        );
        spansUsable = false;
        continue;
      }
      if (sourceText.slice(span.start, span.end) !== span.text) {
        add(
          'SPAN_MISMATCH',
          step.stepId,
          `span ${spanIndex} does not round-trip: sourceText.slice(start, end) !== text`,
        );
        spansUsable = false;
        continue;
      }
      // Registered only once the span has passed *both* checks. A span whose
      // text does not match what its offsets select is not a claim on that
      // range at all, so it has nothing to overlap with; letting it into the
      // overlap pass billed one forged span as two defects and disagreed with
      // #26, which excludes unusable spans for the same reason.
      claims.push({ stepIndex: index, span });
    }

    if (step.inferred && step.sourceSpans.length > 0) {
      add('INFERRED_WITH_SPAN', step.stepId, 'step claims inference while citing source text');
    } else if (!step.inferred && step.sourceSpans.length === 0) {
      add('UNSOURCED_STEP', step.stepId, 'step cites no source span and does not admit inference');
    } else if (!step.inferred && spansUsable && trimmed.length > 0) {
      // The title must be exactly what its spans select, modulo whitespace.
      // Skipped when a span is already broken, because a title cannot be
      // checked against an unusable span and two findings for one defect send
      // the reviewer to the wrong place. An edited title is confirmed at the
      // boundary, never re-validated here: the user rewrote the wording, and a
      // user is allowed to say something the engine did not read.
      if (collapseWhitespace(step.title) !== mergedSpanText(sourceText, step.sourceSpans)) {
        add(
          'UNSOURCED_STEP',
          step.stepId,
          'step title is not the text its own spans select',
        );
      }
    }

    // `null` is how a step says it makes no claim. An empty or blank string is
    // a claim about nothing, and `sourceText.includes('')` is always true, so a
    // plain verbatim check waves it through.
    if (step.statedTiming !== null
      && (step.statedTiming.trim().length === 0 || !sourceText.includes(step.statedTiming))) {
      add('INVENTED_TIMING', step.stepId, 'statedTiming is blank or does not occur verbatim in the source text');
    }
    if (step.statedOwner !== null
      && (step.statedOwner.trim().length === 0 || !sourceText.includes(step.statedOwner))) {
      add('INVENTED_OWNER', step.stepId, 'statedOwner is blank or does not occur verbatim in the source text');
    }

    for (const dependency of step.dependsOn) {
      if (dependency.dependsOnStepId === step.stepId) {
        add('SELF_DEPENDENCY', step.stepId, 'step depends on itself');
      } else if (!seenIds.has(dependency.dependsOnStepId)) {
        add('UNKNOWN_DEPENDENCY', step.stepId, 'dependency names a step absent from this proposal');
      }
    }
  }

  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left];
      const b = claims[right];
      if (a.span.start < b.span.end && b.span.start < a.span.end) {
        add(
          'SPAN_OVERLAP',
          steps[b.stepIndex].stepId,
          a.stepIndex === b.stepIndex
            ? `step ${b.stepIndex} claims overlapping source ranges twice`
            : `source range overlaps the range claimed by step index ${a.stepIndex}`,
        );
      }
    }
  }

  // One cycle is one defect, attributed to the proposal rather than to any step
  // in it. Emitting it per participant hands a caller N rejections for one
  // problem with no way to tell N problems from one, and no step in a cycle is
  // more at fault than the others. The contract reserves `stepId: null` for
  // exactly this. Ids are engine-assigned, so naming them in `detail` keeps the
  // no-user-text rule intact while still saying which steps to look at.
  const cyclic = Array.from(stepsInCycle(steps)).map((id) => safeStepId(steps, id)).sort();
  if (cyclic.length > 0) {
    add('CYCLIC_DEPENDENCY', null, `dependency cycle among steps: ${cyclic.join(', ')}`);
  }

  if (input.declaredAtomic === true && steps.length > 1) {
    add('SPLIT_ATOMIC', null, `commitment is declared atomic but carries ${steps.length} steps`);
  }

  return violations;
}
