import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  reportPlanDecision,
  reportPlanEdited,
  reportPlanOpened,
  reportPlanRegenerated,
  type PlanEvent,
  type PlanReporter,
} from '../planAnalytics';
import { CLIENT_REPORTABLE_EVENTS } from '../../../api/schemas/analytics';
import { NetworkError, PlanEditRefusedError, QuotaExceededError } from '../../../api/errors';
import type { DailyPlan } from '../../../api/schemas/plan';
import todayFixture from '../../../api/__fixtures__/plan.today.json';

/**
 * What the plan screen is allowed to tell anybody about somebody's morning
 * (UC-3.10b, #195 step 7).
 *
 * Two promises, and neither is checkable by reading the code once:
 *
 *  1. **Consent first, and a "maybe" is a no.** The server drops events for a
 *     user who declined, but it cannot drop a request it was never sent, and a
 *     consent read that threw is not a grant.
 *  2. **Shapes, never contents.** A plan's `itemId` *is* a commitment id, so a
 *     list of them is a list of what somebody committed to this morning. The
 *     server's allowlist would refuse a `title`, but being refused is not the
 *     same as not sending it — the refusal happens after the content has
 *     crossed the network.
 *
 * The second promise is asserted against the fixture's real content rather
 * than against a list of field names, so a field added to `DailyPlan` later
 * and copied into an event fails here instead of shipping.
 */

const PLAN = todayFixture.plan as DailyPlan;

/** A reporter that answers a fixed consent and records what it was handed. */
function reporterWith(consent: boolean | 'throws'): PlanReporter & { sent: PlanEvent[] } {
  const sent: PlanEvent[] = [];
  return {
    sent,
    analyticsConsent: () => (consent === 'throws'
      ? Promise.reject(new NetworkError('no signal'))
      : Promise.resolve(consent)),
    report: event => { sent.push(event); },
  };
}

describe('consent is asked before anything is sent', () => {
  it('reports when the trust record says yes', async () => {
    const reporter = reporterWith(true);
    await reportPlanOpened(PLAN, reporter);
    expect(reporter.sent.map(event => event.eventName)).toEqual(['plan_opened']);
  });

  it('sends nothing at all when the answer is no', async () => {
    const reporter = reporterWith(false);
    await reportPlanOpened(PLAN, reporter);
    await reportPlanDecision('accept', PLAN, reporter);
    await reportPlanDecision('dismiss', PLAN, reporter);
    await reportPlanRegenerated(PLAN, reporter);
    await reportPlanEdited({ moves: [{}] }, null, reporter);
    expect(reporter.sent).toEqual([]);
  });

  it('treats a consent read it could not complete as a decline', async () => {
    // Fails closed. An event sent on a guess about somebody's privacy setting
    // is the wrong way round, and "the network was down" is not permission.
    const reporter = reporterWith('throws');
    await reportPlanOpened(PLAN, reporter);
    expect(reporter.sent).toEqual([]);
  });

  it('asks every time, rather than once per session', async () => {
    const consent = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const reporter: PlanReporter = { analyticsConsent: consent, report: () => {} };
    await reportPlanOpened(PLAN, reporter);
    await reportPlanRegenerated(PLAN, reporter);
    expect(consent).toHaveBeenCalledTimes(2);
  });

  it('never turns a metrics failure into the user’s problem', async () => {
    // The accept this rides on must land whatever the analytics call does.
    const reporter: PlanReporter = {
      analyticsConsent: () => Promise.resolve(true),
      report: () => { throw new Error('the analytics route is down'); },
    };
    await expect(reportPlanDecision('accept', PLAN, reporter)).resolves.toBeUndefined();
  });
});

