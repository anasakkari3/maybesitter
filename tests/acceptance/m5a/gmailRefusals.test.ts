/**
 * Wave E (QA audit de7fcb8): the Gmail routes answer a refusal the person can
 * act on, never a server failure, for a state that is not a Google outage.
 *
 * - CA9.4: an M5a scan with no live Gmail connection was 502
 *   `google_unavailable` (the app then says «في إشي عنا ما ردّ»). It is the
 *   same "not connected" state the legacy scan and the monitor answer 409.
 * - CA9.5: enabling the monitor with a time zone the server cannot read was
 *   502 `google_unavailable` with Google connected. It is a bad request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TZ, begin, beginGoogle, call, connectGoogle, end, scanNew, semanticModel, show } from './support.ts';

test.afterEach(() => end());

test('CA9.4: an M5a scan without a Gmail connection is 409 google_not_connected, not 502', async () => {
  const uid = await begin();
  for (const intent of ['new', 'resume'] as const) {
    const result = intent === 'new'
      ? await scanNew(uid)
      : await call(uid, 'intelligence/sources/gmail/scan', 'POST', { body: { m5: true, intent, timezone: TZ } });
    assert.equal(result.status, 409, show(result.body));
    assert.equal(result.body.reason, 'google_not_connected');
  }
});

test('CA9.5: enabling the monitor with an unreadable time zone is 400 invalid_request, not 502', async () => {
  const uid = await begin();
  beginGoogle(semanticModel(() => []));
  await connectGoogle(uid, 'gmail');
  const result = await call(uid, 'intelligence/sources/gmail/monitor', 'POST', {
    body: { enabled: true, enrollM5: true, timezone: 'Not/AZone' },
  });
  assert.equal(result.status, 400, show(result.body));
  assert.equal(result.body.reason, 'invalid_request');
  // A valid zone right after still switches it on: nothing was left half-done.
  const retry = await call(uid, 'intelligence/sources/gmail/monitor', 'POST', {
    body: { enabled: true, enrollM5: true, timezone: TZ },
  });
  assert.equal(retry.status, 200, show(retry.body));
  assert.equal(retry.body.enabled, true);
});
