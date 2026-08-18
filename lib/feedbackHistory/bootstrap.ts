/**
 * Wires the feedback history routes to the real event store.
 *
 * The port exists so #15's API could be built and tested while #13's store was
 * still being written in parallel. This module is the one place that joins
 * them, and it is imported for its side effect by each route.
 *
 * It is deliberately not a lazy default inside `getFeedbackHistoryPort()`: the
 * routes answer 503 when no port is installed, and tests rely on
 * `setFeedbackHistoryPort(null)` meaning exactly that. A fallback that quietly
 * revived the real store would make "unavailable" untestable, and an
 * unavailable history that reports success is the failure mode this whole
 * feature exists to avoid.
 */
import { createFileFeedbackEventStore } from '../feedback/feedbackEventStore';
import {
  createFeedbackHistoryPort,
  getFeedbackHistoryPort,
  setFeedbackHistoryPort,
} from './feedbackHistoryPort';

let bootstrapped = false;

/**
 * Installs the file-backed port once. Safe to call repeatedly, and it never
 * overwrites a port a test has already installed.
 */
export function installDefaultFeedbackHistoryPort(): void {
  if (bootstrapped || getFeedbackHistoryPort() !== null) return;
  setFeedbackHistoryPort(createFeedbackHistoryPort(createFileFeedbackEventStore()));
  bootstrapped = true;
}
