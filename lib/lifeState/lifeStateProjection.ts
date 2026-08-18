/**
 * The canonical Life-State projection (Sprint 02, issue #9).
 *
 * A pure read model over DomainState. It imports no writer — not commandService,
 * not deterministicStateGateway, not the data store — so "no model-generated
 * value becomes canonical state" holds by construction rather than by review;
 * tests/lifeState/lifeStateBoundaries.test.ts enforces it over the whole import
 * closure.
 *
 * Determinism is the load-bearing property. `computedAt` comes from `input.now`,
 * every derived collection is explicitly sorted, every record key is emitted in a
 * fixed order, and `inputDigest` is a sha256 over an explicitly canonicalized
 * input — so a replay can prove it ran against the same state and compare output
 * byte for byte.
 *
 * The four fields split on a single question: does the field describe something
 * DomainState canonically owns, or something about the world beyond our records?
 * `commitments` and `load` count what we own, so an empty state yields a known
 * zero. `availability` and `recentOutcomes` make claims about the user's time and
 * behaviour, so with no records they are unknown rather than confidently empty.
 */
import {
  LIFE_STATE_SCHEMA_VERSION,
  type LifeState,
  type LifeStateInput,
} from '../../src/contracts/v1/lifeStateContracts';
import { computeInputDigest, resolveWindowDays } from './canonicalInput';
import { deriveCommitmentFacts } from './commitmentFacts';
import { buildCommitmentsView } from './commitmentsView';
import { buildAvailabilityView } from './availabilityView';
import { buildLoadView } from './loadView';
import { buildRecentOutcomesView } from './recentOutcomesView';
import { parseIsoMs } from './fields';

function requireNowMs(now: string): number {
  const nowMs = parseIsoMs(now);
  if (nowMs === null) {
    throw new TypeError(`projectLifeState: now must be a valid ISO timestamp, received ${JSON.stringify(now)}`);
  }
  return nowMs;
}

function requireScopeId(scopeId: string): string {
  if (typeof scopeId !== 'string' || scopeId.trim().length === 0) {
    throw new TypeError('projectLifeState: scopeId must be a non-empty string');
  }
  return scopeId;
}

/**
 * Projects a Life-State read model from DomainState.
 *
 * Throws rather than defaulting on an unusable `now` or `scopeId`: a projection
 * stamped with a guessed clock or an unattributed scope would look valid, be
 * stored, and quietly fail to replay.
 */
export function projectLifeState(input: LifeStateInput): LifeState {
  const nowMs = requireNowMs(input.now);
  const scopeId = requireScopeId(input.scopeId);
  const windowDays = resolveWindowDays(input.windowDays);
  const computedAt = input.now;

  const facts = deriveCommitmentFacts(input.state, nowMs);

  return {
    version: LIFE_STATE_SCHEMA_VERSION,
    scopeId,
    computedAt,
    inputDigest: computeInputDigest({ state: input.state, now: input.now, scopeId, windowDays }),
    commitments: buildCommitmentsView(facts, computedAt),
    availability: buildAvailabilityView(facts, computedAt),
    load: buildLoadView(facts, computedAt),
    recentOutcomes: buildRecentOutcomesView(facts, windowDays, nowMs, computedAt),
  };
}
