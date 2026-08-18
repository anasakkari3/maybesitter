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
}

export interface DecompositionPersistedState {
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
      if (candidate[step.stepId]) {
        throw new Error(`decomposition adapter: step ${step.stepId} already persisted`);
      }
      if (step.title.trim().length === 0) {
        throw new Error(`decomposition adapter: step ${step.stepId} has a blank title`);
      }
      candidate[step.stepId] = step;
    }
    // Edges are checked after the whole batch is staged so that a step may
    // depend on another step in the same confirmation, which is the ordinary
    // case — checking as we went would make the batch order significant.
    for (const step of steps) {
      for (const edge of step.dependsOn) {
        if (!candidate[edge.dependsOnStepId]) {
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
