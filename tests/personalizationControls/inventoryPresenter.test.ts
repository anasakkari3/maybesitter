/**
 * The personalization inventory presenter (Sprint 10, issue #42).
 *
 * One view of everything the system holds about a person: derived preference
 * readings with plain-language provenance, user corrections, runtime memory
 * records with status, feedback counts including revocations, and the #107
 * adaptive classification with its inputs — previously invisible, surfaced
 * here.
 *
 * The two proofs with teeth:
 *   - **Immediacy**: derive with consent enabled, flip consent, and the very
 *     next read is inert — and the deriver is not even invoked, so there is no
 *     cached profile a flip could race.
 *   - **Fail-closed**: a deriver emitting a contract-invalid profile yields no
 *     readings at all, never a partially trusted one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createInMemoryPersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { applyCorrection } from '../../lib/personalizationControls/correction.ts';
import {
  buildPersonalizationInventory,
  derivePersonalizationProfile,
} from '../../lib/personalizationControls/inventory.ts';
import type { PersonalizationControlsPort } from '../../lib/personalizationControls/controlsPort.ts';
import {
  OPERATIVE_CONFIDENCE_FLOOR,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  operativeReadings,
} from '../../src/contracts/v1/personalizationContracts.ts';
import { createFixtureDeriver, createStubbornDeriver } from './helpers/fixtureDeriver.ts';
import type { FixtureDeriverHandle } from './helpers/fixtureDeriver.ts';

const SCOPE = 'scope-inventory';
const NOW = '2026-08-20T12:00:00.000Z';
const EARLIER = '2026-08-19T12:00:00.000Z';

const ADAPTIVE_SIGNALS = {
  ignoredCommitmentsCount: 4,
  completionRate: 0.3,
  delayFrequency: 0.7,
  clarificationFrequency: 0,
};

function makePort(overrides: Partial<PersonalizationControlsPort> = {}): {
  port: PersonalizationControlsPort;
  handle: FixtureDeriverHandle;
} {
  const handle = createFixtureDeriver({
    pressure_tone: {
      status: 'operative',
      dimension: 'pressure_tone',
      reason: null,
      level: 'soft',
      confidence: 0.9,
      sampleEventCount: 6,
      evidence: [{ rungIndex: 0, outcome: 'accept', count: 6 }],
    },
    reminder_density: {
      status: 'suggestion',
      dimension: 'reminder_density',
      reason: null,
      level: 'lean',
      confidence: 0.5,
      sampleEventCount: 3,
      evidence: [{ rungIndex: 1, outcome: 'ignore', count: 3 }],
    },
  });
  const port: PersonalizationControlsPort = {
    feedback: createInMemoryFeedbackEventStore(),
    memory: createInMemoryRuntimeMemoryStore(),
    consent: createInMemoryPersonalizationConsentStore(),
    deriver: handle.deriver,
    readAdaptiveSignals: () => ({ ...ADAPTIVE_SIGNALS }),
    ...overrides,
  };
  return { port, handle };
}

test('with consent enabled the inventory carries all three reading variants with provenance', () => {
  const { port } = makePort();
  port.consent.write(SCOPE, 'enabled', EARLIER);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);

  assert.equal(view.scopeId, SCOPE);
  assert.equal(view.consent.state, 'enabled');
  assert.equal(view.preferences.kind, 'derived');
  if (view.preferences.kind !== 'derived') return;

  // Total over the vocabulary: one row per dimension, in contract order.
  assert.deepEqual(view.preferences.rows.map((row) => row.dimension), [...PREFERENCE_DIMENSIONS]);

  const byDimension = Object.fromEntries(view.preferences.rows.map((row) => [row.dimension, row]));

  const operative = byDimension.pressure_tone;
  assert.equal(operative.reading?.status, 'operative');
  assert.equal(operative.effective.source, 'derived_operative');
  assert.equal(operative.effective.level, 'soft');
  // Provenance names the evidence and the window in plain language.
  assert.match(operative.reading?.provenance ?? '', /6/);
  assert.match(operative.reading?.provenance ?? '', /accepted/i);
  assert.match(operative.reading?.provenance ?? '', /14 days/);
  // Confidence explained with the behaviour floor, not as a bare number.
  assert.match(operative.reading?.confidenceExplanation ?? '', /90%/);
  assert.match(
    operative.reading?.confidenceExplanation ?? '',
    new RegExp(String(Math.round(OPERATIVE_CONFIDENCE_FLOOR * 100))),
  );

  const suggestion = byDimension.reminder_density;
  assert.equal(suggestion.reading?.status, 'suggestion');
  // A suggestion never changes behaviour: effective stays the product default.
  assert.equal(suggestion.effective.source, 'product_default');
  assert.equal(suggestion.effective.level, 'standard');
  assert.match(suggestion.reading?.whatWouldChangeIt ?? '', /suggestion/i);

  const inconclusive = byDimension.pressure_ceiling;
  assert.equal(inconclusive.reading?.status, 'inconclusive');
  assert.equal(inconclusive.effective.source, 'product_default');
  assert.match(inconclusive.reading?.provenance ?? '', /not (yet )?(seen|enough|learned)/i);

  // Every reading says what it would take to change it.
  for (const row of view.preferences.rows) {
    assert.ok((row.reading?.whatWouldChangeIt ?? '').length > 0, `${row.dimension} explains change`);
  }

  // The basis is shown: one rung per ladder window, digests included.
  assert.deepEqual(
    view.preferences.basis.map((rung) => rung.windowDays),
    [...PERSONALIZATION_WINDOW_LADDER_DAYS],
  );
});

test('a user correction outranks an operative derivation and is labelled as the user’s own', () => {
  const { port } = makePort();
  port.consent.write(SCOPE, 'enabled', EARLIER);
  applyCorrection(port.memory, SCOPE, 'pressure_tone', 'firm', EARLIER);

  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'derived');
  if (view.preferences.kind !== 'derived') return;
  const row = view.preferences.rows.find((entry) => entry.dimension === 'pressure_tone');
  assert.equal(row?.effective.source, 'user_correction');
  assert.equal(row?.effective.level, 'firm');
  assert.equal(row?.correction?.level, 'firm');
  // The derivation is still shown — the correction overrides it, not erases it.
  assert.equal(row?.reading?.status, 'operative');
  assert.equal(row?.reading?.level, 'soft');
});

test('immediacy: after a consent flip the very next read is inert and the deriver is never asked', () => {
  const { port, handle } = makePort();
  port.consent.write(SCOPE, 'enabled', EARLIER);

  const enabled = derivePersonalizationProfile(port, SCOPE, NOW);
  assert.equal(enabled.kind, 'derived');
  assert.equal(handle.callCount(), 1);
  if (enabled.kind === 'derived') {
    assert.equal(operativeReadings(enabled.profile).length, 1);
  }

  port.consent.write(SCOPE, 'disabled', NOW);

  const flipped = derivePersonalizationProfile(port, SCOPE, NOW);
  assert.equal(flipped.kind, 'disabled');
  if (flipped.kind === 'disabled') {
    // Inert by shape: nothing to read a preference off.
    assert.equal(flipped.profile.readings, null);
    assert.equal(flipped.profile.basis, null);
    assert.deepEqual(operativeReadings(flipped.profile), []);
  }
  // The deriver was not invoked again: there is no cached profile because
  // there is no profile — the flip cannot race a store that does not exist.
  assert.equal(handle.callCount(), 1);

  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.consent.state, 'disabled');
  assert.equal(view.preferences.kind, 'disabled');
  assert.equal(handle.callCount(), 1);
});

test('with consent disabled, corrections still govern the effective level — controls outlive the model', () => {
  const { port } = makePort();
  applyCorrection(port.memory, SCOPE, 'reminder_density', 'rich', EARLIER);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'disabled');
  const row = view.preferences.rows.find((entry) => entry.dimension === 'reminder_density');
  assert.equal(row?.effective.source, 'user_correction');
  assert.equal(row?.effective.level, 'rich');
  assert.equal(row?.reading, null);
  const untouched = view.preferences.rows.find((entry) => entry.dimension === 'pressure_tone');
  assert.equal(untouched?.effective.source, 'product_default');
});

test('a deriver that emits a contract-invalid profile is failed closed, with defect codes named', () => {
  const { port } = makePort();
  port.consent.write(SCOPE, 'enabled', EARLIER);
  const stubborn = createStubbornDeriver({
    version: 'v1' as never,
    schemaVersion: 'personalization-v1',
    scopeId: SCOPE,
    consent: 'enabled',
    derivedAt: NOW,
    basis: null as never,
    readings: null as never,
  });
  const view = buildPersonalizationInventory({ ...port, deriver: stubborn.deriver }, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'profile_invalid');
  if (view.preferences.kind !== 'profile_invalid') return;
  assert.ok(view.preferences.defectCodes.includes('ENABLED_PROFILE_NOT_DERIVED'));
  // No reading leaks out of an invalid profile.
  for (const row of view.preferences.rows) assert.equal(row.reading, null);
});

test('without a wired deriver the readings are honestly unavailable, never silently empty', () => {
  const { port } = makePort();
  port.consent.write(SCOPE, 'enabled', EARLIER);
  const view = buildPersonalizationInventory({ ...port, deriver: null }, SCOPE, NOW);
  assert.equal(view.preferences.kind, 'deriver_unavailable');
  assert.match(view.preferences.explanation, /not .*(wired|connected|available)/i);
});

test('memory records appear with status, source, and revocability; feedback counts include revoked', () => {
  const { port } = makePort();
  const kept = port.memory.put({
    scopeId: SCOPE,
    kind: 'fact',
    content: 'Prefers evening reminders after work',
    language: 'en',
    source: 'user_stated',
    confidence: 1,
    observedAt: EARLIER,
  }, EARLIER);
  const revoked = port.memory.put({
    scopeId: SCOPE,
    kind: 'hypothesis',
    content: 'May be juggling shift work',
    language: 'en',
    source: 'model_inferred',
    confidence: 0.4,
    observedAt: EARLIER,
  }, EARLIER);
  port.memory.revoke(revoked.id, NOW);

  port.feedback.append({
    scopeId: SCOPE, subjectId: 'c-1', outcome: 'accept', actor: 'user', source: 'mobile_action', occurredAt: EARLIER,
  }, EARLIER);
  const toRevoke = port.feedback.append({
    scopeId: SCOPE, subjectId: 'c-2', outcome: 'ignore', actor: 'user', source: 'mobile_action', occurredAt: EARLIER,
  }, EARLIER);
  port.feedback.revoke(toRevoke.id, NOW);

  const view = buildPersonalizationInventory(port, SCOPE, NOW);

  const rows = view.memory.records;
  assert.equal(rows.length, 2);
  const keptRow = rows.find((row) => row.id === kept.id);
  assert.equal(keptRow?.status, 'active');
  assert.equal(keptRow?.canRevoke, true);
  const revokedRow = rows.find((row) => row.id === revoked.id);
  assert.equal(revokedRow?.status, 'revoked');
  assert.equal(revokedRow?.canRevoke, false);

  assert.equal(view.feedback.totalEvents, 2);
  assert.equal(view.feedback.revokedEvents, 1);
  const outcomes = Object.fromEntries(view.feedback.outcomes.map((entry) => [entry.outcome, entry.count]));
  assert.equal(outcomes.accept, 1);
  assert.equal(outcomes.ignore, 1);
});

test('the #107 classification is surfaced with its inputs in plain language', () => {
  const { port } = makePort();
  const view = buildPersonalizationInventory(port, SCOPE, NOW);

  // The scripted signals cross every avoidant threshold.
  assert.equal(view.adaptive.classification, 'avoidant');
  assert.ok(view.adaptive.classificationLabel.length > 0);
  assert.match(view.adaptive.explanation, /pressure/i);

  const inputs = Object.fromEntries(view.adaptive.inputs.map((entry) => [entry.name, entry]));
  assert.equal(inputs.ignoredCommitments.value, 4);
  assert.equal(inputs.completionRate.value, 0.3);
  assert.match(inputs.completionRate.valueLabel, /30%/);
  assert.equal(inputs.delayFrequency.value, 0.7);
  for (const entry of view.adaptive.inputs) {
    assert.ok(entry.explanation.length > 0, `${entry.name} explained`);
  }

  // What it changes is stated, not implied.
  assert.equal(view.adaptive.effect.pressureLevel, 'high');
  assert.equal(view.adaptive.effect.suggestionStyle, 'direct');
  assert.match(view.adaptive.visibilityNote, /classification|label/i);
});

test('the adaptive classification is shown regardless of personalization consent', () => {
  const { port } = makePort();
  port.consent.write(SCOPE, 'disabled', EARLIER);
  const view = buildPersonalizationInventory(port, SCOPE, NOW);
  assert.equal(view.adaptive.classification, 'avoidant');
});

test('the presenter reads no clock: identical inputs at an explicit now produce identical views', () => {
  const first = makePort();
  first.port.consent.write(SCOPE, 'enabled', EARLIER);
  const second = makePort();
  second.port.consent.write(SCOPE, 'enabled', EARLIER);
  assert.deepEqual(
    buildPersonalizationInventory(first.port, SCOPE, NOW),
    buildPersonalizationInventory(second.port, SCOPE, NOW),
  );
});
