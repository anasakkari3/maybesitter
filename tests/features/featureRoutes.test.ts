/**
 * The add-on routes and `/api/mobile/capabilities/features` (owner direction,
 * 2026-11-10), in-process as a signed-in user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { begin, call, currentStorage, end } from '../acceptance/m5b/support.ts';

function gate(mode: 'enforce' | 'shadow' | null): void {
  if (mode === null) delete process.env.MAYBESITTER_ADDON_GATE_MODE;
  else process.env.MAYBESITTER_ADDON_GATE_MODE = mode;
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const [warn, error] = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await run(); } finally { console.warn = warn; console.error = error; }
}

test('off: every feature is enabled, nothing is metered, and routes are untouched', async () => {
  const uid = await begin();
  try {
    gate(null);
    const listed = await call(uid, 'capabilities/features', 'GET');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.mode, 'off');
    assert.equal(listed.body.features.length, 8);
    assert.ok(listed.body.features.every((item: { enabled: boolean; usedPercent: unknown }) => item.enabled && item.usedPercent === null));
    // A stored "off" is not obeyed while the gate is off.
    await call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'football' }, body: { enabled: false } });
    assert.equal((await call(uid, 'football', 'GET')).status, 200);
  } finally { gate(null); end(); }
});

test('enforce: the list says what is usable and why; cents never leave the server', async () => {
  const uid = await begin();
  try {
    gate('enforce');
    const listed = await quietly(() => call(uid, 'capabilities/features', 'GET'));
    assert.equal(listed.status, 200);
    const byId = Object.fromEntries(listed.body.features.map((item: { id: string }) => [item.id, item]));
    assert.deepEqual(byId.assistant, {
      id: 'assistant', tier: 'core', enabled: true, reason: 'free_allowance', userCanDisable: false, usedPercent: 0,
    });
    assert.deepEqual([byId.memory_translation.enabled, byId.memory_translation.reason], [false, 'not_entitled']);
    assert.equal(byId.football.usedPercent, null);
    assert.equal(JSON.stringify(listed.body).includes('Cents'), false);
  } finally { gate(null); end(); }
});

test('the person switches an add-on off and on; core, unknown ids and bad bodies are refused', async () => {
  const uid = await begin();
  try {
    gate('enforce');
    const off = await quietly(() => call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'football' }, body: { enabled: false } }));
    assert.equal(off.status, 200);
    const football = off.body.features.find((item: { id: string }) => item.id === 'football');
    assert.deepEqual([football.enabled, football.reason], [false, 'user_off']);
    const stored = await currentStorage().get<{ disabled: string[] }>(`users/${uid}/features/preferences`);
    assert.deepEqual(stored?.disabled, ['football']);

    const locked = await quietly(() => call(uid, 'football', 'GET'));
    assert.deepEqual([locked.status, locked.body.reason, locked.body.feature], [404, 'feature_unavailable', 'football']);

    const on = await call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'football' }, body: { enabled: true } });
    assert.equal(on.body.features.find((item: { id: string }) => item.id === 'football').enabled, true);
    assert.equal((await call(uid, 'football', 'GET')).status, 200);

    const core = await call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'assistant' }, body: { enabled: false } });
    assert.deepEqual([core.status, core.body.reason], [400, 'not_switchable']);
    const unknown = await call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'gmail' }, body: { enabled: false } });
    assert.deepEqual([unknown.status, unknown.body.reason], [404, 'unknown_feature']);
    const bad = await call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'football' }, body: { enabled: 'no' } });
    assert.deepEqual([bad.status, bad.body.reason], [400, 'invalid_body']);
  } finally { gate(null); end(); }
});

test('a paid-only add-on answers the 404 an installed app already hides on', async () => {
  const uid = await begin();
  try {
    gate('enforce');
    const translation = await quietly(() => call(uid, 'memory/[id]/translation', 'POST', { params: { id: 'm1' }, body: { language: 'en' } }));
    assert.deepEqual([translation.status, translation.body.reason, translation.body.feature], [404, 'feature_unavailable', 'memory_translation']);
  } finally { gate(null); end(); }
});

test('Gmail monitoring: switching on asks the add-on, switching off never does', async () => {
  const uid = await begin();
  try {
    gate('enforce');
    await quietly(() => call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'gmail_reading' }, body: { enabled: false } }));
    const previous = process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP;
    process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = 'true';
    try {
      const on = await quietly(() => call(uid, 'intelligence/sources/gmail/monitor', 'POST', { body: { enabled: true } }));
      assert.deepEqual([on.status, on.body.reason, on.body.feature], [404, 'feature_unavailable', 'gmail_reading']);
      const offBody = await quietly(() => call(uid, 'intelligence/sources/gmail/monitor', 'POST', { body: { enabled: false } }));
      assert.notEqual(offBody.body.reason, 'feature_unavailable');
    } finally {
      if (previous === undefined) delete process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP;
      else process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = previous;
    }
  } finally { gate(null); end(); }
});

test('shadow: nothing is locked even when the decision says no', async () => {
  const uid = await begin();
  try {
    gate('shadow');
    const listed = await quietly(() => call(uid, 'capabilities/features', 'GET'));
    assert.ok(listed.body.features.every((item: { enabled: boolean }) => item.enabled));
    const translation = listed.body.features.find((item: { id: string }) => item.id === 'memory_translation');
    assert.equal(translation.reason, 'not_entitled');
  } finally { gate(null); end(); }
});
