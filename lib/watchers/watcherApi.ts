/**
 * What `/api/mobile/watchers/**` is allowed to say and to be told (#525).
 *
 * The routes are four thin files; every decision that matters lives here, so
 * that "what a client may configure" is one readable list rather than four
 * handlers that each remember most of it.
 *
 * ── The body cannot choose the tree, the capability or the identity ──
 *
 * `parseNewWatcher` returns a `NewWatcherInput`, whose type has no `scopeId`,
 * no `watcherId` and no runtime on it at all: the uid comes from the verified
 * token and the id is minted by the store. `effect` is one of four closed
 * names, each of which maps — in `WATCHER_EFFECT_CAPABILITIES`, not here — to
 * a fixed local capability. There is no field a request can set that reaches
 * an Action Policy capability, which is what makes "a watcher cannot send
 * provider writes" a property of the shapes rather than of a check somebody
 * has to remember.
 *
 * A body may not claim `createdBy: 'pack_template'` either: that attribution
 * is the server's, made when a pack is enabled, and a client-minted one would
 * be a pack watcher belonging to no pack — see `parseNewWatcher`.
 *
 * ── Unknown keys are refused ──────────────────────────────────────
 *
 * A body carrying a key this module does not know is a 400, not a silent
 * drop. The failure mode being avoided is the client that configures
 * `threshold: 0.4`, gets a 200, and is never told the watcher it created
 * watches something else.
 *
 * ── Editing re-primes ─────────────────────────────────────────────
 *
 * Enabling a paused watcher, or changing what it watches for, clears the
 * stored baseline. The engine only fires on a transition *from* a baseline, so
 * an unprimed watcher's next observation primes and does not fire — which is
 * how "reconnect resumes without replaying historical triggers" and "a
 * retuned threshold does not fire on yesterday's reading" are the same one
 * mechanism.
 */
import {
  isWatchCondition,
  isWatcherEffect,
  isWatcherIdentifier,
  isWatcherSubjectRef,
  type WatchCondition,
  type WatcherEffect,
  type WatcherFireEvent,
  type WatcherSourceRef,
} from '../../src/contracts/v1/watcherContracts';
import type { NewWatcherInput, StoredWatcher } from './watcherStore';

export class WatcherValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'WatcherValidationError';
  }
}

/** History is bounded so one account's long-lived watcher cannot make an unbounded read. */
export const WATCHER_HISTORY_DEFAULT_LIMIT = 50;
export const WATCHER_HISTORY_MAX_LIMIT = 200;

/** A provider name is a short lowercase token, never a URL and never free text. */
const PROVIDER = /^[a-z][a-z0-9_]{0,31}$/;
/** The store mints `wtc_<uuid>`; nothing else is a watcher id this API will look up. */
const WATCHER_ID = /^wtc_[0-9a-fA-F-]{36}$/;

const NEW_KEYS = new Set(['enabled', 'source', 'condition', 'effect', 'createdBy', 'label']);
const SOURCE_KEYS = new Set(['provider', 'connectionId', 'signalKind', 'subjectRef']);
const PATCH_KEYS = new Set(['enabled', 'condition', 'effect', 'label']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknown(body: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new WatcherValidationError(`${where} does not accept "${key}"`, 'unknown_field');
    }
  }
}

/** `wtc_<uuid>` and nothing else, checked before any read so a path segment cannot be a probe. */
export function parseWatcherId(raw: unknown): string {
  if (typeof raw !== 'string' || !WATCHER_ID.test(raw)) {
    throw new WatcherValidationError('not a watcher id', 'invalid_watcher_id');
  }
  return raw;
}

