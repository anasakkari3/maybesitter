/**
 * The control centre's request handling, kept out of the route.
 *
 * The route parses JSON and nothing else; every decision below is reachable
 * from a test with no server, no port, and no filesystem — which is the only
 * reason any of it is tested at all. `lib/recommendation/review/present.ts` is
 * the same shape and the reason it is the shape.
 *
 * ── Reports, never throws ────────────────────────────────────────
 *
 * Every field read here is on an object a caller built, so every read can be
 * hostile. A handler that throws turns a bad request into a 500 and a stack
 * trace, which tells the client nothing it can act on. Every rejection names a
 * code in one vocabulary instead.
 *
 * ── `now` comes from the caller, and is required ─────────────────
 *
 * Not defaulted to `Date.now()`. Consent changes, corrections and deletion
 * receipts all carry an instant that a user may later be shown, and an instant
 * this module invented is one nobody can reproduce. A request without one is
 * `MISSING_INSTANT`, in the same spirit as the review route's
 * `MISSING_EVALUATION_INSTANT`.
 *
 * ── Export is not the same verb as training-export ───────────────
 *
 * `exportInventory` hands the user their own data. `ExportPolicy` and
 * `assertNoPersonalMemory` are about a *different* boundary — what may leave for
 * fine-tuning — and conflating them would either leak personal memory into
 * training or refuse to show people their own records. `assertNoPersonalMemory`
 * is therefore deliberately **not** called here, and `fineTuningExportable`
 * marks each record so the caller can see which side of that line it sits on.
 */
import {
  isInstant,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_LEVEL_VOCABULARY,
  type Instant,
  type PreferenceDimension,
  type PreferenceLevel,
} from '../../src/contracts/v1/personalizationContracts';
import { isFineTuningExportable } from '../runtimeMemory/exportPolicy';
import { applyCorrection, clearCorrection } from './correction';
import { buildPersonalizationInventory, type PersonalizationInventoryView } from './inventory';
import type { PersonalizationControlsPort } from './controlsPort';

export const CONTROLS_REJECTION_CODES = Object.freeze([
  'MALFORMED_REQUEST_BODY',
  'MISSING_SCOPE',
  'MISSING_INSTANT',
  'MALFORMED_INSTANT',
  'UNKNOWN_ACTION',
  'UNKNOWN_DIMENSION',
  'UNKNOWN_LEVEL',
  'UNKNOWN_RECORD',
  'STORE_REJECTED',
] as const);

export type ControlsRejectionCode = (typeof CONTROLS_REJECTION_CODES)[number];

export interface ControlsRejection {
  readonly kind: 'rejected';
  readonly code: ControlsRejectionCode;
  readonly detail: string;
}

export interface ControlsOutcome {
  readonly status: number;
  readonly response: unknown;
}

function reject(code: ControlsRejectionCode, detail: string, status = 400): ControlsOutcome {
  return { status, response: { kind: 'rejected', code, detail } satisfies ControlsRejection };
}

function readString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function isDimension(value: string): value is PreferenceDimension {
  return (PREFERENCE_DIMENSIONS as readonly string[]).includes(value);
}

/** Levels are per-dimension, so a level valid for one may be invalid for another. */
function isLevelFor(dimension: PreferenceDimension, value: string): value is PreferenceLevel {
  return (PREFERENCE_LEVEL_VOCABULARY[dimension] as readonly string[]).includes(value);
}

export interface ExportedInventory {
  readonly view: PersonalizationInventoryView;
  readonly memoryRecords: readonly {
    readonly id: string;
    readonly kind: string;
    readonly content: string;
    readonly status: string;
    readonly source: string;
    readonly observedAt: string;
    /** Whether this record may ever leave for model training. See the header. */
    readonly fineTuningExportable: boolean;
  }[];
}

export function exportInventory(
  port: PersonalizationControlsPort,
  scopeId: string,
  now: Instant,
): ExportedInventory {
  return {
    view: buildPersonalizationInventory(port, scopeId, now),
    memoryRecords: port.memory.listAll(scopeId).map((record) => ({
      id: record.id,
      kind: record.kind,
      content: record.content,
      status: record.status,
      source: record.source,
      observedAt: record.observedAt,
      fineTuningExportable: isFineTuningExportable(record),
    })),
  };
}

/**
 * One entry point for every control-centre action.
 *
 * `deletePersonalizationScope` is #41's, and it is passed in rather than
 * imported: it lands on a different branch, and the integration wires it. Until
 * then a delete request is refused honestly rather than half-performed.
 */
export interface ControlsHandlerDeps {
  readonly port: PersonalizationControlsPort;
  readonly deleteScope?: (scopeId: string, now: Instant) => unknown;
}

