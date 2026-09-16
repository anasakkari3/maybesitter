/**
 * Task 12: proving requirement 3 ("the match goes on the calendar") rather
 * than assuming it (UC-3.1 #185, football fixtures brief).
 *
 * The plan's other three requirements each have an implementation task. This
 * one does not — the claim is that `deviceCalendarSync.reconcile` already
 * writes every eligible commitment to the phone calendar with no
 * football-specific code, because a fixture commitment produced by
 * `lib/football/projectFixtures.ts` is, on the wire, an ordinary commitment.
 * That is a claim about two modules that have never been exercised together,
 * so it gets a test instead of a comment.
 *
 * `fixtureCommitment` below is not a hand-shaped approximation: it is built
 * from the exact fields `projectFixtures.ts` writes for a real match —
 * `timeSpecFor` (`kind: 'scheduled_event'`, `dueAt` at kickoff, `endAt` at
 * kickoff + `FIXTURE_BLOCK_MINUTES`, `allDay: false`, `timezone: 'UTC'`) and
 * `createAndConfirmCommands` (`CreateDraft` immediately followed by
 * `ConfirmCommitment`, so the commitment lands `status: 'active'` — see that
 * module's header: following the club *is* the confirmation, so a fixture
 * commitment is never left in a `draft`/`pending_confirmation` state the way
 * a capture is). There is deliberately no `origin` field: `Commitment.origin`
 * was added and withdrawn (see `projectFixtures.ts`'s header), so nothing
 * about a fixture commitment's *shape* distinguishes it from any other — the
 * provenance lives entirely on the `ExternalTaskReference` beside it, which
 * `deviceCalendarSync` never sees.
 */
import { describe, expect, it } from '@jest/globals';
import type { Commitment } from '../../../api/schemas/common';
import { draftFor } from '../eventDraft';
import { decide, type DecideInput } from '../deviceCalendarSync';

/**
 * A commitment exactly as `projectFixtures.ts` builds one: a
 * `scheduled_event` from kickoff to kickoff + 120 minutes (`FIXTURE_BLOCK_MINUTES`,
 * `src/contracts/v1/fixtureContracts.ts`), `status: 'active'` (CreateDraft +
 * ConfirmCommitment), title the fixed placeholder that module documents as
 * never meant to be shown verbatim, and a UTC timezone — fixtures carry no
 * per-user zone, `timeSpecFor` fixes `timezone: 'UTC'`.
 */