describe('what an event carries', () => {
  async function capture(run: (reporter: PlanReporter) => Promise<void>): Promise<PlanEvent[]> {
    const reporter = reporterWith(true);
    await run(reporter);
    return reporter.sent;
  }

  it('describes the plan by its shape', async () => {
    const [event] = await capture(reporter => reportPlanOpened(PLAN, reporter));
    expect(event).toEqual({
      eventName: 'plan_opened',
      properties: {
        generation: 1,
        scheduledCount: 3,
        unscheduledCount: 0,
        explanationSource: 'template',
        status: 'proposed',
      },
    });
  });

  it('names the decision the person actually made', async () => {
    const accepted = await capture(reporter => reportPlanDecision('accept', PLAN, reporter));
    const dismissed = await capture(reporter => reportPlanDecision('dismiss', PLAN, reporter));
    expect(accepted[0]).toEqual({
      eventName: 'plan_accepted',
      properties: { generation: 1, scheduledCount: 3, unscheduledCount: 0 },
    });
    expect(dismissed[0]).toEqual({ eventName: 'plan_dismissed', properties: { generation: 1 } });
  });

  it('reports the generation the server answered with, not the one on screen', async () => {
    const [event] = await capture(reporter =>
      reportPlanRegenerated({ ...PLAN, generation: 4 }, reporter));
    expect(event).toEqual({ eventName: 'plan_regenerated', properties: { generation: 4 } });
  });

  it('counts a refused move as well as an accepted one, with the server’s reason', async () => {
    // "How often does the planner refuse what people try to do, and why" is
    // the question this screen exists to answer over time. Counting only the
    // successes would answer it wrong.
    const applied = await capture(reporter =>
      reportPlanEdited({ moves: [{}] }, null, reporter));
    const refused = await capture(reporter =>
      reportPlanEdited({ moves: [{}] }, new PlanEditRefusedError('overlaps_fixed_event', 'plan_fixture_0'), reporter));
    expect(applied[0]).toEqual({
      eventName: 'plan_edited',
      properties: { movedCount: 1, removedCount: 0, outcome: 'applied', reason: 'none' },
    });
    expect(refused[0]).toEqual({
      eventName: 'plan_edited',
      properties: { movedCount: 1, removedCount: 0, outcome: 'refused', reason: 'overlaps_fixed_event' },
    });
  });

  it('counts a removal as a removal', async () => {
    const [event] = await capture(reporter =>
      reportPlanEdited({ removals: ['plan_fixture_1'] }, null, reporter));
    expect(event?.properties).toEqual({
      movedCount: 0, removedCount: 1, outcome: 'applied', reason: 'none',
    });
  });

  it('says nothing about an edit the plan never answered', async () => {
    // A lost connection and a 5xx say nothing about the planner's decisions.
    // Recording them as edits would put the network's failures into a number
    // that is read as the planner's.
    for (const error of [new NetworkError('no signal'), new QuotaExceededError('user_daily', 60), new Error('boom')]) {
      expect(await capture(reporter => reportPlanEdited({ moves: [{}] }, error, reporter))).toEqual([]);
    }
  });
});

describe('nothing a plan knows about somebody leaves the device', () => {
  /** Every event this module can produce, over a plan with real content in it. */
  async function everyEvent(): Promise<PlanEvent[]> {
    const reporter = reporterWith(true);
    await reportPlanOpened(PLAN, reporter);
    await reportPlanDecision('accept', PLAN, reporter);
    await reportPlanDecision('dismiss', PLAN, reporter);
    await reportPlanRegenerated(PLAN, reporter);
    await reportPlanEdited({ moves: [{}] }, null, reporter);
    await reportPlanEdited(
      { removals: [PLAN.scheduled[0]!.itemId] },
      new PlanEditRefusedError('overlaps_scheduled_item', PLAN.scheduled[0]!.itemId),
      reporter,
    );
    return reporter.sent;
  }

  it('carries no title, no item id, no explanation and no date', async () => {
    const serialized = JSON.stringify(await everyEvent());
    for (const secret of [
      PLAN.explanation.text,
      PLAN.date,
      PLAN.timezone,
      PLAN.inputDigest,
      ...PLAN.scheduled.map(item => item.title ?? ''),
      // The one that is easiest to talk yourself into: an item id in a plan is
      // a commitment id, so a list of them is a list of somebody's morning.
      ...PLAN.scheduled.map(item => item.itemId),
    ]) {
      expect({ secret, sent: serialized.includes(secret) }).toEqual({ secret, sent: false });
    }
  });

  it('sends scalars only — an object or an array would be a way to smuggle content', async () => {
    for (const event of await everyEvent()) {
      for (const [key, value] of Object.entries(event.properties)) {
        expect({ key, kind: typeof value, array: Array.isArray(value) })
          .toEqual({ key, kind: typeof value === 'number' ? 'number' : 'string', array: false });
      }
    }
  });

  it('is an event the server will accept the name of', async () => {
    const names = new Set((await everyEvent()).map(event => event.eventName));
    expect(names.size).toBe(5);
    for (const name of names) {
      expect({ name, reportable: (CLIENT_REPORTABLE_EVENTS as readonly string[]).includes(name) })
        .toEqual({ name, reportable: true });
    }
  });
});

