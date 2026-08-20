/**
 * Everything the control centre reads, named in one place.
 *
 * A port rather than four imports, for two reasons that are both about what the
 * tests can reach. The presenter must be drivable from in-memory stores with no
 * filesystem and no Next.js request, and `deriver` must be *nullable* — #41's
 * implementation lands on a different branch, and a presenter that imports it
 * directly could not be written until that merge. A seam that only exists to
 * let production wire itself is a seam nobody tests; this one is the only way
 * the presenter is ever called.
 *
 * `readAdaptiveSignals` is a function rather than a `DomainState`, because the
 * shipped path to those numbers (`deriveAdaptiveSignals`) reads a module-level
 * command-service state and this module reads no ambient anything. The route
 * supplies the closure; the tests supply a literal.
 */
import type { FeedbackEventStore } from '../../src/contracts/v1/feedbackContracts';
import type { RuntimeMemoryStore } from '../../src/contracts/v1/memoryContracts';
import type { PersonalizationDeriver } from '../../src/contracts/v1/personalizationContracts';
import type { AdaptiveSignals } from '../services/adaptiveService';
import type { PersonalizationConsentStore } from './consentStore';

export interface PersonalizationControlsPort {
  readonly feedback: FeedbackEventStore;
  readonly memory: RuntimeMemoryStore;
  readonly consent: PersonalizationConsentStore;
  /**
   * Null when no deriver is wired. The inventory then reports
   * `deriver_unavailable` rather than an empty reading set — "we have learned
   * nothing about you" and "the thing that learns is not connected" are
   * different sentences and a user is owed the true one.
   */
  readonly deriver: PersonalizationDeriver | null;
  readonly readAdaptiveSignals: () => AdaptiveSignals;
}
