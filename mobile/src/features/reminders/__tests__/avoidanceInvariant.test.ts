import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { withHermesIntl } from '../../../testing/hermesIntl';
import type { Commitment } from '../../../api/schemas/common';
import type { NotificationGateway, ScheduleRequest } from '../../../notifications/gateway';
import type { ScheduledNotificationRequest } from '../../../notifications/types';
import { EMPTY_AWARENESS } from '../../../lib/deviceSettings/awarenessStore';
import fixture from '../../../api/__fixtures__/commitments.one.json';
import {
  planFor,
  type EscalationCeiling,
  type ReminderIntensity,
  type ReminderPriority,
  type ReminderSettings,
} from '../policy';
import { STAGE_INTENSITY, type QuietWindow } from '../quietHours';
import { desiredRequests, syncCommitments, type SyncInput } from '../softAwarenessEngine';
import { toReminderCommitments } from '../reminderInputs';

/**
 * The phone half of #199's invariant (UC-3.13, resolves #107):
 *
 *   Avoidance may lower or hold pressure. It may never raise it.
 *   No pressure may exceed the user's own ceiling.
 *
 * The server half (`tests/safety/avoidanceNeverEscalates.test.ts`) was first
 * written as a clamp whose only input was constant, so deleting the clamp left
 * the suite green. Every assertion here is therefore paired with the input that
 * makes its guard *do* something:
 *
 *  - the ceiling matrix includes, for every ceiling below the top, a lead, a
 *    priority and an opt-in at which the next stage up would have been
 *    scheduled — so removing any cut in `stagesFor` produces a stage above the
 *    ceiling, not the same plan;
 *  - every avoidance signal is applied to a commitment that, without it, gets
 *    the full ladder — so "nothing got louder" is measured against something
 *    that could have.
 *
 * The user's ceiling on the phone, as #197 (#430) left it: `intensity: 'none'`
 * means nothing at all; otherwise `escalationCeiling` caps the ladder —
 * `soft` → soft, `followUp` → follow-up, `hard` → follow-up, plus the ring only
 * for a Must commitment *and* the explicit `hardEnabled` opt-in. Stages are
 * ranked by `STAGE_INTENSITY`, the table quiet hours break ties with.
 */

const NOW = Date.parse('2026-09-15T09:00:00.000Z');

interface Ceiling {
  readonly intensity: ReminderIntensity;
  readonly escalationCeiling: EscalationCeiling;
  readonly hardEnabled: boolean;
  readonly mustThroughQuietHours: boolean;
}

/** The highest stage rank a ceiling allows a commitment of this priority; -1 is none at all. */
function ceilingRank(ceiling: Ceiling, priority: ReminderPriority): number {
  if (ceiling.intensity === 'none') return -1;
  if (ceiling.escalationCeiling === 'soft') return STAGE_INTENSITY.soft;
  if (ceiling.escalationCeiling === 'hard' && ceiling.hardEnabled && priority === 'must') {
    return STAGE_INTENSITY.strong;
  }
  return STAGE_INTENSITY.followUp;
}

const INTENSITIES: ReminderIntensity[] = ['none', 'softAwareness', 'followUp', 'strongReminder'];
const ESCALATIONS: EscalationCeiling[] = ['soft', 'followUp', 'hard'];
const CEILINGS: Ceiling[] = INTENSITIES.flatMap(intensity => ESCALATIONS.flatMap(escalationCeiling =>
  [false, true].flatMap(hardEnabled => [false, true].map(mustThroughQuietHours =>
    ({ intensity, escalationCeiling, hardEnabled, mustThroughQuietHours })))));
const TOP: Ceiling = {
  intensity: 'strongReminder', escalationCeiling: 'hard', hardEnabled: true, mustThroughQuietHours: false,
};
const LEADS = [60, 30, 15];
const LEVELS: Commitment['priority']['level'][] = ['high', 'normal', 'low'];
const PRIORITY: Record<Commitment['priority']['level'], ReminderPriority> = { high: 'must', normal: 'should', low: 'nice' };

function at(minutesFromNow: number): string {
  return new Date(NOW + minutesFromNow * 60_000).toISOString();
}

