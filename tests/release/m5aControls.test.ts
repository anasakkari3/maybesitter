import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { M5A_CONTROLS_PATH, parseM5aControls, resolveM5aCapabilities } from '../../lib/release/m5aControls.ts';

test('M5a controls validate exact shape and safe epochs', () => {
  assert.deepEqual(parseM5aControls({ email: { epoch: 0, enabled: true }, calendar: { epoch: 4, enabled: false } }), {
    email: { epoch: 0, enabled: true }, calendar: { epoch: 4, enabled: false },
  });
  for (const bad of [null, {}, { email: { epoch: -1, enabled: true }, calendar: { epoch: 0, enabled: true } },
    { email: { epoch: 0, enabled: true }, calendar: { epoch: 0, enabled: true }, extra: true }]) {
    assert.equal(parseM5aControls(bad), null);
  }
});

test('M5a resolver fails closed on absence/malformed data and outside the allow-list', async () => {
  const storage = createMemoryStorage();
  const env = { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_CALENDAR_CHOICE: 'true', MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' };
  assert.deepEqual(await resolveM5aCapabilities({ storage, env }), { calendarChoice: false, emailSources: false, controls: null });
  await storage.set(M5A_CONTROLS_PATH, { email: { epoch: 0, enabled: true }, calendar: { epoch: 0, enabled: true } });
  assert.deepEqual(await resolveM5aCapabilities({ storage, env }), {
    calendarChoice: true, emailSources: true,
    controls: { email: { epoch: 0, enabled: true }, calendar: { epoch: 0, enabled: true } },
  });
  assert.deepEqual(await resolveM5aCapabilities({ storage, env: { ...env, MAYBESITTER_ENV: 'production' } }), {
    calendarChoice: false, emailSources: false,
    controls: { email: { epoch: 0, enabled: true }, calendar: { epoch: 0, enabled: true } },
  });
});
