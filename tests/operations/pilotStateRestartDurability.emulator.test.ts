/**
 * Participant state survives a process restart (UC-1.0b, #141).
 *
 * ── What this file replaces ──────────────────────────────────────
 *
 * It was `tests/operations/pilotDataRestoreRoundTrip.test.ts`, which proved
 * the same four claims — A/B isolation, commitments readable after a restart,
 * trust persisted, an idempotent action replayed — by copying
 * `<data dir>/participants/*.json` to a backup and restoring it into a second
 * process. Those files no longer exist: participant state, trust and the
 * recorded decisions moved into storage, so there is nothing under the data
 * directory left to copy.
 *
 * The claims are kept and proved against the thing that actually carries them
 * now. Phase two runs in a *different process with a different, empty data
 * directory*, so anything it can still read came from Firestore and from
 * nowhere else — a stronger statement than the file round trip made, since a
 * restored directory could have carried a stale in-process cache's output.
 *
 * `scripts/backup-pilot-data.ts` and its own test are untouched: they still
 * guard the tool that backs up the pilot host's remaining file stores.
 *
 * Emulator-only. Run `npm run test:emulator`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const secret = 'test-only-restart-durability-secret';
const ids = Array.from({ length: 25 }, (_unused, index) => `round-${String(index + 100).padStart(3, '0')}`).join(',');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}

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

/** A pilot process, pointed at the emulator and at its own empty data dir. */
function pilotEnv(dataDir: string): Record<string, string> {
  return {
    MAYBESITTER_PILOT_MODE: 'true',
    MAYBESITTER_STORAGE_BACKEND: 'firestore',
    MAYBESITTER_DATA_DIR: dataDir,
    MAYBESITTER_PILOT_TOKEN_SECRET: secret,
    MAYBESITTER_CLOSED_PILOT_IDS: ids,
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'false',
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: 'true',
    MAYBESITTER_PILOT_INCIDENT_OWNER_ID: 'round_owner',
  };
}

test('participant state, trust and recorded decisions survive a restart into a fresh process', () => {
  const firstDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-restart-first-'));
  const secondDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-restart-second-'));

  const created = runInline(`
    import assert from 'node:assert/strict';
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
    console.log(JSON.stringify({ tokenA, tokenB, aCommitmentId, bCommitmentId, recommendationA }));
  `, pilotEnv(firstDir));
  assert.match(created, /aCommitmentId/);

  const handoff = JSON.parse(created.trim().split('\n').at(-1) as string) as {
    tokenA: string;
    tokenB: string;
    aCommitmentId: string;
    bCommitmentId: string;
    recommendationA: unknown;
  };

  const verified = runInline(`
    import assert from 'node:assert/strict';
    const state = ${JSON.stringify(handoff)};
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
  `, pilotEnv(secondDir));
  assert.match(verified, /"crossParticipantLeakage":false/);
  assert.match(verified, /"idempotencyReplayed":true/);
});
