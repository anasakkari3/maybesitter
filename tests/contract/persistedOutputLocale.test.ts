/**
 * Persisted, hashed or truncated output must not depend on the host (#121).
 *
 * ── What this guards ─────────────────────────────────────────────
 *
 * Two environment variables on the serving machine can change what this
 * product writes down, and neither is an input the product knows it has:
 *
 *  - `LANG` / `LC_ALL`. A no-argument `localeCompare` resolves against the
 *    host's default locale (measured on Node 24 with full ICU: `LANG=tr_TR`
 *    flips `'i'.localeCompare('I')`, `LC_ALL=sv_SE` flips `'Ä'` past `'Z'`,
 *    and `da` puts `'aab'` after `'z'`, which lowercase hex ids contain). A
 *    checksum, an idempotency key or a "which N records" selection built on it
 *    differs between two machines running identical code.
 *  - `TZ`. `Date.parse` of a datetime with no offset is read as host-local, so
 *    the instant a client's `2026-10-01T15:00:00` becomes depends on where the
 *    backend runs. Cloud Run is UTC; a developer's machine is not.
 *
 * ── Two kinds of test ────────────────────────────────────────────
 *
 * The static half scans a *named* list of modules whose output is persisted,
 * hashed or truncated. It is an allow-list on purpose: presentation code (the
 * `.ics` feed order, the legacy web agenda) may legitimately collate, and a
 * repo-wide scan would either false-positive on it or be watered down until it
 * caught nothing. Add a module here when its output starts being written down.
 *
 * The behavioural half does not set `LANG` — Node reads it once at start-up —
 * it swaps `String.prototype.localeCompare` for a fixed-locale collator, which
 * is exactly what a different host locale does to a no-argument call, and
 * sweeps `TZ`, which Node does re-read. Each probe first proves its own
 * lever moves (the two ids really disagree under the two locales; the zone
 * really moves an offset-less parse), so a probe cannot pass vacuously.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildV03ResearchReport, type BehavioralInterviewRecord, type PilotRecruitmentRecord } from '../../lib/research/v03BehavioralResearch.ts';
import { normalizeExternalTaskReference } from '../../lib/integrations/tasks/externalTaskNormalizer.ts';
import { idempotencyKeyFor } from '../../lib/services/mobile/mobileCaptureService.ts';
import { byListOrder } from '../../lib/services/mobile/aiContextImportService.ts';
import { validateEdit } from '../../lib/services/captureBoundary/applyEdits.ts';
import { resolveDeferUntil } from '../../lib/services/mobile/nextStepDecisionLog.ts';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

/* ── The static guard ─────────────────────────────────────────────── */

/**
 * Modules whose output is persisted, hashed or truncated. Every one of these
 * must order strings by code point and parse instants with an explicit offset.
 */
const PERSISTED_OUTPUT_MODULES = [
  // Hashed: an evidence-integrity checksum written to evaluation-reports/.
  'lib/research/v03BehavioralResearch.ts',
  // Hashed: contentHash / dedupeHash persisted on every external task ref.
  'lib/integrations/tasks/externalTaskNormalizer.ts',
  // Hashed: the confirm idempotency key.
  'lib/services/mobile/mobileCaptureService.ts',
  // Truncated: which existing records the import model is shown.
  'lib/services/mobile/aiContextImportService.ts',
  // Truncated: the Trust history feed, `slice(0, limit)` after a tie-break.
  'lib/watchers/backgroundActivityHistory.ts',
  // Persisted: a client's resolvedTime becomes a stored instant.
  'lib/services/captureBoundary/applyEdits.ts',
  // Persisted: a client's deferUntil becomes a stored instant.
  'lib/services/mobile/nextStepDecisionLog.ts',
  // Already clean by rule; listed so the rule is a fact rather than a comment.
  'lib/planning/shared/compare.ts',
  'lib/runtimeMemory/runtimeMemoryStore.ts',
  'lib/lifeState/fields.ts',
  'lib/feedback/feedbackEventStore.ts',
  'lib/services/nextStepReviewService.ts',
  'lib/services/nextStepBaseline.ts',
  'lib/experiments/nextStepArms.ts',
] as const;

