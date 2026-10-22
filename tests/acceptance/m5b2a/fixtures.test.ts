/**
 * M5b-2a Gate B: fixtures (PLAN-M5b-2a Wire "Fixtures: the real exporter
 * writes plan.memoryBasis.json, plan.memoryBasisChanged.json and
 * intelligence.outcomes.json"). The exporter
 * (`tests/mobile/exportMobileApiFixtures.test.ts`) writes real route answers;
 * the mobile suite parses them with the shipped schemas. Shapes only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mobile', 'src', 'api', '__fixtures__');

function fixture(name: string): any {
  const file = join(FIXTURES, name);
  assert.ok(existsSync(file), `the exporter wrote no ${name}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Every object in a JSON value, depth first. */
function objects(value: unknown, out: Array<Record<string, any>> = []): Array<Record<string, any>> {
  if (Array.isArray(value)) for (const item of value) objects(item, out);
  else if (value && typeof value === 'object') {
    out.push(value as Record<string, any>);
    for (const item of Object.values(value)) objects(item, out);
  }
  return out;
}

test('fixtures: plan.memoryBasis.json is a real plan answer whose basis names a record and a window, and no content', () => {
  const body = fixture('plan.memoryBasis.json');
  const plan = body.plan ?? body;
  assert.equal(typeof plan.memoryBasis?.memoryId, 'string');
  assert.match(plan.memoryBasis.window.start, /^\d{2}:\d{2}$/);
  assert.match(plan.memoryBasis.window.end, /^\d{2}:\d{2}$/);
  assert.equal(plan.memoryBasisChanged, false);
  assert.equal('content' in plan.memoryBasis, false, 'memory content in the plan DTO');
});

test('fixtures: plan.memoryBasisChanged.json flags the change and names no basis', () => {
  const body = fixture('plan.memoryBasisChanged.json');
  const plan = body.plan ?? body;
  assert.equal(plan.memoryBasisChanged, true);
  assert.equal(plan.memoryBasis ?? null, null);
});

test('fixtures: intelligence.outcomes.json carries behaviour outcomes with signal and title', () => {
  const body = fixture('intelligence.outcomes.json');
  const outcomes = objects(body.observations ?? []).filter((row) => row.source === 'behavior' && row.kind === 'outcome');
  assert.ok(outcomes.length > 0, 'no behaviour outcome in the fixture');
  for (const row of outcomes) {
    assert.ok(['completed', 'postponed', 'dropped'].includes(row.outcome?.signal), JSON.stringify(row));
    assert.equal(typeof row.outcome.title, 'string');
  }
});
