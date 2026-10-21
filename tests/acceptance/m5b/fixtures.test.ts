/**
 * M5b-1 Gate B — fixtures and the old app (PLAN-M5b-1 Wire "All additions are
 * optional fields on non-strict existing schemas. No new enum values in
 * existing responses"; Risks "Repo guards": the two new routes go into the
 * fixtures export).
 *
 * The exporter (`tests/mobile/exportMobileApiFixtures.test.ts`) writes real
 * route responses to `mobile/src/api/__fixtures__/`. The shipped app's
 * schemas are non-strict `z.object`s, so an added optional field parses; what
 * would break an old app is a new value in an existing enum. Root tests cannot
 * import the mobile toolchain (zod lives there), so the old enums are pinned
 * here as dd73a9fb's schemas state them, and every fixture is checked against
 * them. On-mode route answers are checked against them in-process too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE, begin, call, checkIn, end, healthSnapshot, plusMinutes, storeReadingContext, show } from './support.ts';

test.afterEach(() => end());

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mobile', 'src', 'api', '__fixtures__');

/** dd73a9fb, mobile/src/api/schemas/readiness.ts and plan.ts. */
const OLD = {
  selectedSource: ['current_subjective', 'recent_readiness', 'historical_inference', 'none'],
  freshness: ['fresh', 'stale', 'missing'],
  readinessBand: ['unknown', 'low', 'steady', 'high'],
  planStatus: ['proposed', 'accepted', 'edited', 'dismissed'],
};

function fixtures(): Array<{ name: string; body: any }> {
  assert.ok(existsSync(FIXTURES), 'no fixtures directory');
  return readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).map((name) => ({ name, body: JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) }));
}

/** Every object in a JSON value, depth first. */
function objects(value: unknown, out: Array<Record<string, any>> = []): Array<Record<string, any>> {
  if (Array.isArray(value)) { value.forEach((item) => objects(item, out)); return out; }
  if (value && typeof value === 'object') {
    out.push(value as Record<string, any>);
    Object.values(value).forEach((child) => objects(child, out));
  }
  return out;
}

function has(predicate: (node: Record<string, any>) => boolean): Array<{ name: string; node: Record<string, any> }> {
  const found: Array<{ name: string; node: Record<string, any> }> = [];
  for (const { name, body } of fixtures()) for (const node of objects(body)) if (predicate(node)) found.push({ name, node });
  return found;
}

test('Wire / Repo guards: the exporter writes the M5b fixtures from the real handlers — probe, summary, plan with readinessApplied, readiness with planEffect, next step with energy', () => {
  assert.ok(has((node) => node.success === true && typeof node.memoryLearning === 'boolean').length > 0, 'no capabilities/m5b fixture');
  const ready = has((node) => node.status === 'ready' && Array.isArray(node.sentences) && typeof node.coveredCount === 'number');
  assert.ok(ready.length > 0, 'no ready memory summary fixture');
  for (const { node } of ready) for (const sentence of node.sentences) assert.ok(Array.isArray(sentence.memoryIds) && typeof sentence.text === 'string', show(sentence));
  assert.ok(has((node) => 'readinessApplied' in node && 'basisChanged' in node && typeof node.generation === 'number').length > 0, 'no plan fixture carrying readinessApplied and basisChanged');
  assert.ok(has((node) => node.planEffect && typeof node.planEffect === 'object' && 'selectedSource' in node).length > 0, 'no readiness fixture carrying planEffect');
  assert.ok(has((node) => node.energy && typeof node.energy === 'object' && node.recommendation).length > 0, 'no next-step fixture carrying energy');
});

test('Wire parity (passes on base): no fixture carries a new value in an existing enum (the old app parses every one)', () => {
  const problems: string[] = [];
  for (const { name, node } of has((candidate) => 'selectedSource' in candidate && 'freshness' in candidate)) {
    if (!OLD.selectedSource.includes(node.selectedSource)) problems.push(`${name}: selectedSource ${node.selectedSource}`);
    if (!OLD.freshness.includes(node.freshness)) problems.push(`${name}: freshness ${node.freshness}`);
  }
  for (const { name, node } of has((candidate) => 'readinessApplied' in candidate && typeof candidate.generation === 'number')) {
    if (!OLD.planStatus.includes(node.status)) problems.push(`${name}: plan status ${node.status}`);
  }
  for (const { name, node } of has((candidate) => 'band' in candidate && 'derived' in candidate)) {
    if (!OLD.readinessBand.includes(node.band)) problems.push(`${name}: readiness band ${node.band}`);
  }
  assert.deepEqual(problems, []);
});

test('Wire: the new objects have exactly their binding shape in the fixtures (readinessApplied, planEffect, energy)', () => {
  const readinessApplied = has((node) => node.readinessApplied && typeof node.readinessApplied === 'object').map(({ node }) => node.readinessApplied);
  assert.ok(readinessApplied.length > 0, 'no non-null readinessApplied in any fixture');
  for (const value of readinessApplied) assert.deepEqual(Object.keys(value).sort(), ['band', 'bufferMinutesAdded', 'energy', 'observedAt', 'source']);
  for (const { node } of has((candidate) => candidate.planEffect && typeof candidate.planEffect === 'object')) {
    assert.deepEqual(Object.keys(node.planEffect).sort(), ['band', 'bufferMinutes', 'energy', 'source', 'staleReading']);
  }
  for (const { node } of has((candidate) => candidate.energy && typeof candidate.energy === 'object' && candidate.recommendation)) {
    assert.deepEqual(Object.keys(node.energy).sort(), ['band', 'changedPick', 'level', 'source']);
  }
});

test('R4.1 / Wire: on-mode readiness GET never emits historical_inference or stale, for any stored reading', async () => {
  const readings: Array<[string, (uid: string) => Promise<void>]> = [
    ['historical-only', async (uid) => storeReadingContext(uid, { historicalInference: healthSnapshot(uid, 'low', '2026-10-03T07:00:00.000Z') })],
    ['stale check-in + historical', async (uid) => storeReadingContext(uid, {
      currentSubjective: { energy: 2, observedAt: plusMinutes(REFERENCE, -20 * 60) },
      historicalInference: healthSnapshot(uid, 'high', '2026-10-01T07:00:00.000Z'),
    })],
    ['fresh check-in', async (uid) => { await checkIn(uid, 4, plusMinutes(REFERENCE, -5)); }],
  ];
  for (const [label, write] of readings) {
    const uid = await begin();
    await write(uid);
    const read = await call(uid, 'readiness', 'GET');
    assert.equal(read.status, 200, show(read.body));
    assert.ok(read.body.planEffect, `${label}: not an on-mode answer (no planEffect)`);
    assert.ok(['current_subjective', 'recent_readiness', 'none'].includes(read.body.selectedSource), `${label}: ${read.body.selectedSource}`);
    assert.ok(['fresh', 'missing'].includes(read.body.freshness), `${label}: ${read.body.freshness}`);
    end();
  }
});
