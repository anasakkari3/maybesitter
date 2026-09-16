import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyTap, decideResponse, type TapEffects } from '../notificationResponses';
import { handleBackgroundResponse, responseOfTaskPayload } from '../tapEffects';
import { adoptUnboundTaps, loadOutbox, UNBOUND_ACCOUNT } from '../../../lib/deviceSettings/actionOutbox';
import { DEFAULT_DEFER_MS, registerReminderActions, reminderActions } from '../../../notifications/actions';
import { AWARENESS_CATEGORY_ID, HARD_CATEGORY_ID } from '../../../notifications/channels';
import * as notifications from 'expo-notifications';
import { outcomeOfError } from '../outboxSender';
import { mustRingIdentifier } from '../mustRingIdentifier';
import {
  ConflictError, InvalidTransitionError, NetworkError, NotFoundError, ServerError, TimeoutError, UnauthorizedError, ValidationError,
} from '../../../api/errors';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

/** UC-3.14 (#200): which press means what, and what a press does. */
const NOW = Date.UTC(2026, 8, 16, 9, 0);
const DATA = { commitmentId: 'c1', stage: 'soft', notificationId: 'c1:soft' };
const BODY = 'expo.modules.notifications.actions.DEFAULT';

describe('the buttons', () => {
  it('Done and Later stay in the background, Done is not destructive, Not doing it opens the app', () => {
    const [done, later, drop] = reminderActions(en);
    expect(done).toEqual({ identifier: 'done', buttonTitle: 'Done', options: { opensAppToForeground: false } });
    expect(later!.options).toEqual({ opensAppToForeground: false });
    expect(later!.buttonTitle).toBe('Later · 1h');
    expect(drop!.options).toEqual({ opensAppToForeground: true, isDestructive: true });
  });

  it('go on both reminder categories, in the language given', async () => {
    const set = jest.spyOn(notifications, 'setNotificationCategoryAsync');
    await registerReminderActions(ar);
    expect(set.mock.calls.map(call => call[0])).toEqual([AWARENESS_CATEGORY_ID, HARD_CATEGORY_ID]);
    expect((set.mock.calls[0]![1] as { buttonTitle: string }[]).map(action => action.buttonTitle))
      .toEqual([ar.notifActionDone, ar.notifActionLater, ar.notifActionDrop]);
    set.mockRestore();
  });

  it('have copy in all three languages, and none of it scolds', () => {
    for (const locale of [en, ar, he]) {
      for (const key of ['notifActionDone', 'notifActionLater', 'notifActionDrop'] as const) {
        expect(locale[key].trim()).not.toBe('');
        expect(locale[key]).not.toMatch(/\bagain\b|\blate\b|fail|overdue|متأخر|فشل|באיחור|נכשל/i);
      }
    }
  });
});

describe('decideResponse', () => {
  it('maps each button', () => {
    expect(decideResponse('done', DATA, 'c1:soft', NOW)).toEqual(
      { kind: 'enqueue', commitmentId: 'c1', action: 'complete', notificationId: 'c1:soft' },
    );
    expect(decideResponse('later', DATA, 'c1:soft', NOW)).toEqual({
      kind: 'enqueue', commitmentId: 'c1', action: 'postpone', notificationId: 'c1:soft',
      postponedUntil: new Date(NOW + DEFAULT_DEFER_MS).toISOString(),
    });
    expect(decideResponse('drop', DATA, 'c1:soft', NOW)).toEqual({ kind: 'confirmDrop', commitmentId: 'c1' });
    expect(decideResponse(BODY, DATA, 'c1:soft', NOW)).toMatchObject({ kind: 'enqueue', action: 'aware' });
  });

  it('drops unknown buttons and payloads that name no commitment', () => {
    expect(decideResponse('snooze', DATA, 'c1:soft', NOW).kind).toBe('ignore');
    expect(decideResponse('cancel', DATA, 'c1:soft', NOW).kind).toBe('ignore');
    expect(decideResponse(undefined, DATA, 'c1:soft', NOW).kind).toBe('ignore');
    expect(decideResponse('done', { commitmentId: '../../x' }, 'id', NOW).kind).toBe('ignore');
    expect(decideResponse('done', { commitmentId: 'مهمة' }, 'id', NOW).kind).toBe('ignore');
    expect(decideResponse('done', null, 'id', NOW).kind).toBe('ignore');
  });
});

function fakeEffects(): TapEffects & { cancelled: string[]; dismissed: string[]; flushes: number } {
  const effects = {
    accountId: 'acct',
    newId: () => '3f0e8a52-7c1b-4d2e-9a61-0b5c7d9e1f24',
    now: () => new Date(NOW),
    cancelled: [] as string[],
    dismissed: [] as string[],
    flushes: 0,
    async cancelScheduled(identifier: string) {
      effects.cancelled.push(identifier);
    },
    async dismiss(identifier: string) {
      effects.dismissed.push(identifier);
    },
    async flush() {
      effects.flushes += 1;
    },
  };
  return effects;
}

