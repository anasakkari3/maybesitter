/**
 * M5a Gate B — release, durable controls and the recorded owner exception
 * (PLAN-M5a "R0", "Release", M5A-R36-007, M5A-R49-001, M5A-R50-001/003,
 * M5A-R37-007, M5A-R39-006, M5A-R20-001).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTROLS_PATH, begin, beginGoogle, call, connectGoogle, currentStorage, end, semanticModel, show } from './support.ts';

test.afterEach(() => end());

async function probe(uid: string) {
  const result = await call(uid, 'capabilities/m5a', 'GET');
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

test('Release: the probe answers both capabilities when env flag and durable control are on', async () => {
  const body = await probe(await begin());
  assert.equal(body.success, true);
  assert.deepEqual({ c: body.calendarChoice, e: body.emailSources }, { c: true, e: true });
  assert.deepEqual(Object.keys(body).sort(), ['calendarChoice', 'emailSources', 'success'].sort(), 'strict shape');
});

test('Release: each capability is false when its env flag is off or killed, independently', async () => {
  const off = await probe(await begin({ calendarChoice: false, emailSourcesKilled: true }));
  assert.deepEqual([off.calendarChoice, off.emailSources], [false, false]);
  end();
  const mixed = await probe(await begin({ calendarChoiceKilled: true }));
  assert.deepEqual([mixed.calendarChoice, mixed.emailSources], [false, true]);
});

test('M5A-R50-003: the probe is env flag AND durable enabled — a disabled control answers false with the flag still on', async () => {
  const body = await probe(await begin({ controls: { email: { epoch: 3, enabled: false }, calendar: { epoch: 0, enabled: true } } }));
  assert.deepEqual([body.calendarChoice, body.emailSources], [true, false]);
});

test('M5A-R50-003 / M5A-R37-007: a missing control document fails closed (both false)', async () => {
  const body = await probe(await begin({ controls: null }));
  assert.deepEqual([body.calendarChoice, body.emailSources], [false, false]);
});

test('M5A-R37-007: a malformed control document fails closed', async () => {
  const uid = await begin();
  await currentStorage().set(CONTROLS_PATH, { email: { epoch: -1, enabled: 'yes' }, calendar: { epoch: 1.5, enabled: true } });
  const body = await probe(uid);
  assert.deepEqual([body.calendarChoice, body.emailSources], [false, false]);
});

test('M5A-R2-002 (email): a malformed control also refuses M5a admissions, not only the probe', async () => {
  const uid = await begin();
  beginGoogle(semanticModel(() => []));
  await connectGoogle(uid, 'gmail');
  await currentStorage().set(CONTROLS_PATH, { email: { epoch: 0 }, calendar: { epoch: 0, enabled: true } });
  const result = await call(uid, 'intelligence/sources/gmail/scan', 'POST', { body: { m5: true, intent: 'new' } });
  assert.equal(result.status, 409, show(result.body));
  assert.equal(result.body.error, 'm5_unavailable');
});

test('Release: outside local / test / staging both capabilities are false', async () => {
  const body = await probe(await begin({ environment: 'production' }));
  assert.deepEqual([body.calendarChoice, body.emailSources], [false, false]);
});

test('Release: the production flag config pins both off with explicit kill switches, and documents the activation precondition', () => {
  const script = fileURLToPath(new URL('../../../infra/cloudrun/flags.sh', import.meta.url));
  const production = execFileSync('bash', [script, 'production'], { encoding: 'utf8' });
  for (const name of ['CALENDAR_CHOICE', 'EMAIL_SOURCES']) {
    assert.match(production, new RegExp(`MAYBESITTER_FEATURE_${name}=false`), `MAYBESITTER_FEATURE_${name} is not pinned off for production`);
    assert.match(production, new RegExp(`MAYBESITTER_KILL_SWITCH_${name}=false`), `no explicit kill switch for ${name}`);
  }
  const source = readFileSync(script, 'utf8');
  assert.match(source, /100\s*%/, 'flags.sh does not carry the 100 % traffic activation precondition comment (M5A-R20-001)');
});

test('M5A-R20-001 / M5A-R36-007 / M5A-R39-006 / M5A-R50-001: DEPLOY.md carries the activation, kill, enable and recovery procedures', () => {
  const deploy = readFileSync(new URL('../../../docs/operations/DEPLOY.md', import.meta.url), 'utf8');
  assert.match(deploy, /m5a-controls-init/, 'no controls init step');
  assert.match(deploy, /m5a-kill/, 'no kill procedure');
  assert.match(deploy, /m5a-enable/, 'no enable step');
  assert.match(deploy, /m5aControlsLog/, 'no recovery from the kill log');
  assert.match(deploy, /10 minutes/, 'no 10-minute drain precondition');
});

test('R0 / D11: AGENTS.md records the 2026-10-18 email self-reply exception and the daily-sweep and just-in-time approvals', () => {
  const agents = readFileSync(new URL('../../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /Owner exception \(2026-10-18\): email self-reply commitments/);
  assert.match(agents, /daily Gmail sweep/i);
  assert.match(agents, /just-in-time Google busy refresh/i);
  assert.match(agents, /In-Reply-To/, 'the exception does not name the reply-header bound');
});

test('R0 / D11: the Stage B ADR carries a dated amendment for the exception', () => {
  const adr = readFileSync(new URL('../../../docs/architecture/adr-stage-b-engineering-unlock.md', import.meta.url), 'utf8');
  assert.match(adr, /2026-10-18/);
  assert.match(adr, /self-reply/i);
});

test('M5A-R38-007 / M5A-R50-001: the controls endpoint refuses a non-deployer caller and creates exactly the disabled initial document', async () => {
  const uid = await begin({ controls: null });
  let module: Record<string, unknown>;
  try {
    module = await import('../../../src/app/api/internal/m5a-controls/route.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`internal m5a-controls route not built (${(error as Error).message.split('\n')[0]})`);
  }
  const post = module.POST as (request: Request) => Promise<Response>;
  const refused = await post(new Request('http://localhost:3000/api/internal/m5a-controls', { method: 'POST', body: JSON.stringify({ action: 'init' }), headers: { 'content-type': 'application/json' } }));
  assert.ok(refused.status === 401 || refused.status === 403, `an unauthenticated init must be refused (got ${refused.status})`);
  assert.equal(await currentStorage().get(CONTROLS_PATH), null);
  void uid;
});
