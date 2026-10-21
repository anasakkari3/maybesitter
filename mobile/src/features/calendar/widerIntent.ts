/**
 * «شوف أبعد» from the Plan's week (D54-2, M6A-R4-001): a one-shot intent the
 * calendar tab consumes once to open its wider view. A tiny store with a
 * listener, so a calendar tab already mounted in its stack opens it too.
 */
let pending = false;
const listeners = new Set<() => void>();

export function requestCalendarWider(): void {
  pending = true;
  for (const listener of listeners) listener();
}

/** True once per request; the request is gone after it is read. */
export function consumeCalendarWider(): boolean {
  const was = pending;
  pending = false;
  return was;
}

export function onCalendarWiderRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
