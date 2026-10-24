/**
 * The 7-day e-mail scan reads more than one message a minute (staging,
 * 2026-10-24). A scan step reads one message; the sweep tick ran one step per
 * account, so a real mailbox of a few hundred messages took hours, the count
 * moving by one each minute. One tick now keeps stepping the same account
 * while its scan is running and the tick has room for another message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOW, begin, beginGoogle, connectGoogle, currentStorage, end, plusDays, plusMinutes,
  scanNew, scanStatus, semanticModel, show, tick,
} from '../acceptance/m5a/support.ts';

test.afterEach(() => end());

const requestOf = (text: string) => {
  const evidence = /Please [^.\n]+/.exec(text)?.[0];
  return evidence ? [{ kind: 'request', evidence, confidence: 0.9 }] : [];
};

async function setup(count: number) {
  const uid = await begin();
  const google = beginGoogle(semanticModel(requestOf));
  await connectGoogle(uid, 'gmail');
  google.messages = Array.from({ length: count }, (_, index) => ({
    id: `m-${String(index).padStart(4, '0')}`,
    receivedAt: plusMinutes(plusDays(NOW(), -2), index),
    subject: `Subject ${index}`,
    text: `Please review item ${index}.`,
    category: 'CATEGORY_PERSONAL',
  }));
  return { uid, google };
}

test('one sweep tick reads many messages of a running manual scan, not one', async () => {
  const { uid } = await setup(12);
  const started = await scanNew(uid);
  assert.equal(started.status, 200, show(started.body));
  // The first step lists the page; the steps after it read messages.
  await tick('sweep');
  const scan = await currentStorage().get<{ status: string; page: { done: string[] } | null }>(`users/${uid}/intelligenceGmailScans/manualV2`);
  const read = scan?.status === 'complete' ? 12 : scan?.page?.done.length ?? 0;
  assert.ok(read >= 10, `one tick read ${read} of 12 messages: ${show((await scanStatus(uid)).body)}`);
});

test('the per-tick steps stop at the cap', async () => {
  const { uid } = await setup(60);
  await scanNew(uid);
  await tick('sweep');
  const scan = await currentStorage().get<{ page: { done: string[] } | null }>(`users/${uid}/intelligenceGmailScans/manualV2`);
  const read = scan?.page?.done.length ?? 0;
  // 25 steps a tick (the page was listed when the scan started): at most 25 messages.
  assert.ok(read >= 10 && read <= 25, `read ${read}: the tick must stop at its cap of 25 steps`);
});

// Inspection GMAIL-811-001: rounds, never one account's run-to-cap first.
test('fair rounds: under a tight deadline every account gets a step before any gets a second', async () => {
  const { runFairRoundsForTests } = await import('../../lib/intelligence/gmailJobs.ts');
  const uids = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  const steps: string[] = [];
  const deadline = Date.now() + 200;
  await runFairRoundsForTests(uids, 2, 0, deadline, 25,
    async (uid) => { steps.push(uid); await new Promise((resolve) => setTimeout(resolve, 15)); return true; },
    async () => true);
  const firstSix = steps.slice(0, 6);
  assert.deepEqual([...firstSix].sort(), uids, `the first round served ${firstSix.join(',')}`);
  assert.ok(steps.length > 6, 'a second round ran while the deadline allowed');
});
