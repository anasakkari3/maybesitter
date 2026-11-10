/**
 * Every path that spends on the model asks the feature gate (owner direction,
 * 2026-11-10; review finding P0-1).
 *
 * Three services once called the gated provider straight, with the daily
 * `reserveCall`/`commitUsage` pair, and so spent outside every monthly budget.
 * The rule this holds: outside `lib/llm` (where the two metered providers
 * apply the gate themselves) and `lib/features`, a file that reserves model
 * spend or builds the gated provider must also hold the feature's budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SPENDS = /\b(consentGatedProvider|reserveCall|reserveQuotaPermit)\(/;
const GATED = /\b(checkProviderFeature|featureHooksFor|decideFeature|holdFeatureSpend)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('every file that spends on the model outside the metered providers holds a feature budget', () => {
  const offenders: string[] = [];
  const spenders: string[] = [];
  for (const path of [...sources(join(root, 'lib')), ...sources(join(root, 'src'))]) {
    const file = relative(root, path);
    if (file.startsWith('lib/llm/') || file.startsWith('lib/features/')) continue;
    const source = readFileSync(path, 'utf8');
    if (!SPENDS.test(source)) continue;
    spenders.push(file);
    if (!GATED.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `spends on the model without the feature gate:\n${offenders.join('\n')}`);
  // The scan must actually be looking at something.
  for (const known of ['lib/services/mobile/memorySummary.ts', 'lib/services/mobile/memoryTranslation.ts',
    'lib/services/dailyPlan/explanationService.ts', 'lib/intelligence/m5aGmailScan.ts', 'lib/intelligence/gmailJobs.ts']) {
    assert.ok(spenders.includes(known), `${known} no longer matched: update the scan`);
  }
});