function parseSource(raw: unknown): WatcherSourceRef {
  if (!isRecord(raw)) throw new WatcherValidationError('source must be an object', 'invalid_source');
  refuseUnknown(raw, SOURCE_KEYS, 'source');

  if (typeof raw.provider !== 'string' || !PROVIDER.test(raw.provider)) {
    throw new WatcherValidationError('source.provider must be a provider name', 'invalid_provider');
  }
  // `null` and a connection id are both meaningful and are not the same thing:
  // null says "this signal needs no grant" (readiness on the account, a shared
  // fixture) and is the one case a watcher never blocks on a disconnect. A
  // missing key would make that choice by accident, so it must be written.
  if (raw.connectionId !== null && (typeof raw.connectionId !== 'string' || raw.connectionId.length === 0 || raw.connectionId.length > 200)) {
    throw new WatcherValidationError('source.connectionId must be a connection id or null', 'invalid_connection_id');
  }
  if (!isWatcherIdentifier(raw.signalKind)) {
    throw new WatcherValidationError('source.signalKind must be a normalized signal kind', 'invalid_signal_kind');
  }
  if (!isWatcherSubjectRef(raw.subjectRef)) {
    throw new WatcherValidationError('source.subjectRef must be an opaque subject reference', 'invalid_subject_ref');
  }
  return {
    provider: raw.provider,
    connectionId: raw.connectionId,
    signalKind: raw.signalKind,
    subjectRef: raw.subjectRef,
  };
}

function parseCondition(raw: unknown): WatchCondition {
  if (!isWatchCondition(raw)) {
    throw new WatcherValidationError('condition is not a watch condition', 'invalid_condition');
  }
  return raw;
}

function parseEffect(raw: unknown): WatcherEffect {
  if (!isWatcherEffect(raw)) {
    // The four names are the whole vocabulary. Anything else — including a
    // capability id somebody hoped would be passed through — is a 400 here,
    // long before the Action Policy is consulted.
    throw new WatcherValidationError('effect is not one of the four watcher effects', 'invalid_effect');
  }
  return raw;
}

export function parseNewWatcher(body: unknown): NewWatcherInput {
  if (!isRecord(body)) throw new WatcherValidationError('body must be an object', 'invalid_body');
  refuseUnknown(body, NEW_KEYS, 'a watcher');

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new WatcherValidationError('enabled must be a boolean', 'invalid_enabled');
  }
  let label: string | undefined;
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.trim().length === 0 || body.label.length > 100) {
      throw new WatcherValidationError('label must be a string of at most 100 characters', 'invalid_label');
    }
    label = body.label.trim();
  }
  // `pack_template` is refused here, not merely validated (#528). The value is
  // an attribution the *server* makes when `enablePack` installs a pack's
  // template, and it is load-bearing: a pack watcher is expected to appear on
  // exactly one installation record, which is the only thing that can ever
  // switch it off again. A client that could mint one would create a live
  // watcher nothing in the product can stop, so the only value a body may
  // carry is the one it would have defaulted to.
  if (body.createdBy !== undefined && body.createdBy !== 'user') {
    throw new WatcherValidationError(
      'createdBy must be "user"; a pack\'s watchers are installed by enabling the pack',
      'invalid_created_by',
    );
  }
  return {
    enabled: body.enabled ?? true,
    ...(label ? { label } : {}),
    source: parseSource(body.source),
    condition: parseCondition(body.condition),
    effect: parseEffect(body.effect),
    createdBy: 'user',
  };
}

export interface WatcherPatch {
  readonly enabled?: boolean;
  readonly label?: string;
  readonly condition?: WatchCondition;
  readonly effect?: WatcherEffect;
}

/**
 * What a PATCH may change: whether it runs, what it watches for, and what it
 * does. Not `source` — a watcher pointed at a different subject, provider or
 * connection is a different watcher, and repointing one in place would carry a
 * baseline from the old subject into the new one. The client creates a new
 * watcher and deletes the old one, which is also what the history needs.
 */
export function parseWatcherPatch(body: unknown): WatcherPatch {
  if (!isRecord(body)) throw new WatcherValidationError('body must be an object', 'invalid_body');
  if ('source' in body) {
    throw new WatcherValidationError('a watcher\'s source cannot be changed; create a new watcher', 'source_immutable');
  }
  refuseUnknown(body, PATCH_KEYS, 'a watcher patch');
  if (Object.keys(body).length === 0) {
    throw new WatcherValidationError('nothing to change', 'empty_patch');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new WatcherValidationError('enabled must be a boolean', 'invalid_enabled');
  }
  let label: string | undefined;
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.trim().length === 0 || body.label.length > 100) {
      throw new WatcherValidationError('label must be a string of at most 100 characters', 'invalid_label');
    }
    label = body.label.trim();
  }
  return {
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(label === undefined ? {} : { label }),
    ...(body.condition === undefined ? {} : { condition: parseCondition(body.condition) }),
    ...(body.effect === undefined ? {} : { effect: parseEffect(body.effect) }),
  };
}

