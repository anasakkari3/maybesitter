// Controlled production smoke test. Creates and removes only its own unique test record.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const origin = 'https://maybesitter-app.web.app';
const email = `launch-smoke-${randomUUID()}@example.com`;
const id = createHash('sha256').update(email).digest('hex');
const documentUrl = `https://firestore.googleapis.com/v1/projects/maybesitter-app/databases/(default)/documents/earlyAccessRegistrations/${id}`;
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const auth = { Authorization: `Bearer ${token}` };
const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
const home = await boundedFetch(origin);
assert.equal(home.status, 200);
const html = await home.text();
assert.ok(html.includes('product-today-en.png'));
assert.ok(html.includes('anasakkari04@gmail.com'));
assert.ok(!html.includes('{{'));
for (const path of ['/assets/product-today-en.png', '/assets/product-calendar-en.png', '/assets/product-first-move-en.png', '/early-access-privacy', '/launch.js']) {
  assert.equal((await boundedFetch(origin + path)).status, 200, path);
}
assert.equal((await boundedFetch(origin + '/en/privacy')).status, 404, 'Draft legal page must not be published');
const submit = (data) => boundedFetch(origin + '/api/early-access', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
let created = false;
try {
  const data = { name: 'Deployment smoke test', email, device: 'iphone', source: 'qa-deploy' };
  const first = await submit(data);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).ok, true);
  const read = await boundedFetch(documentUrl, { headers: auth });
  assert.equal(read.status, 200, 'Acknowledged signup must exist in production Firestore');
  const saved = (await read.json()).fields;
  assert.equal(saved.email.stringValue, email);
  assert.equal(saved.source.stringValue, 'qa-deploy');
  created = true;
  const duplicate = await submit({ ...data, name: 'Must not overwrite', device: 'android', source: 'duplicate' });
  assert.equal(duplicate.status, 200);
  const reread = await boundedFetch(documentUrl, { headers: auth });
  assert.deepEqual((await reread.json()).fields, saved, 'Duplicate must preserve original record');
  assert.equal((await boundedFetch(documentUrl)).status, 403, 'Registration must not be publicly readable');
  assert.equal((await submit({})).status, 422);
  const forbidden = await boundedFetch(origin + '/api/early-access', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal(forbidden.status, 403);
  console.log('PASS: public page, English images, privacy, durable Firestore signup, duplicate preservation, private records, validation, and origin checks.');
} finally {
  if (created) {
    const removed = await boundedFetch(documentUrl, { method: 'DELETE', headers: auth });
    assert.equal(removed.status, 200, 'Remove only the uniquely generated smoke-test record');
    console.log('Removed this run’s temporary test registration. No customer records touched.');
  }
}
