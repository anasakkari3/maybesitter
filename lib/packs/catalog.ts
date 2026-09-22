/**
 * The three packs, as manifests (#528, slice 2).
 *
 * Football, athlete and travel — the issue's own three examples — expressed
 * the way the issue insists they must be: *configurations* over the shared
 * Watcher/Trigger pipeline, not three vertical implementations. There is no
 * football engine in this file and no WHOOP branch; there is a signal kind, a
 * condition, an effect and a declaration of what each pack is allowed to do.
 * `tests/packs/realPackConformance.test.ts` runs all three through the same
 * `runPackConformance` the synthetic pack passes, unchanged.
 *
 * ── Every template's condition is `digest_changed`, on purpose ─────
 *
 * The normalized observers already reduce a provider's state to one digest
 * over the facts a condition may be about: the fixture store's row is
 * content-hashed, so "the match moved" and "the digest moved" are the same
 * statement; the readiness observer digests band and score, so a WHOOP
 * payload that churned without moving either is NO_EFFECT rather than a
 * firing. A threshold condition is available (`WatchCondition`) and a pack
 * may use one, but none of these three needs to reach past the digest to say
 * what it watches.
 *
 * ── What is real here, and what is declared ahead of the plumbing ──
 *
 * Real today: `fixture` and `readiness` are the two signal kinds
 * `lib/watchers/signals.ts` ships observers for, over
 * `lib/football/fixtureStore.ts` and the UserState readiness projection that
 * `lib/integrations/readiness/{whoop,healthkit,healthConnect}.ts` feed.
 *
 * Declared ahead of its observer: `flight`. The travel foundation that exists
 * is `lib/planning/constraints/travel.ts` — the projection of a travel
 * estimate into planning constraints — and there is no shipped flight-status
 * observer; `flight` is the vocabulary `tests/watchers/watcherEngine.test.ts`
 * already uses for one. The manifest names it so the pack is expressed in the
 * shared language now; wiring an observer is not this slice.
 *
 * Also declared ahead of its plumbing: football's connection. Football today
 * has no per-account `IntegrationConnection` — the API key is the service's
 * and the per-user grant is the followed-club list
 * (`lib/football/followedClubs.ts`). The manifest declares the fixture-status
 * source as a connection because the shared pipeline's disconnect, re-auth
 * and revoke behaviour is what makes a pack a pack; the record that backs it
 * is unbuilt.
 */

import {
  VERTICAL_PACK_CONTRACT_VERSION,
  VERTICAL_PACK_SCHEMA_VERSION,
  WATCHER_TEMPLATE_SCHEMA_VERSION,
  type VerticalPackDefinition,
} from '../../src/contracts/v1/verticalPackContracts';

/**
 * Football: a followed club's fixtures.
 *
 * Free, per the MVP that shipped fixtures without a paywall, so
 * `entitlementKey` is null and the gate answers `free_feature`. The fixture
 * change replans if it impacts the day; the kickoff approaching notifies. No
 * template proposes a commitment: turning a match into one is
 * `lib/football/projectFixtures.ts`'s job, through the existing proposal and
 * dismissal path, and a watcher that wrote one would be the direct canonical
 * write the architecture rule forbids.
 */
export const FOOTBALL_PACK: VerticalPackDefinition = {
  version: VERTICAL_PACK_CONTRACT_VERSION,
  schemaVersion: VERTICAL_PACK_SCHEMA_VERSION,
  packId: 'football',
  // Nothing in the closed capability vocabulary is *required* to read a
  // fixture: the match is public. A calendar grant makes the impact question
  // answerable in more detail, and its absence never blocks the pack.
  requiredCapabilities: [],
  optionalCapabilities: ['calendar_busy'],
  watcherTemplates: [
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'fixture_changed',
      signalKind: 'fixture',
      condition: { kind: 'digest_changed' },
      effect: 'replan_if_impacted',
      requiresConnection: true,
    },
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'match_starting',
      signalKind: 'fixture',
      condition: { kind: 'digest_changed' },
      effect: 'notify',
      requiresConnection: false,
    },
  ],
  allowedEffects: ['replan_if_impacted', 'notify'],
  userStateSections: ['availability', 'plan'],
  entitlementKey: null,
  privacyClass: 'personal',
};

