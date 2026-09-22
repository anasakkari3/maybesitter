/**
 * The conformance suite, proven (#528, slice 1).
 *
 * A reusable harness that cannot fail proves nothing, so this file runs it
 * three ways: against one minimal-but-real synthetic pack (a fake provider, a
 * fake connection, two watcher templates covering both connection modes and
 * two effects) that must pass every check, and against two deliberately
 * broken packs that must each fail the specific check they violate.
 *
 * `synthetic_test_pack` is not a product surface and never becomes one: it
 * exists so the harness's assertions are exercised against the real engine,
 * the real store, the real pause switch and the real deletion path before any
 * actual pack (football, athlete, travel — the follow-up slice) is asked to
 * conform.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPackConformance, type PackConformanceReport } from './conformanceHarness.ts';
import {
  VERTICAL_PACK_CONTRACT_VERSION,
  VERTICAL_PACK_SCHEMA_VERSION,
  type VerticalPackDefinition,
} from '../../src/contracts/v1/verticalPackContracts.ts';
import { WATCHER_TEMPLATE_SCHEMA_VERSION } from '../../src/contracts/v1/verticalPackContracts.ts';
import type { StorageAdapter } from '../../lib/storage/index.ts';
import { userSubDoc } from '../../lib/storage/paths.ts';
import { WATCHER_SIGNAL_SCHEMA_VERSION } from '../../src/contracts/v1/watcherContracts.ts';
import type { WatcherSignalObserver } from '../../lib/watchers/signals.ts';

/** The account id the harness uses, duplicated here so the broken pack's observer can write into it. */
const UID_FOR_WRITE = 'pack_conformance_user_00001';

const SYNTHETIC_PACK: VerticalPackDefinition = {
  version: VERTICAL_PACK_CONTRACT_VERSION,
  schemaVersion: VERTICAL_PACK_SCHEMA_VERSION,
  packId: 'synthetic_test_pack',
  requiredCapabilities: ['calendar_busy'],
  optionalCapabilities: ['readiness_read'],
  watcherTemplates: [
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'slot_changed',
      signalKind: 'synthetic_slot',
      condition: { kind: 'digest_changed' },
      effect: 'replan_if_impacted',
      requiresConnection: true,
    },
    {
      schemaVersion: WATCHER_TEMPLATE_SCHEMA_VERSION,
      templateId: 'suggestion_ready',
      signalKind: 'synthetic_suggestion',
      condition: { kind: 'digest_changed' },
      effect: 'propose_commitment',
      requiresConnection: false,
    },
  ],
  allowedEffects: ['replan_if_impacted', 'propose_commitment'],
  userStateSections: ['availability', 'plan'],
  entitlementKey: 'synthetic_premium',
  privacyClass: 'personal',
};

function formatReport(report: PackConformanceReport): string {
  return report.results.map((entry) => `${entry.ok ? 'ok' : 'FAIL'} ${entry.check}: ${entry.detail}`).join('\n');
}

test('the synthetic pack passes every conformance check', async () => {
  const report = await runPackConformance({ pack: SYNTHETIC_PACK, provider: 'synthetic' });
  assert.equal(
    report.passed,
    true,
    `conformance failures:\n${formatReport(report)}`,
  );
  // Guard against a vacuous pass: the issue's whole list ran, and each ran
  // for real — no check may pass with a "nothing to exercise" detail.
  const expectedChecks = [
    'manifest_valid',
    'capability_availability',
    'provider_disconnected',
    'permission_limited',
    'stale_and_duplicate_signal',
    'revoke',
    'user_pause',
    'entitlement_loss',
    'account_deletion',
    'no_canonical_write_before_confirmation',
    'no_provider_specific_value_reaches_planner',
  ];
  assert.deepEqual(report.results.map((entry) => entry.check), expectedChecks);
  for (const entry of report.results) {
    assert.ok(!entry.detail.includes('no watcher templates'), `${entry.check} was vacuous`);
    assert.ok(!entry.detail.includes('no connection-requiring template'), `${entry.check} was vacuous`);
  }
});

test('a pack whose template exceeds its declared effects fails manifest validation', async () => {
  const broken: VerticalPackDefinition = {
    ...SYNTHETIC_PACK,
    packId: 'synthetic_broken_pack',
    // The ceiling says notify only; the template quietly replans. This is the
    // drift the manifest exists to catch.
    allowedEffects: ['notify'],
  };
  const report = await runPackConformance({ pack: broken, provider: 'synthetic' });
  assert.equal(report.passed, false, `the broken pack passed:\n${formatReport(report)}`);
  const manifest = report.results.find((entry) => entry.check === 'manifest_valid');
  assert.ok(manifest, 'the manifest check did not run');
  assert.equal(manifest.ok, false);
  assert.match(manifest.detail, /effect_not_allowed/);
});

test('a pack whose observer writes canonical state fails the canonical-write check', async () => {
  // The pack's signal source "helpfully" records a commitment while it
  // observes. The engine did nothing wrong; the pack misbehaved inside its
  // own adapter — and the conformance suite is what catches it.
  const writerObserver = (deps: { storage: StorageAdapter; signalKind: string; state: { digest: string } }): WatcherSignalObserver => ({
    supports: () => true,
    async observe(source, context) {
      await deps.storage.set(userSubDoc(UID_FOR_WRITE, 'commitments', 'cmt_sneaky'), { uid: UID_FOR_WRITE });
      return {
        schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
        signalId: `${source.signalKind}:${source.subjectRef}:${deps.state.digest}`,
        provider: source.provider,
        signalKind: source.signalKind,
        subjectRef: source.subjectRef,
        observedAt: context.now,
        stateDigest: deps.state.digest,
        provenanceRef: 'broken-pack/sneaky',
        measures: [],
      };
    },
  });
  const report = await runPackConformance({
    pack: SYNTHETIC_PACK,
    provider: 'synthetic',
    observerOverride: writerObserver,
  });
  assert.equal(report.passed, false, 'a canonical-writing pack passed conformance');
  const check = report.results.find((entry) => entry.check === 'no_canonical_write_before_confirmation');
  assert.ok(check, 'the canonical-write check did not run');
  assert.equal(check.ok, false);
  assert.match(check.detail, /canonical write/);
});

test('a pack with unknown capability or invalid privacy class fails manifest validation', async () => {
  const broken = {
    ...SYNTHETIC_PACK,
    packId: 'synthetic_broken_pack',
    requiredCapabilities: ['unknown_sensor' as unknown as import('../../src/contracts/v1/integrationConnectionContracts.ts').IntegrationCapability],
    privacyClass: 'confidential' as unknown as import('../../src/contracts/v1/safetyContracts.ts').SensitivityClass,
  };
  const report = await runPackConformance({ pack: broken as unknown as VerticalPackDefinition, provider: 'synthetic' });
  assert.equal(report.passed, false, `the broken pack passed:\n${formatReport(report)}`);
  const manifest = report.results.find((entry) => entry.check === 'manifest_valid');
  assert.ok(manifest, 'the manifest check did not run');
  assert.equal(manifest.ok, false);
  assert.match(manifest.detail, /unknown_capability:unknown_sensor/);
  assert.match(manifest.detail, /unknown_privacy_class:confidential/);
});

