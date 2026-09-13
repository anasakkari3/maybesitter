/**
 * Participant state survives a process restart (UC-1.0b, #141; UC-1.0e, #144).
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
 * ── Identity, since UC-1.0e (#144) ───────────────────────────────
 *
 * The two processes used to mint HMAC pilot tokens locally. They carry real
 * Firebase ID tokens from the Auth emulator now, verified by the shipped
 * verifier inside each subprocess — so the restart claim is made about the
 * credential the product actually uses, and the uid each process scopes by is
 * one Firebase minted rather than one this file chose.
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

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-maybesitter';

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

/** A backend process, pointed at the emulators and at its own empty data dir. */
function backendEnv(dataDir: string): Record<string, string> {
  return {
    MAYBESITTER_STORAGE_BACKEND: 'firestore',
    MAYBESITTER_DATA_DIR: dataDir,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    MAYBESITTER_FEATURE_RECOMMENDATION: 'true',
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: 'false',
    MAYBESITTER_EXPERIMENT_NEXT_STEP_ARMS: 'true',
    MAYBESITTER_PILOT_INCIDENT_OWNER_ID: 'round_owner',
  };
}

/** A real account and ID token, through the Auth emulator's REST API. */
async function signUp(): Promise<string> {
  const email = `restart-${Math.random().toString(36).slice(2)}@example.com`;
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'not-a-real-password', returnSecureToken: true }),
    },
  );
  const raw = await response.text();
  assert.equal(response.status, 200, `emulator signUp failed: ${raw}`);
  return (JSON.parse(raw) as { idToken: string }).idToken;
}

test('participant state, trust and recorded decisions survive a restart into a fresh process', async () => {
  const firstDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-restart-first-'));
  const secondDir = mkdtempSync(path.join(tmpdir(), 'maybesitter-restart-second-'));
  const [tokenA, tokenB] = [await signUp(), await signUp()];

  const created = runInline(`
    import assert from 'node:assert/strict';

    const tokenA = ${JSON.stringify(tokenA)};
    const tokenB = ${JSON.stringify(tokenB)};
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
    const { PUT: recommendationConsentPut } = await import('./src/app/api/mobile/consents/recommendations/route.ts');
    const { RECOMMENDATION_CONSENT_VERSION } = await import('./src/contracts/v1/consentContracts.ts');
    const { POST: nextStepActionPost } = await import('./src/app/api/mobile/recommendations/next-step/actions/route.ts');

    for (const token of [tokenA, tokenB]) {
      let response = await updateTrust(req('/api/mobile/pilot/trust', token, { body: { action: { type: 'grant_recommendation_consent' } } }));
      assert.equal(response.status, 200, await response.text());
      response = await updateTrust(req('/api/mobile/pilot/trust', token, { body: { action: { type: 'set_analytics_consent', granted: true } } }));
      assert.equal(response.status, 200);
      // The launch consent as well. Since #170 this is the one the next step
      // reads; the trust flag above is the closed pilot's admission control and
      // no real account ever has it without this.
      response = await recommendationConsentPut(req('/api/mobile/consents/recommendations', token, {
        method: 'PUT',
        body: { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION },
      }));
      assert.equal(response.status, 200, await response.text());
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
    console.log(JSON.stringify({ aCommitmentId, bCommitmentId, recommendationA }));
  `, backendEnv(firstDir));
  assert.match(created, /aCommitmentId/);

  const handoff = JSON.parse(created.trim().split('\n').at(-1) as string) as {
    aCommitmentId: string;
    bCommitmentId: string;
    recommendationA: unknown;
  };

  const verified = runInline(`
    import assert from 'node:assert/strict';
    const state = ${JSON.stringify({ ...handoff, tokenA, tokenB })};
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
  `, backendEnv(secondDir));
  assert.match(verified, /"crossParticipantLeakage":false/);
  assert.match(verified, /"idempotencyReplayed":true/);
});
