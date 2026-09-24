import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../infra/cloudrun/ai-cost-alerts.sh', import.meta.url));
const output = execFileSync('bash', [script, 'print'], { encoding: 'utf8' });
const commands = output.replace(/\\(.)/g, '$1');
const policies = Array.from(output.matchAll(/--policy-from-file=- <<EOF\n([\s\S]*?)^EOF$/gm))
  .map((match) => JSON.parse(match[1]));
const condition = (name: string) => {
  const policy = policies.find((entry) => entry.displayName === name);
  assert.ok(policy, `missing policy: ${name}`);
  return policy.conditions[0].conditionThreshold;
};

test('5xx uses a service-wide ratio, not an absolute errors/second threshold', () => {
  const c = condition('Cloud Run 5xx above 5%');
  assert.ok(c.denominatorFilter, 'absolute rate cannot measure a percentage');
  assert.match(c.filter, /response_code_class.*5xx/);
  assert.doesNotMatch(c.denominatorFilter, /response_code_class/);
  assert.deepEqual(c.aggregations, c.denominatorAggregations);
  assert.equal(c.aggregations[0].crossSeriesReducer, 'REDUCE_SUM');
  assert.equal(c.aggregations[0].alignmentPeriod, '600s');
  assert.equal(c.aggregations[0].perSeriesAligner, 'ALIGN_SUM');
  assert.equal(c.thresholdValue, 0.05);
  // Uneven revision traffic must be weighted by requests, not average ratios.
  const alerts = (rows: number[][]) => {
    const bad = rows.reduce((sum, row) => sum + row[0], 0);
    const total = rows.reduce((sum, row) => sum + row[1], 0);
    return total > 0 && bad / total > c.thresholdValue;
  };
  assert.equal(alerts([[600, 600000]]), false); // 1 error/sec but only 0.1%.
  assert.equal(alerts([[6, 12]]), true); // 0.01 error/sec but 50%.
  assert.equal(alerts([[5, 10], [0, 990]]), false);
  assert.equal(alerts([[5, 100]]), false);
  assert.equal(alerts([[0, 0]]), false);
});

test('Vertex counts publisher model invocations over a full day across series', () => {
  const c = condition('Vertex AI requests above 1500/day');
  assert.match(c.filter, /publisher\/online_serving\/model_invocation_count/);
  assert.match(c.filter, /aiplatform.googleapis.com\/PublisherModel/);
  assert.equal(c.aggregations[0].alignmentPeriod, '86400s');
  assert.equal(c.aggregations[0].crossSeriesReducer, 'REDUCE_SUM');
  assert.equal(c.aggregations[0].perSeriesAligner, 'ALIGN_SUM');
  // 24 ten-minute buckets with 70 calls: no bucket exceeds1500, full day does.
  assert.ok(Array(24).fill(70).reduce((a, b) => a + b, 0) > c.thresholdValue);
});

test('global quota metric excludes individual user cap events', () => {
  assert.match(commands, /metrics create ai_global_quota_exceeded/);
  assert.match(commands, /jsonPayload.scope="global_daily"/);
  const c = condition('Model refused for everyone (global quota)');
  assert.match(c.filter, /user\/ai_global_quota_exceeded/);
  assert.equal(c.aggregations[0].crossSeriesReducer, 'REDUCE_SUM');
});

test('apply passes the same valid policy JSON and an intact global filter to gcloud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-alerts-test-'));
  const log = join(dir, 'calls.jsonl');
  try {
    writeFileSync(join(dir, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args.find(a => a.startsWith('--policy-from-file='));
const policy = file ? JSON.parse(fs.readFileSync(file.split('=')[1], 'utf8')) : null;
fs.appendFileSync(process.env.ALERT_TEST_LOG, JSON.stringify({args, policy})+'\\n');
if (args.includes('channels')) console.log('projects/maybesitter-app/notificationChannels/CHANNEL_ID');
`, { mode: 0o755 });
    execFileSync('bash', [script, 'apply', 'synthetic@example.invalid'], {
      env: { ...process.env, PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}`, ALERT_TEST_LOG: log },
      encoding: 'utf8',
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.filter(c => c.policy).map(c => c.policy), policies);
    const metric = calls.find(c => c.args.includes('ai_global_quota_exceeded'));
    assert.ok(metric);
    assert.equal(metric.args.find((a: string) => a.startsWith('--log-filter=')),
      '--log-filter=resource.type="cloud_run_revision" AND jsonPayload.event="ai_quota_exceeded" AND jsonPayload.scope="global_daily"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('instance ceiling sums across revisions before the fifteen-minute retest', () => {
  const c = condition('Cloud Run pinned at max instances');
  assert.equal(c.aggregations[0].crossSeriesReducer, 'REDUCE_SUM');
  assert.equal(c.aggregations[0].alignmentPeriod, '60s');
  assert.equal(c.duration, '900s');
  assert.equal(c.comparison, 'COMPARISON_GTE');
  assert.ok(2 + 1 >= c.thresholdValue); // Neither revision alone is at 3.
});

test('printed commands execute as shell with four independently valid policy inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-alerts-print-test-'));
  const log = join(dir, 'calls.jsonl');
  try {
    writeFileSync(join(dir, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const policy = args.includes('--policy-from-file=-') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync(process.env.ALERT_TEST_LOG, JSON.stringify({args, policy})+'\\n');
`, { mode: 0o755 });
    execFileSync('bash', ['-e'], {
      input: output,
      env: { ...process.env, PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}`, ALERT_TEST_LOG: log },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.filter(c => c.policy).map(c => c.policy), policies);
    assert.equal(calls.filter(c => c.policy).length, 4);
    assert.ok(calls.some(c => c.args[0] === 'billing'));
    assert.equal(calls.filter(c => c.args[0] === 'firestore').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
