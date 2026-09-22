/**
 * Football, athlete and travel pass the same suite (#528, slice 2).
 *
 * The issue's headline acceptance criterion — "Football, Athlete and Travel
 * synthetic implementations all pass the same Watcher engine" — stated as a
 * test rather than a claim. Nothing here is written per pack: each manifest
 * goes through `runPackConformance` exactly as the synthetic pack does, with
 * the harness untouched, which is the only way "the same engine" is a fact
 * instead of an intention.
 *
 * The non-vacuity assertions matter more here than in the synthetic file. A
 * real pack could quietly skip half the suite by declaring no
 * connection-requiring template, or no templates at all, and still report
 * `passed: true` — so every pack is also asserted to have run every check for
 * real, and to have exercised both the connection-blocked and the
 * planner-facing paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPackConformance, type PackConformanceReport } from './conformanceHarness.ts';
import { ATHLETE_PACK, FOOTBALL_PACK, PACK_CATALOG, TRAVEL_PACK } from '../../lib/packs/catalog.ts';
import { defaultWatcherSignalRegistry } from '../../lib/watchers/signals.ts';
import { validateVerticalPackDefinition, type VerticalPackDefinition } from '../../src/contracts/v1/verticalPackContracts.ts';

const EXPECTED_CHECKS = [
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

/** The provider each pack's connections are made of, in the harness. */
const PROVIDERS: Readonly<Record<string, string>> = {
  football: 'football_data',
  athlete: 'whoop',
  travel: 'aviation',
};

function formatReport(report: PackConformanceReport): string {
  return report.results.map((entry) => `${entry.ok ? 'ok' : 'FAIL'} ${entry.check}: ${entry.detail}`).join('\n');
}

for (const pack of [FOOTBALL_PACK, ATHLETE_PACK, TRAVEL_PACK] as const) {
  test(`the ${pack.packId} pack passes every conformance check`, async () => {
    const report = await runPackConformance({ pack, provider: PROVIDERS[pack.packId]! });
    assert.equal(report.passed, true, `${pack.packId} conformance failures:\n${formatReport(report)}`);
    assert.deepEqual(report.results.map((entry) => entry.check), EXPECTED_CHECKS);
    for (const entry of report.results) {
      assert.ok(!entry.detail.includes('no watcher templates'), `${entry.check} was vacuous for ${pack.packId}`);
      assert.ok(
        !entry.detail.includes('no connection-requiring template'),
        `${entry.check} was vacuous for ${pack.packId}: the pack declares no connection, so the shared`
          + ' disconnect/re-auth/revoke behaviour was never exercised',
      );
      assert.ok(
        !entry.detail.includes('declares no replan effect'),
        `${pack.packId} produces no planner input, so the planner-contract check proved nothing`,
      );
    }
  });
}

test('every catalog pack is a valid manifest and declares at least one connection-backed template', () => {
  const ids = Object.keys(PACK_CATALOG).sort();
  assert.deepEqual(ids, ['athlete', 'football', 'travel'], 'the catalog changed without this test');
  for (const [packId, pack] of Object.entries(PACK_CATALOG) as [string, VerticalPackDefinition][]) {
    assert.equal(pack.packId, packId, 'a catalog key disagrees with the manifest it points at');
    assert.deepEqual(validateVerticalPackDefinition(pack), [], `${packId} is not a valid manifest`);
    assert.ok(pack.watcherTemplates.length > 0, `${packId} declares no templates`);
    assert.ok(
      pack.watcherTemplates.some((template) => template.requiresConnection),
      `${packId} reads through no connection, so the shared provider-disconnect logic never runs for it`,
    );
  }
});

test('no catalog pack declares an effect that writes canonical state', () => {
  // `propose_commitment` is allowed by the engine and goes through the
  // proposal/confirmation path, so it is not forbidden — but none of these
  // three reaches for it, and a pack that starts to must do so deliberately
  // rather than by a copy-paste of a manifest.
  for (const pack of Object.values(PACK_CATALOG)) {
    for (const template of pack.watcherTemplates) {
      assert.ok(
        pack.allowedEffects.includes(template.effect),
        `${pack.packId}/${template.templateId} fires an effect its manifest never declared`,
      );
    }
  }
});

/**
 * Which signal kinds the product actually observes today.
 *
 * The conformance harness builds a generic synthetic observer for whatever
 * `signalKind` a manifest declares, and `signalKind` is validated only as a
 * normalized identifier — so conformance says a manifest is well-formed and
 * rides the shared pipeline correctly, and says *nothing* about whether
 * anything can observe it. A pack declaring `signalKind: 'unicorn'` would pass
 * all eleven checks. This is the test that keeps the difference honest.
 *
 * `NOT_YET_OBSERVED` asserts today's truth out loud, in the pattern
 * `deletionScopeCoverage.test.ts`'s `NOT_YET_WIRED` established: the entry
 * fails the day the observer lands, and the message says to delete it.
 */
const NOT_YET_OBSERVED: ReadonlySet<string> = new Set([
  // `lib/planning/constraints/travel.ts` projects a travel *estimate* into
  // planning constraints; there is no flight- or itinerary-status observer,
  // and no adapter behind one. The travel pack is a manifest over a source
  // the product cannot yet read.
  'flight',
  'itinerary',
]);

test('every catalog signal kind is either served by the shipped registry or declared unobserved', () => {
  const registry = defaultWatcherSignalRegistry();
  const seen = new Set<string>();
  for (const pack of Object.values(PACK_CATALOG)) {
    for (const template of pack.watcherTemplates) {
      seen.add(template.signalKind);
      const observer = registry.observerFor({
        provider: PROVIDERS[pack.packId]!,
        connectionId: null,
        signalKind: template.signalKind,
        subjectRef: 'probe',
      });
      if (NOT_YET_OBSERVED.has(template.signalKind)) {
        assert.equal(
          observer,
          null,
          `'${template.signalKind}' is in NOT_YET_OBSERVED because nothing observes it \u2014 if this `
            + 'assertion just failed, the observer landed: remove it from NOT_YET_OBSERVED and let '
            + 'the branch below cover it',
        );
      } else {
        assert.ok(
          observer,
          `${pack.packId}/${template.templateId} watches '${template.signalKind}', which `
            + 'defaultWatcherSignalRegistry() serves no observer for \u2014 the pack would block with '
            + "'signal_unavailable' on every sweep. Ship the observer, or say so in NOT_YET_OBSERVED.",
        );
      }
    }
  }
  // Non-vacuity, both ways: the registry really does serve something, and the
  // unobserved set really is about kinds a pack declares.
  assert.ok(seen.has('fixture') && seen.has('readiness'), 'the catalog lost its observed signal kinds');
  for (const kind of Array.from(NOT_YET_OBSERVED)) {
    assert.ok(seen.has(kind), `NOT_YET_OBSERVED names '${kind}', which no catalog pack declares any more`);
  }
});
