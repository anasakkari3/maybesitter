/**
 * Alpha trace recorder.
 *
 * Facade used by mobile API routes to append trace stages. Recording is
 * enabled only when MAYBESITTER_ALPHA_TRACE_ENABLED=true (alpha-only).
 * All methods are no-ops when disabled, so instrumentation never changes
 * product behavior.
 */
import type { AlphaTraceStageRecord } from '../../src/contracts/v1/alphaTraceContracts';
import { createFileAlphaTraceStore, type AlphaTraceStore } from './alphaTraceStore';

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
  getTraceStore().append(sessionId, participantId, record);
  return true;
}

/** Resolve a session id from an optional client-provided value or derive one. */
export function resolveTraceSessionId(clientSessionId: unknown, participantId: string): string {
  if (typeof clientSessionId === 'string' && clientSessionId.trim().length > 0 && clientSessionId.trim().length <= 128) {
    return clientSessionId.trim();
  }
  return `alpha-${participantId}-${Date.now().toString(36)}`;
}