/** A full API commitment, so the narrowing in `reminderInputs` is on the path. */
function apiCommitment(
  overrides: Partial<Commitment> = {},
  startsInMinutes = 180,
  level: Commitment['priority']['level'] = 'high',
): Commitment {
  const base = fixture as unknown as Commitment;
  return {
    ...base,
    id: 'c-avoid',
    status: 'active',
    priority: { ...base.priority, level, source: 'user_explicit' },
    timeSpec: { ...base.timeSpec, allDay: false, dueAt: at(startsInMinutes), remindAt: at(startsInMinutes) },
    ...overrides,
  };
}

function settings(ceiling: Ceiling = TOP, softLeadMinutes = 60, softEnabled = true): ReminderSettings {
  return { softEnabled, softLeadMinutes, ...ceiling };
}

function syncInput(commitments: Commitment[], overrides: Partial<SyncInput> = {}): SyncInput {
  return {
    commitments: toReminderCommitments(commitments),
    now: new Date(NOW),
    settings: settings(),
    quietHours: null,
    timeZone: 'Asia/Jerusalem',
    awareness: EMPTY_AWARENESS,
    copy: { title: 'A heads-up', body: 'Something is coming up.' },
    hardCopy: { title: 'Must', body: 'Something you said matters.' },
    exactAlarms: true,
    ...overrides,
  };
}

describe('no stage exceeds the user\'s ceiling, for any priority', () => {
  /*
   * Quiet hours are in the matrix because deferral is the one place the engine
   * picks between stages (`keepHigherIntensity` keeps the firmer one), and
   * `mustThroughQuietHours` is the one place a stage is exempt from the window.
   * A commitment at 08:00 Jerusalem with a 60-minute lead has its soft stage
   * deferred out of a 22:30–07:30 window onto the follow-up's own instant.
   */
  const QUIET: QuietWindow = { start: '22:30', end: '07:30' };
  const EARLY = '2026-09-16T05:00:00.000Z'; // 08:00 in Jerusalem (UTC+3)
  const LATER = '2026-09-16T12:00:00.000Z'; // 15:00 in Jerusalem, clear of the window
  const NIGHT = '2026-09-15T21:00:00.000Z'; // 00:00 in Jerusalem, every stage inside the window

  it('holds across ceiling × opt-in × priority × pressure flags × lead × quiet hours × switch', () => {
    withHermesIntl(() => {
      let planned = 0;
      for (const ceiling of CEILINGS) {
        for (const level of LEVELS) {
          for (const firm of [false, true]) {
            for (const lead of LEADS) {
              for (const softEnabled of [true, false]) {
                for (const [quiet, dueAt] of [[null, LATER], [QUIET, LATER], [QUIET, EARLY], [QUIET, NIGHT]] as const) {
                  const commitment = apiCommitment({
                    priority: {
                      level, source: 'user_explicit', pressureAllowed: firm, pressureLevel: firm ? 'firm' : 'none',
                    },
                    timeSpec: { ...apiCommitment().timeSpec, dueAt },
                  });
                  const { desired } = desiredRequests(syncInput([commitment], {
                    settings: settings(ceiling, lead, softEnabled),
                    quietHours: quiet,
                  }));
                  const allowed = ceilingRank(ceiling, PRIORITY[level]);
                  for (const request of desired) {
                    planned += 1;
                    expect({ ceiling, level, lead, stage: request.stage, within: STAGE_INTENSITY[request.stage] <= allowed })
                      .toEqual({ ceiling, level, lead, stage: request.stage, within: true });
                  }
                }
              }
            }
          }
        }
      }
      // A matrix that planned nothing would pass vacuously.
      expect(planned).toBeGreaterThan(0);
      // And the deferral collision is really in it: two stages met at 07:30.
      const collided = desiredRequests(syncInput(
        [apiCommitment({ timeSpec: { ...apiCommitment().timeSpec, dueAt: EARLY } }, 180, 'normal')],
        { settings: settings({ ...TOP, escalationCeiling: 'followUp' }, 60), quietHours: QUIET },
      )).desired.map(request => request.stage);
      expect(collided).toEqual(['followUp']);
    });
  });

  it('is a cut that does something: the stage above each ceiling exists one step up', () => {
    // The false branch of every clamp. Each pair differs in exactly one input,
    // and the stage the lower one declines is one the higher one takes. If both
    // answered the same, that ceiling would be a constant.
    const stagesAt = (level: Commitment['priority']['level'], ceiling: Ceiling) =>
      planFor(toReminderCommitments([apiCommitment({}, 180, level)])[0]!, settings(ceiling, 60))
        .map(stage => stage.stage);

    expect(stagesAt('high', TOP)).toEqual(['soft', 'followUp', 'strong']);
    // Survey answer `none` overrides every stored ceiling.
    expect(stagesAt('high', { ...TOP, intensity: 'none' })).toEqual([]);
    expect(stagesAt('high', { ...TOP, escalationCeiling: 'soft' })).toEqual(['soft']);
    expect(stagesAt('high', { ...TOP, escalationCeiling: 'followUp' })).toEqual(['soft', 'followUp']);
    // The ring needs the opt-in, and a Must commitment, as well as `hard`.
    expect(stagesAt('high', { ...TOP, hardEnabled: false })).toEqual(['soft', 'followUp']);
    expect(stagesAt('normal', TOP)).toEqual(['soft', 'followUp']);
    expect(stagesAt('low', TOP)).toEqual(['soft', 'followUp']);
  });

  it('never grows as the ceiling is lowered', () => {
    const commitment = toReminderCommitments([apiCommitment()])[0]!;
    const order: Ceiling[] = [
      TOP,
      { ...TOP, hardEnabled: false },
      { ...TOP, escalationCeiling: 'followUp' },
      { ...TOP, escalationCeiling: 'soft' },
      { ...TOP, escalationCeiling: 'soft', intensity: 'none' },
    ];
    for (const lead of LEADS) {
      let previous = new Set(planFor(commitment, settings(order[0]!, lead)).map(stage => stage.stage));
      for (const ceiling of order.slice(1)) {
        const current = new Set(planFor(commitment, settings(ceiling, lead)).map(stage => stage.stage));
        for (const stage of current) expect(previous.has(stage)).toBe(true);
        previous = current;
      }
    }
  });
});

