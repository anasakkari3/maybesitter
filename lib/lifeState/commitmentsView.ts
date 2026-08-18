/**
 * CommitmentsView: what the system currently holds, counted.
 *
 * Always known. DomainState is the canonical home of commitments, so an empty
 * commitment map means "zero commitments", never "we don't know" — this is the
 * field where the Field<T> wrapper earns its keep by making that distinction
 * inspectable instead of implied.
 */
import type { CommitmentStatus } from '../../src/domain/stateMachine';
import type { CommitmentsView, Field } from '../../src/contracts/v1/lifeStateContracts';
import type { CommitmentFact } from './commitmentFacts';
import { knownField, newestTimestamp } from './fields';

/**
 * Fixed emission order for countsByStatus keys. Building the record in encounter
 * order would make its key order depend on commitment insertion order, which
 * survives deepEqual but breaks byte-identical replay output.
 */
const COMMITMENT_STATUS_ORDER: readonly CommitmentStatus[] = Object.freeze([
  'draft',
  'needs_clarification',
  'pending_confirmation',
  'active',
  'deferred',
  'completed',
  'dropped',
  'missed',
  'archived',
]);

function countsByStatus(facts: readonly CommitmentFact[]): Partial<Record<CommitmentStatus, number>> {
  const tally: Partial<Record<CommitmentStatus, number>> = {};
  for (const fact of facts) {
    const status = fact.commitment.status;
    tally[status] = (tally[status] || 0) + 1;
  }

  const ordered: Partial<Record<CommitmentStatus, number>> = {};
  for (const status of COMMITMENT_STATUS_ORDER) {
    const count = tally[status];
    if (count !== undefined) ordered[status] = count;
  }
  return ordered;
}

export function buildCommitmentsView(facts: readonly CommitmentFact[], computedAt: string): Field<CommitmentsView> {
  // Facts arrive id-sorted, so both id lists inherit a stable order for free.
  const openCommitmentIds = facts.filter((fact) => fact.isOpen).map((fact) => fact.commitment.id);
  const overdueCommitmentIds = facts.filter((fact) => fact.isOverdue).map((fact) => fact.commitment.id);

  const view: CommitmentsView = {
    countsByStatus: countsByStatus(facts),
    openCount: openCommitmentIds.length,
    overdueCount: overdueCommitmentIds.length,
    openCommitmentIds,
    overdueCommitmentIds,
  };

  return knownField(view, newestTimestamp(facts.map((fact) => fact.commitment.updatedAt)), computedAt);
}