export function handleControlsRequest(deps: ControlsHandlerDeps, body: unknown): ControlsOutcome {
  const parsed = asObject(body);
  if (parsed === null) return reject('MALFORMED_REQUEST_BODY', 'the request body is not an object');

  const scopeId = readString(parsed, 'scopeId');
  if (scopeId === null) return reject('MISSING_SCOPE', 'scopeId is required and must be a non-empty string');

  const now = readString(parsed, 'now');
  if (now === null) return reject('MISSING_INSTANT', 'now is required; this module never reads a clock');
  // Checked with `isInstant`, not merely for being a non-empty string. Every
  // store below parses this value and *throws* on a bad one — the consent store,
  // the aggregator and the memory query each raise their own error — so a
  // caller who sent `now: "yesterday"` got a 500 and a stack trace out of the
  // module whose header promises it reports rather than throws. `2026-02-30`
  // is the case a regex would miss: it parses, to the 2nd of March.
  if (!isInstant(now)) {
    return reject('MALFORMED_INSTANT', `now is not an ISO instant with an explicit offset: ${now}`);
  }

  const action = readString(parsed, 'action');
  const { port } = deps;

  switch (action) {
    case 'inventory':
      return { status: 200, response: buildPersonalizationInventory(port, scopeId, now) };

    case 'export':
      return { status: 200, response: exportInventory(port, scopeId, now) };

    case 'enable':
    case 'disable': {
      const state = action === 'enable' ? 'enabled' : 'disabled';
      const consent = port.consent.write(scopeId, state, now);
      // The inventory is rebuilt in the same response, so a client cannot show
      // a stale profile beside a flipped toggle even if it wanted to.
      return {
        status: 200,
        response: { kind: 'consent_written', consent, view: buildPersonalizationInventory(port, scopeId, now) },
      };
    }

    case 'correct': {
      const dimension = readString(parsed, 'dimension');
      if (dimension === null || !isDimension(dimension)) {
        return reject('UNKNOWN_DIMENSION', `not a preference dimension: ${String(parsed.dimension)}`);
      }
      const level = readString(parsed, 'level');
      if (level === null || !isLevelFor(dimension, level)) {
        return reject('UNKNOWN_LEVEL', `not a level of ${dimension}: ${String(parsed.level)}`);
      }
      const result = applyCorrection(port.memory, scopeId, dimension, level, now);
      if (!result.ok) return reject('STORE_REJECTED', `the correction was not stored: ${result.reason}`);
      return {
        status: 200,
        response: { kind: 'corrected', record: result.record, view: buildPersonalizationInventory(port, scopeId, now) },
      };
    }

    case 'clear_correction': {
      const dimension = readString(parsed, 'dimension');
      if (dimension === null || !isDimension(dimension)) {
        return reject('UNKNOWN_DIMENSION', `not a preference dimension: ${String(parsed.dimension)}`);
      }
      const cleared = clearCorrection(port.memory, scopeId, dimension, now);
      return {
        status: 200,
        response: { kind: 'correction_cleared', cleared, view: buildPersonalizationInventory(port, scopeId, now) },
      };
    }

    case 'revoke_memory': {
      const recordId = readString(parsed, 'recordId');
      if (recordId === null) return reject('UNKNOWN_RECORD', 'recordId is required');
      // Ownership, before the write. `RuntimeMemoryStore.revoke(id, at)` takes
      // no scope and revokes by id alone, so without this check any caller
      // could revoke any other user's record by supplying its id and their own
      // `scopeId` — a cross-scope write through an endpoint with no auth. The
      // rejection copy below already claimed "in this scope"; now it is true.
      const record = port.memory.get(recordId);
      if (record === null || record.scopeId !== scopeId) {
        return reject('UNKNOWN_RECORD', 'no revocable record with that id in this scope');
      }
      if (!port.memory.revoke(recordId, now)) {
        // False means absent or already revoked. Both are "there is nothing here
        // to revoke", and distinguishing them for a caller who supplied an id
        // would confirm whether that id exists.
        return reject('UNKNOWN_RECORD', 'no revocable record with that id in this scope');
      }
      return { status: 200, response: { kind: 'memory_revoked', view: buildPersonalizationInventory(port, scopeId, now) } };
    }

    case 'revoke_feedback': {
      const eventId = readString(parsed, 'eventId');
      if (eventId === null) return reject('UNKNOWN_RECORD', 'eventId is required');
      // Same cross-scope hole as `revoke_memory`, same fix. A revoked feedback
      // event stops contributing to its owner's profile, so this was a way to
      // reshape a stranger's personalization from an unauthenticated route.
      const event = port.feedback.get(eventId);
      if (event === null || event.scopeId !== scopeId) {
        return reject('UNKNOWN_RECORD', 'no revocable event with that id in this scope');
      }
      if (!port.feedback.revoke(eventId, now)) {
        return reject('UNKNOWN_RECORD', 'no revocable event with that id in this scope');
      }
      return { status: 200, response: { kind: 'feedback_revoked', view: buildPersonalizationInventory(port, scopeId, now) } };
    }

    case 'delete': {
      if (deps.deleteScope === undefined) {
        return reject('STORE_REJECTED', 'deletion is not wired in this build', 501);
      }
      const receipt = deps.deleteScope(scopeId, now);
      port.consent.deleteScope(scopeId);
      return {
        status: 200,
        response: { kind: 'deleted', receipt, view: buildPersonalizationInventory(port, scopeId, now) },
      };
    }

    default:
      return reject('UNKNOWN_ACTION', `not an action this endpoint offers: ${String(parsed.action)}`);
  }
}