/**
 * Every way the API can say "this person has been avoiding it", applied to a
 * commitment that otherwise gets the whole ladder. None of them changes the
 * commitment's importance: that is the user's word, not a behaviour signal.
 */
const AVOIDANCE_SIGNALS: readonly [string, Partial<Commitment>][] = [
  ['acknowledgement ignored', { currentAckState: 'ignored' }],
  ['acknowledgement postponed', { currentAckState: 'postponed' }],
  ['postponed until later', { postponedUntil: at(60) }],
  ['status missed', { status: 'missed' }],
  ['status deferred', { status: 'deferred' }],
  ['ranked overdue and first', { rank: 0, reasonCodes: ['overdue', 'user_must'] }],
];

/** The server calling pressure allowed and firm, on whatever importance the commitment has. */
function withFirmPressure(commitment: Commitment): Commitment {
  return { ...commitment, priority: { ...commitment.priority, source: 'inferred', pressureAllowed: true, pressureLevel: 'firm' } };
}

function identifiersAndInstants(input: SyncInput): Map<string, number> {
  return new Map(desiredRequests(input).desired.map(request => [request.identifier, request.at]));
}

/** Lower or hold: no identifier the calm plan did not have, and none earlier. */
function expectLowerOrHold(avoided: Map<string, number>, calm: Map<string, number>, label: string) {
  for (const [identifier, instant] of avoided) {
    expect({ label, identifier, inCalmPlan: calm.has(identifier) })
      .toEqual({ label, identifier, inCalmPlan: true });
    expect({ label, identifier, earlier: instant < calm.get(identifier)! })
      .toEqual({ label, identifier, earlier: false });
  }
}

describe('avoidance may lower or hold, never raise', () => {
  const cases: [string, (commitment: Commitment) => Commitment][] = [
    ...AVOIDANCE_SIGNALS.map(([label, signal]) =>
      [label, (commitment: Commitment) => ({ ...commitment, ...signal })] as [string, (c: Commitment) => Commitment]),
    ['server says pressure is allowed and firm', withFirmPressure],
    ['every signal at once', commitment => withFirmPressure(Object.assign({}, commitment, ...AVOIDANCE_SIGNALS.map(([, signal]) => signal)))],
  ];

  it.each(cases)('%s', (label, avoid) => {
    for (const ceiling of CEILINGS) {
      for (const level of LEVELS) {
        for (const lead of LEADS) {
          const overrides = { settings: settings(ceiling, lead) };
          const calm = apiCommitment({}, 180, level);
          expectLowerOrHold(
            identifiersAndInstants(syncInput([avoid(calm)], overrides)),
            identifiersAndInstants(syncInput([calm], overrides)),
            `${label} / ${JSON.stringify(ceiling)} / ${level} / ${lead}`,
          );
        }
      }
    }
  });

  it('is measured against a plan that could have got louder', () => {
    // Without this, "no new stage" would hold trivially for a calm plan that
    // was already empty.
    const calm = identifiersAndInstants(syncInput([apiCommitment()]));
    expect([...calm.keys()].sort()).toEqual(['c-avoid:followUp', 'c-avoid:soft', 'c-avoid:strong']);
  });
});

