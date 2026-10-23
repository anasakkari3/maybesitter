/**
 * M5b-2b-2 Gate B: repo guards (PLAN-M5b-2b-2 Verification "fixture
 * intelligence.readd.json from the real exporter"). The exporter
 * (`tests/mobile/exportMobileApiFixtures.test.ts`) writes real route answers;
 * the mobile suite parses them with the shipped schemas (Gate A). Shapes only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = join(ROOT, 'mobile', 'src', 'api', '__fixtures__');

function objects(value: unknown, out: Array<Record<string, any>> = []): Array<Record<string, any>> {
  if (Array.isArray(value)) for (const item of value) objects(item, out);
  else if (value && typeof value === 'object') {
    out.push(value as Record<string, any>);
    for (const item of Object.values(value)) objects(item, out);
  }
  return out;
}

test('repo guards: intelligence.readd.json is a real inbox answer whose re-add rows are pending behaviour outcomes with readd { after, title }, no outcome field, and no \'readded\' signal', () => {
  const file = join(FIXTURES, 'intelligence.readd.json');
  assert.ok(existsSync(file), 'the exporter wrote no intelligence.readd.json');
  const body = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(body.success, true);
  const rows = (body.observations ?? []).filter((row: any) => typeof row.sourceRef === 'string' && row.sourceRef.startsWith('readd:'));
  assert.ok(rows.length > 0, 'no re-add row in the fixture');
  assert.ok(rows.some((row: any) => row.review === 'pending'), 'no pending re-add row in the fixture');
  for (const row of rows) {
    assert.equal(row.source, 'behavior');
    assert.equal(row.kind, 'outcome');
    assert.equal(row.confidence, 0.6);
    assert.ok(['dropped', 'completed'].includes(row.readd?.after), JSON.stringify(row));
    assert.equal(typeof row.readd.title, 'string');
    assert.equal('outcome' in row, false, `a re-add row carries an outcome field: ${JSON.stringify(row)}`);
  }
  for (const row of objects(body)) assert.notEqual(row.signal, 'readded', JSON.stringify(row));
  const exporter = readFileSync(join(ROOT, 'tests', 'mobile', 'exportMobileApiFixtures.test.ts'), 'utf8');
  assert.ok(exporter.includes("'intelligence.readd'"), 'the fixture is not written by the real exporter');
});
