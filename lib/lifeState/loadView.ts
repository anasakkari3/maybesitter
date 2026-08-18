/**
 * LoadView: how much open work the user is carrying.
 *
 * Always known. Load is a total function over the open commitment set, so an
 * empty set is a real load of zero rather than an absence of information — the
 * mirror image of availability, where an empty result would have been a claim
 * about the world the repo cannot back.
 *
 * The formula is deliberately dull and inspectable: sum the existing agenda
 * urgency scores, and band on open count using the thresholds exported from the
 * contract. Overdue and due-soon counts are reported alongside but do not move
 * the band, so the banding rule stays exactly LOAD_BAND_THRESHOLDS and can be
 * revised with the schema version rather than by archaeology in this file.
 */
import { LOAD_BAND_THRESHOLDS, type Field, type LoadBand, type LoadView } from '../../src/contracts/v1/lifeStateContracts';
import type { CommitmentFact } from './commitmentFacts';
import { knownField, newestTimestamp } from './fields';

export function bandForOpenCount(openCount: number): LoadBand {
  if (openCount <= LOAD_BAND_THRESHOLDS.light) return 'light';
  if (openCount <= LOAD_BAND_THRESHOLDS.moderate) return 'moderate';
  if (openCount <= LOAD_BAND_THRESHOLDS.heavy) return 'heavy';
  return 'overloaded';
}

export function buildLoadView(facts: readonly CommitmentFact[], computedAt: string): Field<LoadView> {
  const openFacts = facts.filter((fact) => fact.isOpen);

  // The agenda scorer returns clamped integers, so summing them is exact and the
  // total cannot drift with accumulation order; facts arrive id-sorted regardless.
  let totalUrgencyScore = 0;
  for (const fact of openFacts) totalUrgencyScore += fact.urgencyScore;

  const view: LoadView = {
    totalUrgencyScore,
    openCount: openFacts.length,
    overdueCount: facts.filter((fact) => fact.isOverdue).length,
    dueSoonCount: facts.filter((fact) => fact.isDueSoon).length,
    band: bandForOpenCount(openFacts.length),
  };

  return knownField(view, newestTimestamp(openFacts.map((fact) => fact.commitment.updatedAt)), computedAt, facts.length > 0);
}