/**
 * The property names, checked against the server's own allowlist source.
 *
 * `EVENT_PROPERTIES` is what the analytics route validates a body against, and
 * a property it has not heard of is a 400 for the whole event — so a name
 * added here and not there does not lose one field, it loses the event. Read
 * out of the server's file for the same reason `planCopy.test.ts` reads the
 * regenerate cap out of `planSettings.ts`: the two are one decision written in
 * two repositories, and only a test can hold them together.
 */
describe('every property this app sends is one the server allows', () => {
  const SERVER = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', 'lib', 'analytics', 'privacySafeEvents.ts'),
    'utf8',
  );

  /** `plan_opened: ['generation', …],` as the server declares it. */
  function allowedFor(eventName: string): string[] {
    const declared = new RegExp(`\\n\\s*${eventName}:\\s*\\[([^\\]]*)\\]`).exec(SERVER);
    expect({ eventName, declared: declared !== null }).toEqual({ eventName, declared: true });
    return [...declared![1]!.matchAll(/'([^']+)'/g)].map(match => match[1] as string);
  }

  it('finds the allowlist at all, rather than passing on an unreadable file', () => {
    // Without this, a rename of EVENT_PROPERTIES would make every assertion
    // below vacuous instead of red.
    expect(SERVER).toContain('const EVENT_PROPERTIES');
    expect(allowedFor('plan_opened')).toContain('scheduledCount');
  });

  /** Each reporter, run for real, keyed by the event it produces. */
  const EMITTERS: [string, (reporter: PlanReporter) => Promise<void>][] = [
    ['plan_opened', reporter => reportPlanOpened(PLAN, reporter)],
    ['plan_accepted', reporter => reportPlanDecision('accept', PLAN, reporter)],
    ['plan_dismissed', reporter => reportPlanDecision('dismiss', PLAN, reporter)],
    ['plan_regenerated', reporter => reportPlanRegenerated(PLAN, reporter)],
    ['plan_edited', reporter =>
      reportPlanEdited({ moves: [{}] }, new PlanEditRefusedError('empty_edit', null), reporter)],
  ];

  it.each(EMITTERS)('sends %s with properties the server declares', async (eventName, emit) => {
    const reporter = reporterWith(true);
    await emit(reporter);
    expect(reporter.sent[0]?.eventName).toBe(eventName);
    const allowed = allowedFor(eventName);
    expect(Object.keys(reporter.sent[0]!.properties).filter(key => !allowed.includes(key))).toEqual([]);
  });

  it('names nothing the route’s private-key rule would reject', async () => {
    // `PRIVATE_KEY` in the same file: a property whose *name* reads like
    // content is refused whatever its value, and `explanationSource` is one
    // character away from being one of them.
    const forbidden = /(raw|message|text|title|description|person|email|phone|prompt|content)/i;
    const reporter = reporterWith(true);
    await reportPlanOpened(PLAN, reporter);
    await reportPlanEdited({ moves: [{}] }, null, reporter);
    for (const event of reporter.sent) {
      for (const key of Object.keys(event.properties)) {
        expect({ key, private: forbidden.test(key) }).toEqual({ key, private: false });
      }
    }
    expect(SERVER).toContain('const PRIVATE_KEY');
  });
});
