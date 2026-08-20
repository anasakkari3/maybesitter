/**
 * A deterministic stand-in for #41's personalization deriver.
 *
 * #42 codes against the `PersonalizationDeriver` seam; the real deriver is
 * being written in a sibling track and does not exist at this branch's base.
 * This fixture implements the seam's *contractual* behaviour — disabled
 * consent yields the inert profile, an enabled derivation carries a basis
 * built from exactly the rung aggregates it was handed — and lets a test
 * script the readings per dimension so presenter behaviour can be asserted
 * against every variant of `PreferenceReading`.
 *
 * It also counts its invocations. The immediacy proof needs to show not just
 * that a disabled read *renders* inert, but that the presenter never asks the
 * deriver at all once consent is off — a presenter that called the deriver and
 * discarded the result would still pass a shape-only assertion.
 */

import {
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_SCHEMA_VERSION,
  PREFERENCE_DIMENSIONS,
  inertPersonalizationProfile,
  type PersonalizationBasisRung,
  type PersonalizationDerivationInput,
  type PersonalizationDeriver,
  type PersonalizationProfile,
  type PreferenceDimension,
  type PreferenceReading,
  type PreferenceReadings,
} from '../../../src/contracts/v1/personalizationContracts.ts';

export interface FixtureDeriverHandle {
  readonly deriver: PersonalizationDeriver;
  /** How many times the deriver has been invoked, for the immediacy proof. */
  callCount(): number;
  /** The inputs it received, in order. */
  inputs(): readonly PersonalizationDerivationInput[];
}

function defaultReading(dimension: PreferenceDimension): PreferenceReading {
  return {
    status: 'inconclusive',
    dimension,
    reason: 'insufficient_sample',
    level: null,
    confidence: null,
    sampleEventCount: 0,
    evidence: [],
  };
}

/**
 * Scripted readings are given per dimension; any dimension left unscripted
 * derives to a well-formed `inconclusive` reading, so every profile this
 * fixture produces is total over the vocabulary and passes
 * `checkPersonalizationProfile` as long as the script itself is valid.
 */
export function createFixtureDeriver(
  script: Partial<Record<PreferenceDimension, PreferenceReading>> = {},
): FixtureDeriverHandle {
  const received: PersonalizationDerivationInput[] = [];

  const deriver: PersonalizationDeriver = (input) => {
    received.push(input);
    if (input.consent.state !== 'enabled') {
      return inertPersonalizationProfile(input.scopeId, input.now);
    }

    const rungs: PersonalizationBasisRung[] = input.rungAggregates.map((aggregate) => ({
      windowDays: aggregate.windowDays,
      windowStart: aggregate.windowStart,
      inputDigest: aggregate.inputDigest,
      revokedCount: aggregate.revokedCount,
    }));

    const readings = Object.fromEntries(
      PREFERENCE_DIMENSIONS.map((dimension) => [dimension, script[dimension] ?? defaultReading(dimension)]),
    ) as PreferenceReadings;

    const profile: PersonalizationProfile = {
      version: PERSONALIZATION_CONTRACT_VERSION,
      schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
      scopeId: input.scopeId,
      consent: 'enabled',
      derivedAt: input.now,
      basis: { scopeId: input.scopeId, rungs },
      readings,
    };
    return profile;
  };

  return {
    deriver,
    callCount: () => received.length,
    inputs: () => received,
  };
}

/** A deriver that returns whatever it is told to, for fail-closed tests. */
export function createStubbornDeriver(profile: PersonalizationProfile): FixtureDeriverHandle {
  const received: PersonalizationDerivationInput[] = [];
  return {
    deriver: (input) => {
      received.push(input);
      return profile;
    },
    callCount: () => received.length,
    inputs: () => received,
  };
}
