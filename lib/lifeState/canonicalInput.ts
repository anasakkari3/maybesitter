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
 * A window of zero or a fraction of a day would silently produce an empty
 * recent-outcomes window, which reads as "no outcomes" rather than "bad input",
 * so anything non-positive falls back to the contract default and anything
 * fractional floors to at least one whole day.
 */
export function resolveWindowDays(windowDays: number | undefined): number {
  if (typeof windowDays !== 'number' || !Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS;
  }
  return Math.max(1, Math.floor(windowDays));
}

/**
 * Field selection is explicit rather than a whole-object dump so that a caller
 * passing extra properties on the input object cannot perturb the digest, while
 * DomainState itself is canonicalized generically so no part of the state can be
 * silently dropped from the digest as the domain grows.
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
    state: {
      commitments: input.state.commitments,
      reminders: input.state.reminders,
      escalationStates: input.state.escalationStates,
    },
  });
}

export function computeInputDigest(input: ResolvedLifeStateInput): string {
  return sha256Hex(canonicalizeLifeStateInput(input));
}
