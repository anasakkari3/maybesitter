import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import {
  actOnPlan,
  buildPlan,
  getPlan,
  getPlanSettings,
  markPlanOpened,
  putPlanSettings,
  regeneratePlan,
} from '../endpoints/plans';
import {
  PlanEditRefusedError,
  PlanProposalRefusedError,
  QuotaExceededError,
  ServerError,
  ValidationError,
} from '../errors';
import { userFacingMessage } from '../ui/userFacingMessage';
import { strings } from '../../i18n/strings';

/**
 * The plan routes (UC-3.10a #194, called by UC-3.10b #195).
 *
 * Every response below is the committed fixture, which
 * `tests/mobile/exportMobileApiFixtures.test.ts` produced by invoking the real
 * handler — so this is "does the client send what the route accepts and read
 * what it answered", not a conversation with a hand-written stub.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

let requests: { url: string; method: string; body: unknown }[] = [];

function serve(body: unknown, status = 200): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    requests.push({
      url,
      method: init.method as string,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return { status, text: async () => JSON.stringify(body), headers: { get: () => null } };
  }) as never;
}

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('reading a plan', () => {
  it('reads the route’s own answer into the type the screen uses', async () => {
    serve(fixture('plan.today'));
    const plan = await getPlan('2026-08-09');
    expect(requests[0]).toMatchObject({ url: 'http://localhost:3000/api/mobile/plans/2026-08-09', method: 'GET' });
    expect(plan).not.toBeNull();
    expect(plan!.status).toBe('proposed');
    expect(plan!.generation).toBe(1);
    expect(plan!.timezone).toBe('Asia/Jerusalem');
    expect(plan!.scheduled).toHaveLength(3);
  });

  it('answers null for a day with no plan, rather than throwing', async () => {
    // The route 404s deliberately: "no plan was built for you" and "a plan was
    // built and it is empty" are different things to tell somebody. A thrown
    // NotFoundError would put an error screen with a useless Retry in front of
    // a user whose delivery is simply switched off.
    serve(fixture('plan.notFound'), 404);
    await expect(getPlan('2026-08-09')).resolves.toBeNull();
  });

  it('still throws for a failure that is not "there is no plan"', async () => {
    serve({ success: false, error: 'boom' }, 500);
    await expect(getPlan('2026-08-09')).rejects.toBeInstanceOf(ServerError);
  });

  it('refuses to put anything but a civil date into the path', async () => {
    // A plan date arrives from a deep link, which is a string a stranger chose.
    serve(fixture('plan.today'));
    for (const bad of ['../../account', 'today', '2026-8-9', '2026-08-09T00:00:00Z', '']) {
      await expect(getPlan(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('recording that a plan was put on screen (#533)', () => {
  it('posts the date and reads the acknowledgement', async () => {
    serve(fixture('plan.opened'));
    await markPlanOpened('2026-08-09');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'http://localhost:3000/api/mobile/plans/2026-08-09/opened',
      method: 'POST',
      // No body: the route learns everything from the token and the path.
      body: undefined,
    });
  });

  it('refuses to put anything but a civil date into the path', async () => {
    serve(fixture('plan.opened'));
    await expect(markPlanOpened('today')).rejects.toBeInstanceOf(ValidationError);
    expect(requests).toHaveLength(0);
  });
});

describe('acting on a plan', () => {
  it('accepts, and reads the new status back from the same response', async () => {
    serve(fixture('plan.accepted'));
    const plan = await actOnPlan('2026-08-09', { action: 'accept' });
    expect(requests[0]).toMatchObject({
      url: 'http://localhost:3000/api/mobile/plans/2026-08-09/actions',
      method: 'POST',
      body: { action: 'accept' },
    });
    expect(plan.status).toBe('accepted');
    expect(plan.acceptedAt).not.toBeNull();
  });

  it('sends a move with both ends, so the length is never the server’s guess', async () => {
    serve(fixture('plan.accepted'));
    await actOnPlan('2026-08-09', {
      action: 'edit',
      moves: [{ itemId: 'plan_fixture_0', startsAt: '2026-08-09T10:00:00.000Z', endsAt: '2026-08-09T10:30:00.000Z' }],
    });
    expect(requests[0]!.body).toEqual({
      action: 'edit',
      moves: [{ itemId: 'plan_fixture_0', startsAt: '2026-08-09T10:00:00.000Z', endsAt: '2026-08-09T10:30:00.000Z' }],
    });
  });

  it('turns a refused edit into an error that still knows which item it is about', async () => {
    // The whole point of the 422 having its own schema: `errorBodySchema` would
    // parse this body and throw `itemId` away, and the screen could then only
    // show the refusal as a page-level failure instead of under the row the
    // user dragged.
    serve(fixture('plan.editRejected'), 422);
    const error = await actOnPlan('2026-08-09', { action: 'edit', removals: ['x'] }).catch(e => e);
    expect(error).toBeInstanceOf(PlanEditRefusedError);
    expect((error as PlanEditRefusedError).reason).toBe('unknown_item');
    expect((error as PlanEditRefusedError).itemId).toBe('not-in-this-plan');
  });

  it('carries every refusal reason the route can raise', async () => {
    for (const reason of [
      'outside_horizon', 'outside_working_window', 'overlaps_fixed_event',
      'overlaps_scheduled_item', 'invalid_instant', 'invalid_interval', 'empty_edit',
    ] as const) {
      serve({ success: false, error: 'no', reason, itemId: 'i1' }, 422);
      const error = await actOnPlan('2026-08-09', { action: 'edit', removals: ['i1'] }).catch(e => e);
      expect((error as PlanEditRefusedError).reason).toBe(reason);
    }
  });

  it('falls back to a plain refusal when a 422 body is not the shape it claims', async () => {
    // A refusal whose reason the client cannot read must not become a guess:
    // showing "that time is already taken" for a body that said nothing of the
    // kind would put a sentence under the wrong item.
    serve({ success: false, error: 'no', reason: 'something_new', itemId: 'i1' }, 422);
    const error = await actOnPlan('2026-08-09', { action: 'edit', removals: ['i1'] }).catch(e => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(PlanEditRefusedError);
  });
});

describe('answering a plan-change offer (#523, #611)', () => {
  it('names the offer being answered, so a replaced one cannot be accepted blind', async () => {
    serve(fixture('plan.accepted'));
    await actOnPlan('2026-08-09', { action: 'accept_proposal', proposalId: 'prp_on_screen' });
    await actOnPlan('2026-08-09', { action: 'reject_proposal', proposalId: 'prp_on_screen' });
    expect(requests.map(request => request.body)).toEqual([
      { action: 'accept_proposal', proposalId: 'prp_on_screen' },
      { action: 'reject_proposal', proposalId: 'prp_on_screen' },
    ]);
  });

  it.each<[string, PlanProposalRefusedError['reason']]>([
    ['plan.proposal.stale', 'stale_proposal'],
    ['plan.proposal.none', 'no_proposal'],
  ])('keeps the reason of the recorded %s refusal', async (name, reason) => {
    // The handler's own 422 bodies: no `itemId`, so the edit schema cannot
    // read them, and they used to fall to a bare ValidationError.
    serve(fixture(name), 422);
    const error = await actOnPlan('2026-08-09', { action: 'accept_proposal' }).catch(e => e);
    expect(error).toBeInstanceOf(PlanProposalRefusedError);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect((error as PlanProposalRefusedError).reason).toBe(reason);
  });

  it.each<['accept_proposal' | 'reject_proposal']>([['accept_proposal'], ['reject_proposal']])(
    'names the refused answer (%s) on the error, so the sentence can fit it',
    async action => {
      serve(fixture('plan.proposal.stale'), 422);
      const error = await actOnPlan('2026-08-09', { action, proposalId: 'prp_on_screen' }).catch(e => e);
      expect(error).toBeInstanceOf(PlanProposalRefusedError);
      expect((error as PlanProposalRefusedError).reason).toBe('stale_proposal');
      expect((error as PlanProposalRefusedError).action).toBe(action);
    },
  );

  it('tells a declined offer a newer one replaced that the plan was kept, not that nothing was applied', () => {
    // "Keep my plan" refused as stale (#611): the plan is exactly what the
    // person asked for. The accept sentence says the opposite of reassuring.
    for (const t of Object.values(strings)) {
      const declined = userFacingMessage(new PlanProposalRefusedError('stale_proposal', 'reject_proposal'), t);
      const accepted = userFacingMessage(new PlanProposalRefusedError('stale_proposal', 'accept_proposal'), t);
      expect(declined).toBe(t.errorsPlanProposalReplaced);
      expect(accepted).toBe(t.errorsPlanProposalStale);
      expect(declined).not.toBe(accepted);
      // Nothing pending is one sentence for either answer.
      expect(userFacingMessage(new PlanProposalRefusedError('no_proposal', 'reject_proposal'), t)).toBe(t.errorsPlanProposalGone);
      expect(userFacingMessage(new PlanProposalRefusedError('no_proposal', 'accept_proposal'), t)).toBe(t.errorsPlanProposalGone);
    }
  });

  it('says each refusal in its own words in every language, never "check it and try again"', () => {
    for (const t of Object.values(strings)) {
      const stale = userFacingMessage(new PlanProposalRefusedError('stale_proposal'), t);
      const gone = userFacingMessage(new PlanProposalRefusedError('no_proposal'), t);
      expect(stale).toBe(t.errorsPlanProposalStale);
      expect(gone).toBe(t.errorsPlanProposalGone);
      expect(stale).not.toBe(gone);
      for (const said of [stale, gone]) {
        expect(said).not.toBe(t.errorsValidation);
        expect(said).not.toBe(t.errorsGeneric);
      }
    }
  });

  it('still reads an edit refusal as an edit refusal', async () => {
    serve({ success: false, error: 'no', reason: 'overlaps_fixed_event', itemId: 'i1' }, 422);
    const error = await actOnPlan('2026-08-09', { action: 'edit', removals: ['i1'] }).catch(e => e);
    expect(error).toBeInstanceOf(PlanEditRefusedError);
  });
});

describe('rebuilding a plan', () => {
  it('reads the new generation back', async () => {
    serve(fixture('plan.regenerated'));
    const plan = await regeneratePlan('2026-08-09');
    expect(requests[0]).toMatchObject({
      url: 'http://localhost:3000/api/mobile/plans/2026-08-09/regenerate',
      method: 'POST',
    });
    expect(plan.generation).toBe(2);
  });

  it('surfaces the daily cap as a refusal the screen can act on', async () => {
    // The route answers 429 with `reason: 'limit_reached'` and no `scope`, so
    // the client's quota mapping falls back to `user_daily` — which is the
    // right shape here: a limit that clears tomorrow, never retried.
    serve({ success: false, error: 'a plan can be rebuilt 4 times a day', reason: 'limit_reached' }, 429);
    await expect(regeneratePlan('2026-08-09')).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('building a plan the morning has not reached (#477)', () => {
  it('posts to the build route and reads the first generation back', async () => {
    serve(fixture('plan.built'));
    const plan = await buildPlan('2026-08-10');
    expect(requests[0]).toMatchObject({
      url: 'http://localhost:3000/api/mobile/plans/2026-08-10/build',
      method: 'POST',
    });
    expect(requests).toHaveLength(1);
    expect(plan.date).toBe('2026-08-10');
    expect(plan.generation).toBe(1);
  });

  it('refuses to build a request for a date that is not one', async () => {
    serve(fixture('plan.built'));
    await expect(buildPlan('../settings')).rejects.toBeInstanceOf(ValidationError);
    expect(requests).toHaveLength(0);
  });
});

describe('the morning-plan setting', () => {
  it('reads what the account has chosen', async () => {
    serve(fixture('plan.settingsDefault'));
    const settings = await getPlanSettings();
    expect(requests[0]).toMatchObject({ url: 'http://localhost:3000/api/mobile/settings/plan', method: 'GET' });
    // Until #195 turns it on, nothing is built for anybody.
    expect(settings.enabled).toBe(false);
    expect(settings.deliveryLocalTime).toBe('07:30');
    expect(settings.nextRunAt).toBeNull();
  });

  it('round-trips the switch and answers with the server’s own next run', async () => {
    serve(fixture('plan.settingsSaved'));
    const saved = await putPlanSettings({ enabled: true, deliveryLocalTime: '07:30' });
    expect(requests[0]).toMatchObject({
      url: 'http://localhost:3000/api/mobile/settings/plan',
      method: 'PUT',
      body: { enabled: true, deliveryLocalTime: '07:30' },
    });
    expect(saved.enabled).toBe(true);
    // The instant is the server's arithmetic, not a DST boundary recomputed on
    // the phone.
    expect(saved.nextRunAt).toBe('2026-08-09T09:00:00.000Z');
  });

  it('leaves the stored hour alone when only the switch moved', async () => {
    serve(fixture('plan.settingsSaved'));
    await putPlanSettings({ enabled: false });
    expect(requests[0]!.body).toEqual({ enabled: false });
  });

  it('reads the continuous-replanning switch rather than dropping it (#523)', async () => {
    // Before the schema named it, zod stripped the field, so the server's
    // default-on reached the client as undefined.
    serve(fixture('plan.settingsDefault'));
    expect((await getPlanSettings()).continuousReplanEnabled).toBe(true);
  });

  it('sends the replanning switch only when it is the thing being changed', async () => {
    serve(fixture('plan.settingsSaved'));
    // No `enabled`: the route accepts this write alone without it, so the
    // phone never re-sends a morning value it only has cached.
    await putPlanSettings({ continuousReplanEnabled: false });
    expect(requests[0]!.body).toEqual({ continuousReplanEnabled: false });
  });
});