describe('applyTap', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('queues, cancels the commitment’s stages, dismisses and flushes — once for a repeated press', async () => {
    const effects = fakeEffects();
    const decision = decideResponse('done', DATA, 'c1:soft', NOW);
    if (decision.kind !== 'enqueue') throw new Error('unreachable');
    expect(await applyTap(decision, effects)).toBe(true);
    expect(await applyTap(decision, effects)).toBe(false);
    expect(effects.cancelled).toEqual(['c1:soft', 'c1:followUp', 'c1:strong']);
    expect(effects.dismissed).toEqual(['c1:soft']);
    expect(effects.flushes).toBe(1);
    expect((await loadOutbox('acct')).items).toHaveLength(1);
  });

  it('a tap on the Must ring of a 128-character id maps back to the commitment and cancels the hashed request (#198)', async () => {
    const id = 'x'.repeat(128);
    const ring = mustRingIdentifier(id);
    expect(ring).not.toContain(id);
    const effects = fakeEffects();
    const decision = decideResponse('done', { commitmentId: id, stage: 'strong', notificationId: ring }, ring, NOW);
    expect(decision).toEqual({ kind: 'enqueue', commitmentId: id, action: 'complete', notificationId: ring });
    if (decision.kind !== 'enqueue') throw new Error('unreachable');
    await applyTap(decision, effects);
    expect(effects.cancelled).toContain(ring);
    expect(effects.dismissed).toEqual([ring]);
    expect((await loadOutbox('acct')).items[0]!.commitmentId).toBe(id);
    // The server's backup push carries the same data (`hardReminderMessage`).
    expect(decideResponse('later', { kind: 'hard_reminder', commitmentId: id, notificationId: ring, tag: ring }, ring, NOW))
      .toMatchObject({ kind: 'enqueue', commitmentId: id, action: 'postpone' });
  });

  it('a body tap cancels nothing', async () => {
    const effects = fakeEffects();
    const decision = decideResponse(BODY, DATA, 'c1:soft', NOW);
    if (decision.kind !== 'enqueue') throw new Error('unreachable');
    await applyTap(decision, effects);
    expect(effects.cancelled).toEqual([]);
  });
});

describe('the background task', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  const payload = (actionIdentifier: string) => ({
    actionIdentifier,
    notification: { request: { identifier: 'c1:strong', content: { data: { commitmentId: 'c1', stage: 'strong' } } } },
  });

  it('queues Done for the signed-in account', async () => {
    const effects = fakeEffects();
    expect(await handleBackgroundResponse(payload('done'), async () => 'acct', () => effects)).toBe(true);
    expect((await loadOutbox('acct')).items.map(item => item.action)).toEqual(['complete']);
    expect(effects.cancelled).toContain('c1:strong');
  });

  it('leaves the drop button and the body to the app', async () => {
    const effects = fakeEffects();
    expect(await handleBackgroundResponse(payload('drop'), async () => 'acct', () => effects)).toBe(false);
    expect(await handleBackgroundResponse(payload(BODY), async () => 'acct', () => effects)).toBe(false);
    expect((await loadOutbox('acct')).items).toHaveLength(0);
  });

  it('with no session restored the tap is kept unbound, not lost, and the next account adopts it', async () => {
    const seenAccounts: string[] = [];
    expect(await handleBackgroundResponse(payload('done'), async () => null, (account) => {
      seenAccounts.push(account);
      return { ...fakeEffects(), accountId: account };
    })).toBe(true);
    expect(seenAccounts).toEqual([UNBOUND_ACCOUNT]);
    expect((await loadOutbox(UNBOUND_ACCOUNT)).items.map(item => item.commitmentId)).toEqual(['c1']);
    expect(await adoptUnboundTaps('acct')).toBe(1);
    expect((await loadOutbox('acct')).items.map(item => item.action)).toEqual(['complete']);
    expect((await loadOutbox(UNBOUND_ACCOUNT)).items).toHaveLength(0);
  });

  it('ignores a payload that is a received notification, not a response', () => {
    expect(responseOfTaskPayload({ notification: null, data: { dataString: '{}' } })).toBeNull();
    expect(responseOfTaskPayload(null)).toBeNull();
  });
});

describe('which failures are retried', () => {
  it('drops what the server refused and retries what never got an answer', () => {
    for (const refused of [new NotFoundError('x'), new InvalidTransitionError(), new ConflictError('x'), new ValidationError('x')]) {
      expect(outcomeOfError(refused)).toBe('drop');
    }
    for (const unanswered of [new NetworkError('x'), new TimeoutError('x'), new ServerError('x', 503), new UnauthorizedError('x')]) {
      expect(outcomeOfError(unanswered)).toBe('retry');
    }
  });
});