/** `Date.parse(` / `new Date(` handed a string or template literal. */
const LITERAL_INSTANT_PARSE = /(?:Date\.parse|new Date)\(\s*([`'"])((?:(?!\1)[\s\S])*)\1/g;
/** A literal that names a time of day (so it is not a bare date) … */
const HAS_CLOCK = /T\d\d:\d\d/;
/** … and ends with an explicit offset. */
const HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)\s*$/;

test('no persisted-output module collates by the host locale', () => {
  for (const file of PERSISTED_OUTPUT_MODULES) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    const lines = source.split('\n').map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /localeCompare\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
    assert.deepEqual(lines, [], `${file} orders by the host locale at ${lines.map(([n]) => `:${n}`).join(' ')}`);
  }
});

test('no persisted-output module parses an offset-less datetime literal', () => {
  for (const file of PERSISTED_OUTPUT_MODULES) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    for (const match of Array.from(source.matchAll(LITERAL_INSTANT_PARSE))) {
      const literal = match[2]!;
      if (!HAS_CLOCK.test(literal)) continue;
      assert.ok(HAS_OFFSET.test(literal), `${file} parses ${JSON.stringify(literal)} without an offset, so its value depends on TZ`);
    }
  }
});

test('the literal scan can tell an offset-less datetime from one with an offset', () => {
  const probe = "Date.parse(`${day}T00:00:00.000Z`); new Date('2026-08-23T15:00:00'); Date.parse('2099-01-15')";
  const seen = Array.from(probe.matchAll(LITERAL_INSTANT_PARSE), (m) => m[2]);
  assert.deepEqual(seen, ['${day}T00:00:00.000Z', '2026-08-23T15:00:00', '2099-01-15']);
  assert.ok(HAS_OFFSET.test(seen[0]!) && !HAS_OFFSET.test(seen[1]!) && !HAS_CLOCK.test(seen[2]!));
});

/* ── The behavioural probes ───────────────────────────────────────── */

/**
 * Runs `fn` as if the host's default locale were `locale`.
 *
 * Node reads `LANG` once at start-up, so a test cannot set it. What a host
 * locale actually changes is what a no-argument `localeCompare` resolves to,
 * and that is swapped here. `null` makes every no-argument call throw, which
 * proves a path never consults the host at all.
 */
function underHostCollation<T>(locale: string | null, fn: () => T): T {
  const original = String.prototype.localeCompare;
  const collator = locale === null ? null : new Intl.Collator(locale);
  // eslint-disable-next-line no-extend-native
  String.prototype.localeCompare = function patched(this: string, that: string, ...rest: unknown[]): number {
    if (rest.length > 0) return original.call(this, that, ...(rest as [string]));
    if (collator === null) throw new Error(`localeCompare consulted the host locale for ${JSON.stringify(String(this))}`);
    return collator.compare(String(this), that);
  };
  try {
    return fn();
  } finally {
    String.prototype.localeCompare = original;
  }
}

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const;

function inZone<T>(zone: string, run: () => T): T {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    return run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test('the collation lever really moves: Turkish and Danish hosts disagree with en-US', () => {
  assert.equal(underHostCollation('en-US', () => 'int-002'.localeCompare('Int-003')) < 0, true);
  assert.equal(underHostCollation('tr-TR', () => 'int-002'.localeCompare('Int-003')) > 0, true);
  assert.equal(underHostCollation('en-US', () => 'aab'.localeCompare('z')) < 0, true);
  assert.equal(underHostCollation('da-DK', () => 'aab'.localeCompare('z')) > 0, true);
  assert.equal(underHostCollation('sv-SE', () => 'Ändra möte'.localeCompare('Zoo visit')) > 0, true);
  assert.equal(underHostCollation('en-US', () => 'Ändra möte'.localeCompare('Zoo visit')) < 0, true);
  assert.throws(() => underHostCollation(null, () => 'a'.localeCompare('b')));
});

test('the zone lever really moves an offset-less parse', () => {
  const utc = inZone('UTC', () => Date.parse('2026-08-23T15:00:00'));
  const jerusalem = inZone('Asia/Jerusalem', () => Date.parse('2026-08-23T15:00:00'));
  assert.notEqual(utc, jerusalem, 'TZ assignment did not reach Date.parse; the zone probes prove nothing');
});

function interview(interviewId: string): BehavioralInterviewRecord {
  return {
    schemaVersion: 'v1', interviewId, cohort: 'commercial', cohortEligibilityConfirmed: true,
    occurredAt: '2026-09-14T09:00:00.000Z', consentRecorded: true, adultConfirmed: true,
    pastBehaviorExampleObserved: true, recurringWeeklyPain: true, concreteCostObserved: true,
    currentWorkflows: ['calendar'], abandonedToolObserved: true, paidForRelatedTool: true,
    privacyBoundaryObserved: true, switchingPain: 'medium', preferredBaseline: 'current_workflow',
    evidenceRef: `research://v03/${interviewId}`,
  };
}

function recruit(candidateId: string): PilotRecruitmentRecord {
  return {
    schemaVersion: 'v1', candidateId, cohort: 'commercial',
    screenedAt: '2026-09-14T09:00:00.000Z', adultConfirmed: true, qualified: true, behavioralPainQualified: true,
    cohortEligibilityConfirmed: true, researchConsentRecorded: true, pilotContactConsentRecorded: true, pilotStatus: 'accepted',
  };
}

test('the V03 evidence checksum is the same on a Danish host as on an en-US one', () => {
  // The validator keeps ids lowercase, so the Turkish `i`/`I` flip the issue
  // measured cannot reach the checksum any more — but Danish collation reads a
  // leading `aa` as `å` and sorts it after `z`, and both of these are valid ids.
  const rows = [interview('z-002'), interview('aab-003')];
  const recruits = [recruit('z-002'), recruit('aab-003')];
  const build = () => buildV03ResearchReport(rows, recruits).evidenceIntegrity;
  assert.deepEqual(underHostCollation('da-DK', build), underHostCollation('en-US', build));
  assert.deepEqual(underHostCollation(null, build), underHostCollation('en-US', build));
});

test('an external task fingerprint never consults the host locale', () => {
  const payload = {
    provider: 'todoist', providerIdentity: 'u1', connectionId: 'c1', externalId: 'e1', scopeId: 's1',
    title: 'Istanbul trip', notes: null, dueAt: '2026-10-01T09:00:00.000Z', completed: false, updatedAt: '2026-09-25T00:00:00.000Z',
  } as unknown as Parameters<typeof normalizeExternalTaskReference>[0];
  const fingerprint = () => normalizeExternalTaskReference(payload).fingerprint;
  assert.deepEqual(underHostCollation(null, fingerprint), underHostCollation('en-US', fingerprint));
});

test('the confirm idempotency key is the same on a Danish host as on an en-US one', () => {
  // Two lowercase ids of the shape `randomUUID` produces. Danish collation
  // reads the leading `aa` as å and puts it after `z`; en-US does not.
  const edits = [
    { itemId: 'z9f2c1d0-0000-4000-8000-000000000001', title: 'later' },
    { itemId: 'aab7e3c2-0000-4000-8000-000000000002', title: 'sooner' },
  ];
  const key = () => idempotencyKeyFor('proposal-1', 'scope-1', ['x'], undefined, edits);
  assert.equal(underHostCollation('da-DK', key), underHostCollation('en-US', key));
  assert.equal(underHostCollation(null, key), underHostCollation('en-US', key));
});

test('which existing memories the import model is shown does not depend on the host locale', () => {
  const record = (id: string, content: string): RuntimeMemoryRecord => ({
    id, scopeId: 'u', kind: 'fact', content, observedAt: '2026-09-23T09:00:00.000Z', createdAt: '2026-09-23T09:00:00.000Z',
  } as unknown as RuntimeMemoryRecord);
  // Same instants, so the content tie-break decides; the pair that flips under sv-SE.
  const rows = [record('mem_2', 'Zoo visit'), record('mem_1', 'Ändra möte')];
  const order = () => [...rows].sort(byListOrder).map((row) => row.id);
  assert.deepEqual(underHostCollation('sv-SE', order), underHostCollation('en-US', order));
  assert.deepEqual(underHostCollation(null, order), underHostCollation('en-US', order));
});

test('a client resolvedTime with no offset is stored as the same instant in every server zone', () => {
  const now = new Date('2026-09-25T08:00:00.000Z');
  const known = new Set(['item-1']);
  const stored = ZONES.map((zone) => inZone(zone, () => validateEdit({ itemId: 'item-1', resolvedTime: '2026-10-01T15:00:00' }, known, now).resolvedTime));
  assert.deepEqual(stored, ZONES.map(() => '2026-10-01T15:00:00.000Z'), `resolvedTime drifts with TZ: ${stored.join(' ')}`);
  // The past-time rule sees the same instant too.
  for (const zone of ZONES) {
    inZone(zone, () => assert.throws(
      () => validateEdit({ itemId: 'item-1', resolvedTime: '2026-09-25T07:30:00' }, known, now),
      (error: unknown) => (error as { detail?: string }).detail === 'in the past',
    ));
  }
});

test('a client deferUntil with no offset is stored as the same instant in every server zone', () => {
  const now = new Date('2026-09-25T08:00:00.000Z');
  const stored = ZONES.map((zone) => inZone(zone, () => resolveDeferUntil('2026-09-26T10:00:00', now)));
  assert.deepEqual(stored, ZONES.map(() => '2026-09-26T10:00:00.000Z'), `deferUntil drifts with TZ: ${stored.join(' ')}`);
});
