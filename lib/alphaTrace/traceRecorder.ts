/**
 * Alpha trace recorder.
 *
 * Facade used by mobile API routes to append trace stages. Recording is
 * enabled only when MAYBESITTER_ALPHA_TRACE_ENABLED=true (alpha-only).
 * All methods are no-ops when disabled, so instrumentation never changes
 * product behavior.
 *
 * Async since UC-1.0c (#142): a stage is a storage write under
 * `users/{uid}/alphaTraces`. It is still swallowed rather than thrown —
 * instrumentation must not break the capture path — but callers await it, so a
 * trace is actually on disk before the response goes out rather than racing it.
 */
import { randomUUID } from 'node:crypto';
import type { AlphaTraceStageRecord } from '../../src/contracts/v1/alphaTraceContracts';
import { createStorageAlphaTraceStore, isValidTraceSessionId, type AlphaTraceStore } from './alphaTraceStore';

export function isTraceEnabled(): boolean {
  return process.env.MAYBESITTER_ALPHA_TRACE_ENABLED === 'true';
}

let _store: AlphaTraceStore | null = null;

export function getTraceStore(): AlphaTraceStore {
  if (!_store) _store = createStorageAlphaTraceStore();
  return _store;
}

/** Testing hook: replace the backing store. */
export function setTraceStoreForTesting(store: AlphaTraceStore | null): void {
  _store = store;
}

export function stage(stage: AlphaTraceStageRecord['stage'], payload: Record<string, unknown>): AlphaTraceStageRecord {
  return { stage, timestamp: new Date().toISOString(), payload };
}

/** Append a stage if tracing is enabled; resolves true when recorded. */
export async function recordTraceStage(
  sessionId: string,
  participantId: string,
  record: AlphaTraceStageRecord,
): Promise<boolean> {
  if (!isTraceEnabled() || !sessionId || !participantId) return false;
  try {
    await getTraceStore().append(sessionId, participantId, record);
    return true;
  } catch {
    // A refused id, a session owned by somebody else, or a storage fault.
    // Instrumentation must never change product behaviour, so this is a false
    // return rather than an exception thrown into the capture path.
    return false;
  }
}

/**
 * Resolve a session id from an optional client-provided value, or derive one.
 *
 * The client value is honoured only when it is already a plain token; anything
 * else is replaced rather than trimmed, because it becomes a document id and
 * the key another participant's trace is read by.
 *
 * The derived form is random rather than `${participantId}-${timestamp}`: with
 * allowlisted participant ids the only unknown in that form was a base36
 * millisecond, which is sprayable in a pilot of a few dozen people.
 */
export function resolveTraceSessionId(clientSessionId: unknown, participantId: string): string {
  if (typeof clientSessionId === 'string' && isValidTraceSessionId(clientSessionId.trim())) {
    return clientSessionId.trim();
  }
  return `alpha-${randomUUID()}`;
}
