/**
 * Canonicalization of the Life-State projection input, and the replay digest
 * computed from it.
 *
 * `LifeState.inputDigest` only earns its keep if two structurally identical
 * inputs hash identically. JavaScript object key order is insertion order, so a
 * DomainState rebuilt from a different source — a different store, a replayed
 * event log, a reordered JSON file — serializes differently under
 * `JSON.stringify` while being the same state. Canonicalization is therefore
 * explicit and key-sorted rather than incidental.
 *
 * The digest covers the *resolved* input: two calls that must produce identical
 * output (windowDays omitted vs. passed explicitly as the default) must also
 * produce identical digests, otherwise a replay reports a false mismatch.
 */
import { canonicalJson, sha256Hex } from '../evaluation/registry/fingerprint';
import {
  DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS,
  LIFE_STATE_SCHEMA_VERSION,
} from '../../src/contracts/v1/lifeStateContracts';
import type { DomainState } from '../../src/domain/stateMachine';

/** A LifeStateInput with every optional field resolved to a concrete value. */
export interface ResolvedLifeStateInput {
  readonly state: DomainState;
  readonly now: string;
  readonly scopeId: string;
  readonly windowDays: number;
}

/**
 * The ECMAScript time range is +/-100,000,000 days around the epoch, so any
 * window at least that long already reaches the start of representable time.
 */
const MAX_WINDOW_DAYS = 100_000_000;

/**
 * A window of zero or a fraction of a day would silently produce an empty
 * recent-outcomes window, which reads as "no outcomes" rather than "bad input",
 * so anything non-positive falls back to the contract default and anything
 * fractional floors to at least one whole day.
 */
export function resolveWindowDays(windowDays: number | undefined): number {
  if (typeof windowDays !== 'number' || !Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS;
  }
  // Clamped so the derived windowStart stays a representable Date: a window of
  // 1e9 days lands outside the ECMAScript time range and new Date(...)
  // .toISOString() throws a RangeError from deep inside the projection, past
  // every validation boundary this module presents to its callers.
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(windowDays)));
}

/**
 * The top-level fields are listed explicitly so that extra properties on the
 * input object cannot perturb the digest, while DomainState is passed whole so
 * no part of the state can be silently dropped from the digest as the domain
 * grows.
 *
 * The schema version is part of the preimage: digests recorded under a different
 * LifeState schema must never collide with digests recorded under this one.
 */
export function canonicalizeLifeStateInput(input: ResolvedLifeStateInput): string {
  return canonicalJson({
    version: LIFE_STATE_SCHEMA_VERSION,
    now: input.now,
    scopeId: input.scopeId,
    windowDays: input.windowDays,
    // Passed whole, not field by field: canonicalJson sorts keys recursively, so
    // a field added to DomainState later is covered automatically. Enumerating
    // the fields here would silently exclude any new one, and two inputs
    // differing only in it would then share a digest — a replay would report
    // "same input" for inputs that are not the same, which is the one thing the
    // digest exists to prevent.
    state: input.state,
  });
}

export function computeInputDigest(input: ResolvedLifeStateInput): string {
  return sha256Hex(canonicalizeLifeStateInput(input));
}
