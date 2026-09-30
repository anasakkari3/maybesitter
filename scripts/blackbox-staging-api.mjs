/** Synthetic account probe against a tagged staging revision. Never prints credentials. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.STAGING_CANDIDATE_URL;
if (!base?.startsWith('https://')) throw new Error('STAGING_CANDIDATE_URL must be an https tagged revision');
const firebase = JSON.parse(readFileSync(resolve('mobile/firebase/google-services.json'), 'utf8'));
assert.equal(firebase.project_info.project_id, 'maybesitter-app');
const key = firebase.client?.[0]?.api_key?.[0]?.current_key;
if (!key) throw new Error('Firebase public API key unavailable');

async function jsonResponse(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { status: response.status, body };
}

let token;
let cleanup = 'not_needed';
try {
  const signup = await jsonResponse(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(signup.status, 200, `synthetic Firebase account could not be created (${signup.status})`);
  token = signup.body.idToken;
  assert.equal(typeof token, 'string');
  const call = (method, path, body) => jsonResponse(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const statement = await call('POST', '/api/mobile/intelligence', {
    text: 'عندي امتحان بكرة الصبح، وعندي سهرة مع صحابي الليلة، ومش متأكد من جاهزيتي. حابب أتعلم React.',
  });
  assert.equal(statement.status, 201, `statement route failed (${statement.status})`);
  assert.ok(statement.body.observations?.length >= 2);
  const generation = await call('POST', '/api/mobile/intelligence/generate', {});
  assert.equal(generation.status, 200, `generation route failed (${generation.status})`);
  const ideas = generation.body.suggestions ?? [];
  const observations = statement.body.observations;
  const eventIds = new Set(observations.filter(item => item.kind === 'event').map(item => item.id));
  const hasPreparation = ideas.some(item => item.kind === 'action' && item.observationIds.some(id => eventIds.has(id)));
  assert.ok(hasPreparation, 'no event preparation action was proposed');
  assert.ok(ideas.length >= 2, 'expected more than one reviewed idea');
  assert.ok((generation.body.schedule ?? []).every(item => !item.slot || Date.parse(item.slot.startsAt) >= Date.now() - 60_000));
  const inbox = await call('GET', '/api/mobile/intelligence');
  assert.equal(inbox.status, 200);
  assert.ok(inbox.body.suggestions.length >= ideas.length);
  const firstAction = ideas.find(item => item.kind === 'action');
  const acceptedSlot = generation.body.schedule.find(item => item.suggestionId === firstAction.id)?.slot;
  assert.ok(acceptedSlot, 'an action needs a feasible proposed time');
  const accept = await call('POST', `/api/mobile/intelligence/suggestions/${firstAction.id}`, {
    decision: 'accept', title: 'مراجعة سريعة للامتحان', slot: acceptedSlot,
  });
  assert.equal(accept.status, 200, `explicit acceptance failed (${accept.status})`);
  assert.equal(accept.body.suggestion.status, 'accepted');
  const detail = await call('GET', `/api/mobile/commitments/${accept.body.suggestion.linkedEntityId}`);
  assert.equal(detail.status, 200, `accepted task unavailable (${detail.status})`);
  assert.equal(detail.body.title, 'مراجعة سريعة للامتحان');
  assert.equal(detail.body.timeSpec.dueAt, acceptedSlot.startsAt);
  assert.equal(detail.body.timeSpec.endAt, acceptedSlot.endsAt);
  const repeat = await call('POST', `/api/mobile/intelligence/suggestions/${firstAction.id}`, {
    decision: 'accept', title: 'مراجعة سريعة للامتحان',
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.suggestion.linkedEntityId, accept.body.suggestion.linkedEntityId);
  process.stdout.write(`${JSON.stringify({ observations: observations.length, ideas: ideas.length,
    hasPreparation, schedulePreviews: generation.body.schedule.length, scheduledAtAccept: true,
    acceptedOnce: true, retryIdempotent: true })}\n`);
} finally {
  if (token) {
    const deleted = await jsonResponse(`${base}/api/mobile/account`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'delete-my-account' }),
    }).catch(() => ({ status: 0 }));
    cleanup = deleted.status === 200 ? 'account_deleted' : `account_delete_failed_${deleted.status}`;
    if (deleted.status !== 200) {
      await jsonResponse(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }),
      }).catch(() => undefined);
    }
  }
  process.stdout.write(`${JSON.stringify({ cleanup })}\n`);
}