/**
 * Athlete: readiness from WHOOP, HealthKit or Health Connect.
 *
 * Two templates because readiness reaches the account two ways and only one
 * of them is a grant: WHOOP is a connection (`readiness_read`), while
 * HealthKit and Health Connect are on-device adapters writing the same
 * normalized snapshot with no `IntegrationConnection` behind them. Both feed
 * one signal kind, which is the point of the normalization.
 *
 * `update_context` rather than `replan_if_impacted` on the connected
 * template: the issue's own wording is "planner context only after policy
 * permits", so the pack's first move on a readiness change is to absorb it
 * into the shared state, not to ask for a replan.
 *
 * `sensitive`, declared not inferred — health-adjacent data, the safety
 * gateway's rule applied to a pack.
 */
export const ATHLETE_PACK: VerticalPackDefinition = {
  version: VERTICAL_PACK_CONTRACT_VERSION,
  schemaVersion: VERTICAL_PACK_SCHEMA_VERSION,
  packId: 'athlete',
  requiredCapabilities: ['readiness_read'],
  optionalCapabilities: [],
  watcherTemplates: [
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'readiness_changed',
      signalKind: 'readiness',
      condition: { kind: 'digest_changed' },
      effect: 'update_context',
      requiresConnection: true,
    },
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'readiness_impacts_plan',
      signalKind: 'readiness',
      condition: { kind: 'digest_changed' },
      effect: 'replan_if_impacted',
      requiresConnection: false,
    },
  ],
  allowedEffects: ['update_context', 'replan_if_impacted'],
  userStateSections: ['readiness', 'plan'],
  entitlementKey: 'pack_athlete',
  privacyClass: 'sensitive',
};

/**
 * Travel: a flight's status against the day it lands in.
 *
 * `mail_read` is the required capability because that is how an itinerary
 * reaches this product today — the confirmation lands in a mailbox and the
 * extraction pipeline normalizes it — and `calendar_busy` is optional because
 * knowing what the delay collides with sharpens the impact question without
 * ever being required to answer it.
 *
 * A delay replans if it impacts; the itinerary moving notifies. Neither
 * writes a commitment: the travel foundation
 * (`lib/planning/constraints/travel.ts`) is a projection into
 * `PlanningConstraints`, and a `replan_if_impacted` firing appends a
 * `PlanningStateChange` for the replanning lane to consume. Nobody here calls
 * `schedulePlan`.
 */
export const TRAVEL_PACK: VerticalPackDefinition = {
  version: VERTICAL_PACK_CONTRACT_VERSION,
  schemaVersion: VERTICAL_PACK_SCHEMA_VERSION,
  packId: 'travel',
  requiredCapabilities: ['mail_read'],
  optionalCapabilities: ['calendar_busy'],
  watcherTemplates: [
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'flight_status_changed',
      signalKind: 'flight',
      condition: { kind: 'digest_changed' },
      effect: 'replan_if_impacted',
      requiresConnection: true,
    },
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'itinerary_changed',
      signalKind: 'itinerary',
      condition: { kind: 'digest_changed' },
      effect: 'notify',
      requiresConnection: true,
    },
  ],
  allowedEffects: ['replan_if_impacted', 'notify'],
  userStateSections: ['availability', 'plan'],
  entitlementKey: 'pack_travel',
  privacyClass: 'personal',
};

/** Every shipped pack, by id. A pack absent from here does not exist. */
export const PACK_CATALOG: Readonly<Record<string, VerticalPackDefinition>> = Object.freeze({
  [FOOTBALL_PACK.packId]: FOOTBALL_PACK,
  [ATHLETE_PACK.packId]: ATHLETE_PACK,
  [TRAVEL_PACK.packId]: TRAVEL_PACK,
});

export function packById(packId: string): VerticalPackDefinition | null {
  return PACK_CATALOG[packId] ?? null;
}
