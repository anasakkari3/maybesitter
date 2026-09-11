/**
 * Alpha trace recorder.
 *
 * Facade used by mobile API routes to append trace stages. Recording is
 * enabled only when MAYBESITTER_ALPHA_TRACE_ENABLED=true (alpha-only).
 * All methods are no-ops when disabled, so instrumentation never changes
 * product behavior.
 */
import { randomUUID } from 'node:crypto';
import type { AlphaTraceStageRecord } from '../../src/contracts/v1/alphaTraceContracts';
import { createFileAlphaTraceStore, isValidTraceSessionId, type AlphaTraceStore } from './alphaTraceStore';

export function isTraceEnabled(): boolean {
  return process.env.MAYBESITTER_ALPHA_TRACE_ENABLED === 'true';
}

let _store: AlphaTraceStore | null = null;

export function getTraceStore(): AlphaTraceStore {
  if (!_store) _store = createFileAlphaTraceStore();
  return _store;
}

/** Testing hook: replace the backing store. */
export function setTraceStoreForTesting(store: AlphaTraceStore | null): void {
  _store = store;
}

export function stage(stage: AlphaTraceStageRecord['stage'], payload: Record<string, unknown>): AlphaTraceStageRecord {
  return { stage, timestamp: new Date().toISOString(), payload };
}

/** Append a stage if tracing is enabled; returns true when recorded. */
export function recordTraceStage(sessionId: string, participantId: string, record: AlphaTraceStageRecord): boolean {
  if (!isTraceEnabled() || !sessionId || !participantId) return false;
  try {
    getTraceStore().append(sessionId, participantId, record);
    return true;
  } catch {
    // A refused id or a session owned by somebody else. Instrumentation must
    // never change product behaviour, so this is a false return rather than an
    // exception thrown into the capture path.
    return false;
  }
}

/**
 * Resolve a session id from an optional client-provided value, or derive one.
 *
 * The client value is honoured only when it is already a plain token; anything
 * else is replaced rather than trimmed, because it reaches the store as a
 * filename and as the key another participant's trace is read by.
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