export function parseHistoryLimit(raw: string | null): number {
  if (raw === null) return WATCHER_HISTORY_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WATCHER_HISTORY_MAX_LIMIT) {
    throw new WatcherValidationError(`limit must be an integer between 1 and ${WATCHER_HISTORY_MAX_LIMIT}`, 'invalid_limit');
  }
  return parsed;
}

/**
 * The baseline a watcher carries when it has never been primed.
 *
 * Applied on every edit that changes what "unchanged" means — enabling, a new
 * condition, a new effect — so the next observation primes instead of firing
 * against a baseline that answered a different question.
 */
export function unprimedRuntime(runtime: StoredWatcher['runtime'], now: string): StoredWatcher['runtime'] {
  return {
    ...runtime,
    lastSignalId: null,
    lastDigest: null,
    lastMeasures: [],
    lastObservedAt: null,
    updatedAt: now,
  };
}

/**
 * Applies a patch, and decides what it does to the runtime.
 *
 * Disabling parks the watcher at `paused` immediately rather than waiting for
 * the next sweep to notice, so the API never reports a watcher as running
 * after the user turned it off. Everything else re-primes; nothing here can
 * make a watcher fire.
 */
export function applyWatcherPatch(current: StoredWatcher, patch: WatcherPatch, now: string): StoredWatcher {
  const definition = {
    ...current.definition,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.label === undefined ? {} : { label: patch.label }),
    ...(patch.condition === undefined ? {} : { condition: patch.condition }),
    ...(patch.effect === undefined ? {} : { effect: patch.effect }),
    updatedAt: now,
  };
  const disabled = patch.enabled === false;
  const rePrimes = patch.enabled === true || patch.condition !== undefined || patch.effect !== undefined;
  const runtime = rePrimes ? unprimedRuntime(current.runtime, now) : { ...current.runtime, updatedAt: now };
  return {
    definition,
    runtime: disabled
      ? { ...runtime, status: 'paused', blockedReason: null }
      : runtime,
  };
}

/* ── Presentation ────────────────────────────────────────────────── */

/**
 * One watcher as the client reads it.
 *
 * The definition and the runtime, flattened and nothing more: no stored
 * digest, no measure and no provenance pointer leaves this boundary. They are
 * engine internals, and a digest on the wire would be the one field a client
 * could learn to compare — i.e. to infer provider state the contract
 * deliberately does not carry.
 */
export function presentWatcher(stored: StoredWatcher) {
  const { definition, runtime } = stored;
  return {
    watcherId: definition.watcherId,
    enabled: definition.enabled,
    label: definition.label ?? null,
    status: runtime.status,
    blockedReason: runtime.blockedReason,
    source: {
      provider: definition.source.provider,
      connectionId: definition.source.connectionId,
      signalKind: definition.source.signalKind,
      subjectRef: definition.source.subjectRef,
    },
    condition: definition.condition,
    effect: definition.effect,
    createdBy: definition.createdBy,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    lastObservedAt: runtime.lastObservedAt,
    lastFiredAt: runtime.lastFiredAt,
    fireCount: runtime.fireCount,
  };
}

/**
 * One firing as the client reads it: when, why, what it did, and the
 * provenance pointer that says where the observation came from. Every row
 * carries a `reason` and a `provenanceRef` because the issue requires that
 * every execution does, and a history that omitted either would be the place
 * the requirement quietly stopped holding.
 */
export function presentWatcherEvent(event: WatcherFireEvent) {
  return {
    eventId: event.eventId,
    watcherId: event.watcherId,
    signalId: event.signalId,
    provider: event.provider,
    signalKind: event.signalKind,
    subjectRef: event.subjectRef,
    observedAt: event.observedAt,
    firedAt: event.firedAt,
    effect: event.effect,
    outcome: event.outcome,
    reason: event.reason,
    policyDecision: event.policyDecision,
    provenanceRef: event.provenanceRef,
    effectRef: event.effectRef,
  };
}

export function watcherValidationResponse(error: WatcherValidationError): Response {
  return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
}
