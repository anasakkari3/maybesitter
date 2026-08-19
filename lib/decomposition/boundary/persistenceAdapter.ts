/**
 * The only thing in this sprint that writes.
 *
 * Modelled on Sprint 01's `TransactionalCapturePersistenceAdapter`: the batch
 * is evaluated against a private candidate state and canonical state is
 * replaced only once every step in it validates. The alternative — writing as
 * we go and unwinding on error — leaves a partially decomposed commitment
 * whenever the unwind is the thing that fails, which is exactly the state
 * nobody has a UI for.
 *
 * Confirmed steps live in their own store rather than in `DomainState`.
 * `Commitment` has no notion of a step or a parent, Sprint 07's scheduler reads
 * that type, and pushing a schema change into a shared surface for a feature
 * with no production route would be a migration owed to nobody.
 *
 * **State is keyed by `(proposalId, stepId)`, not by `stepId`.** A `stepId` is
 * proposal-local by contract — `StepDependency.dependsOnStepId` and
 * `StepDecision.stepId` both name a step *within one proposal*, and the frozen
 * golden set pins the detector's ids as `s1`, `s2`, `s3` — so every proposal in
 * the product carries the same three. Keyed on the bare id, canonical state
 * collided the moment a user decomposed a second commitment, and every
 * commitment after the first failed permanently with `persistence_failed`. The
 * alternative, minting globally unique ids in the detector, would put a
 * storage concern inside a pure function and contradict the fixture the two
 * sibling tracks compare against.
 */

import type { SourceSpan, StepDependency } from '../../../src/contracts/v1/decompositionContracts';

/**
 * A step the user actually ruled on.
 *
 * It keeps `sourceSpans` after confirmation, including through an edit: the
 * user rewrote the title, not the origin, and a step that has lost its
 * provenance can never be re-checked against the sentence it came from.
 */
export interface ConfirmedDecompositionStep {
  readonly stepId: string;
  readonly proposalId: string;
  /** The commitment this step sits beside. The commitment itself is untouched. */
  readonly commitmentId: string;
  readonly title: string;
  readonly sourceSpans: readonly SourceSpan[];
  readonly dependsOn: readonly StepDependency[];
  readonly statedTiming: string | null;
  readonly statedOwner: string | null;
  /**
   * Whether the engine admitted this step was not read from the source.
   *
   * Carried through because the admission is the only thing separating a step
   * the user wrote from one the engine added around it, and dropping it at
   * persistence left the stored record unable to say which it was — while
   * `inferred: true` is precisely what exempts a step from title provenance.
   */
  readonly inferred: boolean;
}

/**
 * The key a confirmed step is filed under.
 *
 * Exported because a consumer cannot reconstruct it by guessing: the separator
 * is a NUL, which cannot occur in an id, so `(p1, s2)` and `(p1s, 2)` cannot
 * collide the way a `-` or `:` separator would allow.
 */
export function stepKey(proposalId: string, stepId: string): string {
  return `${proposalId}\u0000${stepId}`;
}

export interface DecompositionPersistedState {
  /** Keyed by `stepKey(proposalId, stepId)`. */
  readonly steps: Readonly<Record<string, ConfirmedDecompositionStep>>;
}

export interface DecompositionPersistenceAdapter {
  persistAtomically(
    steps: readonly ConfirmedDecompositionStep[],
  ): Promise<{ state: DecompositionPersistedState }>;
  snapshot(): DecompositionPersistedState;
}

export function createEmptyDecompositionState(): DecompositionPersistedState {
  return { steps: {} };
}

export class TransactionalDecompositionPersistenceAdapter implements DecompositionPersistenceAdapter {
  private state: DecompositionPersistedState;

  constructor(initialState: DecompositionPersistedState) {
    this.state = structuredClone(initialState);
  }

  async persistAtomically(
    steps: readonly ConfirmedDecompositionStep[],
  ): Promise<{ state: DecompositionPersistedState }> {
    // An empty batch is a caller bug, not a no-op: the boundary is supposed to
    // have decided there was nothing to write *before* getting here, and a
    // silent success would report a write that never happened.
    if (steps.length === 0) throw new Error('decomposition adapter: empty batch');

    const candidate: Record<string, ConfirmedDecompositionStep> = structuredClone(this.state.steps);
    for (const step of steps) {
      const key = stepKey(step.proposalId, step.stepId);
      // `Object.hasOwn`, not truthiness: `candidate` is a plain object, so
      // `candidate['constructor']` is truthy without anything being stored
      // there. The composite key already makes a collision with an inherited
      // name impossible, but a guard that depends on the key format is a trap
      // that grows back the moment the format changes.
      if (Object.hasOwn(candidate, key)) {
        throw new Error(`decomposition adapter: step ${step.stepId} already persisted for this proposal`);
      }
      if (step.title.trim().length === 0) {
        throw new Error(`decomposition adapter: step ${step.stepId} has a blank title`);
      }
      // Cloned on the way in. The caller keeps a reference to the batch it
      // passed, and without this a mutation *after* the write would silently
      // rewrite canonical state — provenance that can be edited after the fact
      // is not provenance.
      candidate[key] = structuredClone(step);
    }
    // Edges are checked after the whole batch is staged so that a step may
    // depend on another step in the same confirmation, which is the ordinary
    // case — checking as we went would make the batch order significant.
    // Resolved within the step's own proposal, because that is the only scope
    // in which `dependsOnStepId` means anything.
    for (const step of steps) {
      for (const edge of step.dependsOn) {
        if (!Object.hasOwn(candidate, stepKey(step.proposalId, edge.dependsOnStepId))) {
          throw new Error(
            `decomposition adapter: step ${step.stepId} depends on unpersisted ${edge.dependsOnStepId}`,
          );
        }
      }
    }

    this.state = { steps: candidate };
    return { state: this.snapshot() };
  }

  snapshot(): DecompositionPersistedState {
    return structuredClone(this.state);
  }
}
