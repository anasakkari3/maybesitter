/**
 * The seam between a confirmed decomposition and canonical user state
 * (Sprint 06, issue #25).
 *
 * This file declares an interface and nothing else. That is the design, not an
 * omission: #25 owns the rule that only a completed confirmation may reach
 * persistence, and #27 owns the adapter that actually writes. If the writer
 * lived here, the reducer's module would have a code path to canonical state
 * and "the original commitment remains canonical" would rest on nobody calling
 * it. As an interface, the property is structural — the closure of
 * lib/decomposition/proposal/** contains no writer to reach, which is what
 * tests/decomposition/proposalBoundaries.test.ts checks.
 *
 * The port receives a whole batch rather than a step at a time, for the reason
 * Capture's adapter takes a command batch: a per-step call lets a failure land
 * halfway, leaving the user with three steps where they confirmed five and no
 * record of which two are missing. An implementation is expected to apply the
 * batch atomically or reject it whole; the store treats a throw as "nothing was
 * written" and reports `persistence_failed`.
 */

import type { ProposalConfirmedStep } from './proposalStateMachine';

export type { ProposalConfirmedStep };

/**
 * Everything an adapter needs to attach steps beside a commitment.
 *
 * `commitmentId` identifies what the steps belong *to*; there is deliberately
 * no field describing a change to that commitment. A decomposition adds a view
 * of a commitment and never rewrites it, so the batch has no way to express a
 * rewrite — an adapter cannot be talked into one by a malformed proposal
 * because the shape carries no instruction it could obey.
 */
export interface ConfirmedStepBatch {
  readonly proposalId: string;
  readonly commitmentId: string;
  readonly scopeId: string;
  /** Non-empty: the store does not call the port when nothing was confirmed. */
  readonly steps: readonly ProposalConfirmedStep[];
}

export interface DecompositionPersistencePort {
  /**
   * Writes the batch, or throws.
   *
   * Throwing is the only failure signal, so a partial success cannot be
   * reported as a success with a caveat nobody reads.
   */
  persistConfirmedSteps(batch: ConfirmedStepBatch): Promise<void>;
}
