import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const secret = 'test-only-restore-round-trip-secret';
const ids = Array.from({ length: 25 }, (_, index) => `round-${String(index + 100).padStart(3, '0')}`).join(',');

function runInline(source: string, env: Record<string, string>): string {
  const result = spawnSync(process.execPath, ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', '--input-type=module', '-'], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    input: source,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function runScript(script: string, args: string[], env: Record<string, string>): string {
  const result = spawnSync(process.execPath, ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function pilotEnv(dataDir: string): Record<string, string> {
  return {
    MAYBESITTER_PILOT_MODE: 'true',
    MAYBESITTER_DATA_DIR: dataDir,
    MAYBESITTER_PILOT_TRUST_FILE: path.join(dataDir, 'pilot-trust.json'),
    MAYBESITTER_PILOT_TOKEN_SECRET: secret,
    MAYBESITTER_CLOSED_PILOT_IDS: ids,
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'false',
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: 'true',
    MAYBESITTER_PILOT_INCIDENT_OWNER_ID: 'round_owner',
  };
}

test('backup and restore survive process restart with A/B isolation and recommendation action replay', () => {
  const sourceDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-round-source-'));
  const backupRoot = mkdtempSync(path.join(tmpdir(), 'maybesitter-round-backups-'));
  const restoredDir = path.join(mkdtempSync(path.join(tmpdir(), 'maybesitter-round-restore-parent-')), 'restored-data');

  const created = runInline(`
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { generatePilotToken } from './lib/pilot/pilotTokenService.ts';

    const tokenA = generatePilotToken('round-100');
    const tokenB = generatePilotToken('round-101');
    function req(path, token, options = {}) {
      const headers = new Headers({ authorization: \`Bearer \${token}\` });
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      return new Request(\`http://local\${path}\`, {
        method: options.method || (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    }
    async function body(response) { return await response.json(); }
    const { POST: updateTrust } = await import('./src/app/api/mobile/pilot/trust/route.ts');
    const { POST: capturePost } = await import('./src/app/api/mobile/capture/route.ts');
    const { POST: confirmPost } = await import('./src/app/api/mobile/capture/confirm/route.ts');
    const { GET: nextStepGet } = await import('./src/app/api/mobile/recommendations/next-step/route.ts');
    const { POST: nextStepActionPost } = await import('./src/app/api/mobile/recommendations/next-step/actions/route.ts');

    for (const token of [tokenA, tokenB]) {
      let response = await updateTrust(req('/api/mobile/pilot/trust', token, { body: { action: { type: 'grant_recommendation_consent' } } }));
      assert.equal(response.status, 200);
      response = await updateTrust(req('/api/mobile/pilot/trust', token, { body: { action: { type: 'set_analytics_consent', granted: true } } }));
      assert.equal(response.status, 200);
    }

    async function createCommitment(token, text, key) {
      let response = await capturePost(req('/api/mobile/capture', token, { body: {
        text,
        referenceTime: '2026-08-09T08:00:00.000Z',
        timezone: 'UTC',
      } }));
      assert.equal(response.status, 200);
      const proposal = await body(response);
      response = await confirmPost(req('/api/mobile/capture/confirm', token, { body: {
        proposalId: proposal.proposalId,
        itemIds: [proposal.items[0].itemId],
        idempotencyKey: key,
      } }));
      assert.equal(response.status, 200);
      return (await body(response)).persisted[0].commitmentId;
    }

    const aCommitmentId = await createCommitment(tokenA, 'Remind me to call Alice tomorrow at 2pm', 'round-confirm-a');
    const bCommitmentId = await createCommitment(tokenB, 'Remind me to email Blake tomorrow at 4pm', 'round-confirm-b');
    let response = await nextStepGet(req('/api/mobile/recommendations/next-step?timezone=UTC', tokenA));
    assert.equal(response.status, 200);
    const recommendationA = (await body(response)).recommendation;
    response = await nextStepActionPost(req('/api/mobile/recommendations/next-step/actions', tokenA, { body: {
      proposal: recommendationA,
      decision: 'accept',
      idempotencyKey: 'round-action-a',
    } }));
    assert.equal(response.status, 200);
    writeFileSync(join(process.env.MAYBESITTER_DATA_DIR, 'round-trip-state.json'), JSON.stringify({
      tokenA,
      tokenB,
      aCommitmentId,
      bCommitmentId,
      recommendationA,
    }, null, 2));
    console.log(JSON.stringify({ aCommitmentId, bCommitmentId }));
  `, pilotEnv(sourceDir));
  assert.match(created, /aCommitmentId/);

  const backupOut = runScript('scripts/backup-pilot-data.ts', ['--backup-root', backupRoot, '--label', 'round-trip'], pilotEnv(sourceDir));
  const backupPath = backupOut.match(/Backup created successfully at: (.+)/)?.[1]?.trim();
  assert.ok(backupPath);
  assert.equal(existsSync(path.join(backupPath, 'data', 'participants', 'round-100-state.json')), true);
  assert.equal(existsSync(path.join(backupPath, 'data', 'participants', 'round-101-state.json')), true);

  const restoreOut = runScript('scripts/restore-pilot-data.ts', ['--backup', backupPath], pilotEnv(restoredDir));
  assert.match(restoreOut, /Pilot data restored successfully/);

  const restoredState = JSON.parse(readFileSync(path.join(restoredDir, 'round-trip-state.json'), 'utf8')) as {
    tokenA: string;
    tokenB: string;
    aCommitmentId: string;
    bCommitmentId: string;
    recommendationA: unknown;
  };

  const verified = runInline(`
    import assert from 'node:assert/strict';
    const state = ${JSON.stringify(restoredState)};
    function req(path, token, options = {}) {
      const headers = new Headers({ authorization: \`Bearer \${token}\` });
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      return new Request(\`http://local\${path}\`, {
        method: options.method || (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    }
    async function body(response) { return await response.json(); }
    const { GET: getTrust } = await import('./src/app/api/mobile/pilot/trust/route.ts');
    const { GET: detailGet } = await import('./src/app/api/mobile/commitments/[id]/route.ts');
    const { POST: nextStepActionPost } = await import('./src/app/api/mobile/recommendations/next-step/actions/route.ts');
    const paramsA = { params: Promise.resolve({ id: state.aCommitmentId }) };
    const paramsB = { params: Promise.resolve({ id: state.bCommitmentId }) };

    let response = await detailGet(req(\`/api/mobile/commitments/\${state.aCommitmentId}\`, state.tokenA), paramsA);
    assert.equal(response.status, 200);
    assert.equal((await body(response)).id, state.aCommitmentId);
    response = await detailGet(req(\`/api/mobile/commitments/\${state.bCommitmentId}\`, state.tokenB), paramsB);
    assert.equal(response.status, 200);
    assert.equal((await body(response)).id, state.bCommitmentId);
    response = await detailGet(req(\`/api/mobile/commitments/\${state.aCommitmentId}\`, state.tokenB), paramsA);
    assert.equal(response.status, 404);
    response = await detailGet(req(\`/api/mobile/commitments/\${state.bCommitmentId}\`, state.tokenA), paramsB);
    assert.equal(response.status, 404);

    response = await getTrust(req('/api/mobile/pilot/trust', state.tokenA));
    assert.equal(response.status, 200);
    const trustA = await body(response);
    assert.equal(trustA.trust.recommendationConsent, true);
    assert.equal(trustA.trust.analyticsConsent, true);
    assert.ok(trustA.trust.firstValueAt);

    response = await nextStepActionPost(req('/api/mobile/recommendations/next-step/actions', state.tokenA, { body: {
      proposal: state.recommendationA,
      decision: 'accept',
      idempotencyKey: 'round-action-a',
    } }));
    assert.equal(response.status, 200);
    assert.equal((await body(response)).replayed, true);
    console.log(JSON.stringify({
      aCommitmentExists: true,
      bCommitmentExists: true,
      crossParticipantLeakage: false,
      trustPersisted: true,
      idempotencyReplayed: true,
    }));
  `, pilotEnv(restoredDir));
  assert.match(verified, /"crossParticipantLeakage":false/);
  assert.match(verified, /"idempotencyReplayed":true/);
});