/**
 * The OS, as the engine sees it: a request is pending until its instant passes,
 * and then it has been delivered and is gone. Nothing marks it seen — that is
 * what ignoring a reminder is.
 */
function deliveringGateway(clock: { now: number }) {
  const pending = new Map<string, number>();
  const scheduled: ScheduleRequest[] = [];
  const gateway: NotificationGateway = {
    async getScheduled(): Promise<ScheduledNotificationRequest[]> {
      for (const [identifier, instant] of [...pending]) if (instant <= clock.now) pending.delete(identifier);
      return [...pending].map(([identifier, instant]) => ({ identifier, at: instant }));
    },
    async schedule(request) {
      scheduled.push(request);
      pending.set(request.identifier, request.at.getTime());
    },
    async cancel(identifier) {
      pending.delete(identifier);
    },
    async cancelAll() {
      pending.clear();
    },
  };
  return { gateway, pending, scheduled };
}

describe('ignored reminders change nothing that is still to come', () => {
  it('delivers each stage once, at its first instant, however often the app resyncs after ignoring it', async () => {
    const clock = { now: NOW };
    const { gateway, scheduled } = deliveringGateway(clock);
    const commitments = [apiCommitment({}, 180)];
    const first = identifiersAndInstants(syncInput(commitments));
    expect(first.size).toBe(3);

    // The soft stage fires at +120, the follow-up at +150, the ring at +170,
    // the commitment is at +180. The app resyncs every ten minutes throughout — commitment changes,
    // relaunches — and the user never taps anything.
    for (let minute = 0; minute <= 200; minute += 10) {
      clock.now = NOW + minute * 60_000;
      await syncCommitments(syncInput(commitments, { now: new Date(clock.now) }), gateway);
    }

    expect(scheduled.map(request => request.identifier).sort()).toEqual([...first.keys()].sort());
    for (const request of scheduled) {
      expect(request.at.getTime()).toBe(first.get(request.identifier));
    }
  });

  it('does not bring a stage back, or forward, when the commitment is also marked ignored', async () => {
    const clock = { now: NOW };
    const { gateway, scheduled } = deliveringGateway(clock);
    const first = identifiersAndInstants(syncInput([apiCommitment({}, 180)]));

    for (let minute = 0; minute <= 200; minute += 10) {
      clock.now = NOW + minute * 60_000;
      // The server learns about the ignore partway through.
      const signal = minute >= 125 ? { currentAckState: 'ignored', status: 'missed' } : {};
      await syncCommitments(syncInput([apiCommitment(signal, 180)], { now: new Date(clock.now) }), gateway);
    }

    for (const request of scheduled) {
      expect(first.has(request.identifier)).toBe(true);
      expect(request.at.getTime()).toBeGreaterThanOrEqual(first.get(request.identifier)!);
    }
    expect(scheduled.filter(request => request.identifier === 'c-avoid:soft')).toHaveLength(1);
  });
});

describe('the app has no way to observe an ignored reminder', () => {
  /*
   * The engine cannot escalate on an ignore it never hears about. Delivery and
   * dismissal listeners are how it would hear, so their absence is the property
   * — and a feature that adds one has to come through here and extend the
   * behavioural tests above to cover what it does with the event. Taps are the
   * only response handled, and a tap marks awareness, which only ever removes
   * stages (`remindersMount.test.tsx`).
   */
  const OBSERVERS = [
    'addNotificationReceivedListener',
    'addNotificationsDroppedListener',
    'setBackgroundMessageHandler',
  ];
  const root = path.resolve(__dirname, '../../..');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'testing' ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('subscribes to no delivery or dismissal event anywhere in the app', () => {
    const files = sourceFiles(root);
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap(file => {
      const text = fs.readFileSync(file, 'utf8');
      return OBSERVERS.filter(name => text.includes(name)).map(name => `${path.relative(root, file)}: ${name}`);
    });
    expect(hits).toEqual([]);
  });
});
