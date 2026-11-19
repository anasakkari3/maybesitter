/**
 * Replan offers put away with «مش هلّق», for this run of the app (CA4.10).
 *
 * The answer is "not now", not "no": nothing is sent, and the offer stays on
 * the server. It used to live in the Calendar's component state, so a second
 * Calendar («شوف أبعد») or a tab reset drew the same offer again. Held in
 * memory only, by offer id — a newer offer is a new question and is shown;
 * a cold start asks again.
 */
import { useSyncExternalStore } from 'react';

const later = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function putOfferAway(proposalId: string): void {
  if (later.has(proposalId)) return;
  later.add(proposalId);
  version += 1;
  listeners.forEach(listener => listener());
}

/** Whether `proposalId` was put away; re-renders when one is. */
export function useOfferPutAway(proposalId: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version);
  return proposalId ? later.has(proposalId) : false;
}

/** Tests only. */
export function resetLaterOffersForTests(): void {
  later.clear();
  version += 1;
}