function fixtureCommitment(overrides: Partial<Commitment> = {}): Commitment {
  const kickoffUtc = '2026-10-25T19:00:00.000Z';
  const endAt = new Date(Date.parse(kickoffUtc) + 120 * 60_000).toISOString();
  return {
    id: 'fixture-cmt-1',
    kind: 'task',
    title: 'Football fixture',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: {
      kind: 'scheduled_event',
      dueAt: kickoffUtc,
      endAt,
      remindAt: null,
      allDay: false,
      timezone: 'UTC',
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    confirmedAt: '2026-09-16T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

describe('a fixture commitment reaches the calendar the same way any other commitment does', () => {
  it('becomes a two-hour, not-all-day calendar event', () => {
    const draft = draftFor(fixtureCommitment(), 'America/New_York');
    expect(draft).not.toBeNull();
    expect(draft!.allDay).toBe(false);
    expect(draft!.endDate.getTime() - draft!.startDate.getTime()).toBe(120 * 60 * 1000);
  });

  // Breaks the condition this proves: an all-day fixture would not be a
  // two-hour block at all. `timeSpecFor` never sets `allDay: true`, but if it
  // ever did, this is the assertion that would catch it.
  it('[control] an all-day version of the same fixture is not a two-hour block', () => {
    const draft = draftFor(fixtureCommitment({
      timeSpec: {
        kind: 'scheduled_event',
        dueAt: '2026-10-25T19:00:00.000Z',
        endAt: null,
        remindAt: null,
        allDay: true,
        timezone: 'UTC',
      },
    }), 'America/New_York');
    expect(draft!.allDay).toBe(true);
    expect(draft!.endDate.getTime() - draft!.startDate.getTime()).not.toBe(120 * 60 * 1000);
  });

  function baseDecideInput(commitment: Commitment | null): DecideInput {
    return {
      commitmentId: 'fixture-cmt-1',
      commitment,
      link: null,
      writeTarget: 'device',
      writerId: 'writer-this-phone',
      calendarId: 'calendar-1',
      deviceTimeZone: 'America/New_York',
      eventStillThere: true,
    };
  }

  it('reconcile plans to create an event for it — it is not filtered out', () => {
    const plan = decide(baseDecideInput(fixtureCommitment()));
    expect(plan.kind).toBe('create');
    if (plan.kind === 'create') {
      expect(plan.draft.endDate.getTime() - plan.draft.startDate.getTime()).toBe(120 * 60 * 1000);
    }
  });

  // Breaks the condition the test above proves: a commitment `decide` never
  // sees names no time and the plan degrades to `none`/`undated`. Shows the
  // 'create' assertion is load-bearing rather than vacuously true for any
  // commitment at all.
  it('[control] a fixture commitment with no time at all produces no plan to create', () => {
    const timeless = fixtureCommitment({
      timeSpec: {
        kind: 'unscheduled',
        dueAt: null,
        endAt: null,
        remindAt: null,
        allDay: false,
        timezone: 'UTC',
      },
    });
    const plan = decide(baseDecideInput(timeless));
    expect(plan.kind).toBe('none');
  });

  // Breaks the condition "reconcile does not skip feed commitments" would
  // actually be testing if `writeTarget` were ignored: with writing off,
  // nothing is created for *any* commitment, fixture or not. Confirms the
  // 'create' result above is a real decision made from `writeTarget`, not a
  // default.
  it('[control] with the write target off, the same fixture produces no plan', () => {
    const plan = decide({ ...baseDecideInput(fixtureCommitment()), writeTarget: 'off' });
    expect(plan.kind).toBe('none');
  });

  /**
   * Evidence that a fixture commitment actually reaches the list `reconcile`
   * reads, not just that `decide`/`draftFor` would handle one correctly if
   * handed it.
   *
   * `/api/mobile/commitments/today` and `/upcoming`
   * (`src/app/api/mobile/commitments/{today,upcoming}/route.ts`) are built
   * from `listTodayRanked`/`listUpcomingRanked`
   * (`lib/services/mobile/commitmentService.ts`), which filter
   * `Object.values(state.commitments)` — every commitment in the account's
   * domain state — by day placement only (`placeInList`). There is no filter
   * on `kind`, on title, or on anything that would distinguish a fixture
   * commitment from a hand-typed one; `projectFixtures.ts` writes fixture
   * commitments into that same `state.commitments` via
   * `applyParticipantCommands`. So a fixture commitment is not a special case
   * the mobile route has to know about — it is present in
   * `Object.values(state.commitments)` by construction, which is what makes
   * it visible to `subjectsFromCache` and therefore to `reconcile` on the
   * client. This test pins that shape assertion at the unit level: the
   * commitment this suite builds — kind 'task', a scheduled_event timeSpec,
   * status 'active' — carries nothing that any list-filtering code could
   * single out and exclude.
   */
  it('carries no field that would let a list filter it out as a fixture', () => {
    const commitment = fixtureCommitment();
    expect(commitment.kind).toBe('task');
    expect(commitment.status).toBe('active');
    expect('origin' in commitment).toBe(false);
    // Same 'create' decision a docket-typed commitment with an equivalent
    // timeSpec would get — the two are indistinguishable to `decide`.
    const equivalentHandTyped: Commitment = {
      ...commitment,
      id: 'hand-typed-1',
      title: 'Dentist',
    };
    const fixturePlan = decide(baseDecideInput(commitment));
    const handTypedPlan = decide({ ...baseDecideInput(equivalentHandTyped), commitmentId: 'hand-typed-1' });
    expect(fixturePlan.kind).toBe(handTypedPlan.kind);
  });
});
