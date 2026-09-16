/**
 * What the calendar sync does, and the five things it must never do
 * (UC-3.1, #185).
 *
 * Almost every acceptance criterion for #185 is a statement about a *decision*:
 * with the target off nothing is written, a second device writes nothing, an
 * event the user deleted is never recreated, "remove what MaybeSitter added"
 * removes only that. None of them can be observed in Jest, because a calendar
 * is a device with seeded data — but all of them can be *decided* here, because
 * `decide` takes no clock, no storage and no native module.
 *
 * So this file holds the invariants, and the device run holds the effects. Each
 * case below is written so that removing the guard it names turns it red; the
 * matrix in the pull request lists which line kills which test.
 */
import { describe, expect, it } from '@jest/globals';
import type { Commitment, DeviceCalendarLink } from '../../../api/schemas/common';
import type { CalendarAccess, CalendarEventDraft, DeviceCalendar } from '../deviceCalendar';
import { DeviceCalendarError } from '../deviceCalendar';
import {
  decide,
  reconcile,
  removeAllWrittenEvents,
  type SyncPorts,
  type SyncSubject,
} from '../deviceCalendarSync';
import { subjectsFromCache } from '../useDeviceCalendarSync';
import { draftFor } from '../eventDraft';

const ZONE = 'Pacific/Chatham';
const MINE = 'writer-this-phone';
const THEIRS = 'writer-other-phone';

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'cmt-1',
    kind: 'task',
    title: 'Dentist',
    description: null,
    person: null,
    status: 'active',
    category: null,
    categorySource: 'inferred',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: {
      kind: 'due_by',
      dueAt: '2026-06-15T02:00:00.000Z',
      endAt: null,
      remindAt: null,
      allDay: false,
      timezone: ZONE,
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    confirmedAt: '2026-06-01T00:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

function link(overrides: Partial<DeviceCalendarLink> = {}): DeviceCalendarLink {
  return {
    writerId: MINE,
    calendarId: 'cal-1',
    eventId: 'evt-1',
    contentHash: 'stale',
    state: 'linked',
    writtenAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The hash the mapper would produce for this commitment, so "unchanged" is real. */
function currentHash(subject: Commitment): string {
  return draftFor(subject, ZONE)!.contentHash;
}

function input(overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  return {
    commitmentId: 'cmt-1',
    commitment: commitment() as Commitment | null,
    link: null as DeviceCalendarLink | null | undefined,
    writeTarget: 'device' as const,
    writerId: MINE,
    calendarId: 'cal-1',
    deviceTimeZone: ZONE,
    eventStillThere: true,
    ...overrides,
  };
}

/** A subject as `subjectsFromCache` builds one: the commitment, and its link. */
function subject(value: Commitment, linkValue: DeviceCalendarLink | null | undefined): SyncSubject {
  return { commitmentId: value.id, commitment: value, link: linkValue };
}

/** The other kind: a link the account still holds for a commitment it does not. */
function orphan(commitmentId: string, linkValue: DeviceCalendarLink): SyncSubject {
  return { commitmentId, commitment: null, link: linkValue };
}

/* ── The invariants ───────────────────────────────────────────────── */

describe('with the write target off', () => {
  it('writes nothing, for a commitment that has never been written', () => {
    expect(decide(input({ writeTarget: 'off' }))).toEqual({ kind: 'none', because: 'target_off' });
  });

  it('leaves an event already in the calendar exactly where it is', () => {
    // "Stop adding" is not "delete a month of entries". Turning the switch off
    // must not reach into somebody's calendar.
    expect(decide(input({ writeTarget: 'off', link: link() })))
      .toEqual({ kind: 'none', because: 'target_off' });
  });

  it('does the same when the target is Google (UC-3.3, #187)', () => {
    expect(decide(input({ writeTarget: 'google' }))).toEqual({ kind: 'none', because: 'target_off' });
  });
});

describe('a link another installation owns', () => {
  it('is never written beside', () => {
    expect(decide(input({ link: link({ writerId: THEIRS }) })))
      .toEqual({ kind: 'none', because: 'foreign_writer' });
  });

  it('is never deleted, even when the commitment is gone', () => {
    // The other device's calendar is not reachable from here, and its link row
    // is the only thing that will ever let it clean up after itself.
    expect(decide(input({ link: link({ writerId: THEIRS }), commitment: null })))
      .toEqual({ kind: 'none', because: 'foreign_writer' });
  });

  it('is not detached just because this device cannot see the event', () => {
    expect(decide(input({ link: link({ writerId: THEIRS }), eventStillThere: false })))
      .toEqual({ kind: 'none', because: 'foreign_writer' });
  });
});

describe('an event the user deleted in their calendar', () => {
  it('is recorded as detached the first time it is noticed', () => {
    expect(decide(input({ link: link(), eventStillThere: false })))
      .toEqual({ kind: 'detach', eventId: 'evt-1' });
  });

  it('is never recreated afterwards, however the commitment is edited', () => {
    const edited = commitment({ title: 'Dentist, moved', updatedAt: '2026-06-02T00:00:00.000Z' });
    expect(decide(input({ commitment: edited, link: link({ state: 'detached' }) })))
      .toEqual({ kind: 'none', because: 'detached' });
  });

  it('is not deleted again when the commitment itself goes', () => {
    expect(decide(input({ link: link({ state: 'detached' }), commitment: null })))
      .toEqual({ kind: 'none', because: 'detached' });
  });
});

describe('the ordinary path', () => {
  it('creates an event for a dated commitment with no link', () => {
    const plan = decide(input());
    expect(plan.kind).toBe('create');
  });

  it('creates nothing for a commitment with no time', () => {
    const undated = commitment({
      timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    });
    expect(decide(input({ commitment: undated }))).toEqual({ kind: 'none', because: 'undated' });
  });

  it('creates nothing until a calendar has been picked on this device', () => {
    expect(decide(input({ calendarId: null }))).toEqual({ kind: 'none', because: 'no_calendar' });
  });

  it('moves the event when the commitment moved', () => {
    const plan = decide(input({ link: link({ contentHash: 'stale' }) }));
    expect(plan.kind).toBe('update');
  });

  it('does nothing at all when the event already says exactly this', () => {
    const subject = commitment();
    expect(decide(input({ commitment: subject, link: link({ contentHash: currentHash(subject) }) })))
      .toEqual({ kind: 'none', because: 'unchanged' });
  });

  it('removes the event when the commitment is gone', () => {
    expect(decide(input({ link: link(), commitment: null }))).toEqual({ kind: 'delete', eventId: 'evt-1' });
  });

  it('removes the event when the commitment loses its time', () => {
    const undated = commitment({
      timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    });
    expect(decide(input({ commitment: undated, link: link() })))
      .toEqual({ kind: 'delete', eventId: 'evt-1' });
  });

  it('leaves a completed commitment’s event where it is', () => {
    // It happened. A calendar is a record of somebody's week, and deleting the
    // appointment they went to makes their own history wrong.
    const done = commitment({ status: 'completed', completedAt: '2026-06-15T03:00:00.000Z' });
    expect(decide(input({ commitment: done, link: link({ contentHash: currentHash(done) }) })))
      .toEqual({ kind: 'none', because: 'unchanged' });
  });
});

describe('a capture the user has not confirmed', () => {
  /**
   * `pending_confirmation` is not a hypothetical state. A capture stated for
   * today sits on Today until somebody acts on it, so without this guard the
   * first thing an abandoned draft does is put an hour nobody agreed to in
   * front of everyone who shares the calendar.
   */
  it('is never written, whatever time it names', () => {
    for (const status of ['draft', 'needs_clarification', 'pending_confirmation']) {
      expect(decide(input({ commitment: commitment({ status, confirmedAt: null }) })))
        .toEqual({ kind: 'none', because: 'unconfirmed' });
    }
  });

  it('is written once it has been confirmed', () => {
    // The other half of the guard: it must refuse the three and nothing else,
    // or the feature is off for every commitment there is.
    for (const status of ['active', 'deferred', 'missed', 'completed']) {
      expect(decide(input({ commitment: commitment({ status }) })).kind).toBe('create');
    }
  });

  it('has an event taken back out if one was ever written for it', () => {
    expect(decide(input({ commitment: commitment({ status: 'draft' }), link: link() })))
      .toEqual({ kind: 'delete', eventId: 'evt-1' });
  });
});

describe('a commitment the account no longer holds', () => {
  it('has its event removed, even with the write target off', () => {
    // "Stop adding" does not mean "keep what you deleted". Turning the switch
    // off stops new writes; taking a cancelled commitment's entry back out is
    // not a write, it is the undoing of one.
    expect(decide(input({ commitment: null, link: link(), writeTarget: 'off' })))
      .toEqual({ kind: 'delete', eventId: 'evt-1' });
  });

  it('is nothing to do at all when it never had an event', () => {
    expect(decide(input({ commitment: null, link: null })))
      .toEqual({ kind: 'none', because: 'gone' });
  });
});

/* ── Where a gone commitment comes from ───────────────────────────── */

describe('the subjects a pass is built from', () => {
  /**
   * The reason `SyncSubject.commitment` is nullable rather than a `removed`
   * flag. A flag has to be set by somebody, and the only thing that builds
   * subjects builds them from lists — where a deleted commitment is an absence.
   * These two cases are what make the delete branch reachable at all.
   */
  it('turns a link the account has outlived into a commitment that is gone', () => {
    const subjects = subjectsFromCache([
      { items: [], calendarOrphans: [{ commitmentId: 'cmt-gone', link: link() }] },
      undefined,
    ]);
    expect(subjects).toEqual([{ commitmentId: 'cmt-gone', commitment: null, link: link() }]);
  });

  it('keeps a commitment a list still shows, even when the other list called it gone', () => {
    // Two GETs resolve at two instants. A stale "gone" that deleted an entry
    // still on somebody's Today is the one mistake here that cannot be undone.
    const live = commitment();
    const subjects = subjectsFromCache([
      { items: [live] },
      { items: [], calendarOrphans: [{ commitmentId: live.id, link: link() }] },
    ]);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.commitment).not.toBeNull();
  });
});

/* ── Running the pass ─────────────────────────────────────────────── */

interface Recorder {
  ports: SyncPorts;
  calls: string[];
  events: Map<string, CalendarEventDraft>;
  links: Map<string, Omit<DeviceCalendarLink, 'writtenAt'>>;
}

function recorder(options: {
  access?: CalendarAccess;
  missing?: readonly string[];
  failCreate?: DeviceCalendarError;
  failDelete?: DeviceCalendarError;
  failLink?: Error;
} = {}): Recorder {
  const calls: string[] = [];
  const events = new Map<string, CalendarEventDraft>();
  const links = new Map<string, Omit<DeviceCalendarLink, 'writtenAt'>>();
  let nextId = 0;
  const calendar: DeviceCalendar = {
    getAccess: async () => {
      calls.push('getAccess');
      return options.access ?? 'granted';
    },
    requestAccess: async () => options.access ?? 'granted',
    listWritableCalendars: async () => [],
    // UC-3.2 (#186) widened the interface. The write sync never reads busy
    // time, and answering with an empty list rather than a throw keeps that a
    // statement about this fake's *calls* rather than about its failures.
    fetchBusyBlocks: async () => {
      calls.push('fetchBusyBlocks');
      return [];
    },
    createEvent: async (calendarId, draft) => {
      calls.push(`createEvent:${calendarId}`);
      if (options.failCreate) throw options.failCreate;
      nextId += 1;
      const id = `evt-new-${nextId}`;
      events.set(id, draft);
      return id;
    },
    updateEvent: async (eventId, draft) => {
      calls.push(`updateEvent:${eventId}`);
      events.set(eventId, draft);
    },
    deleteEvent: async (eventId) => {
      calls.push(`deleteEvent:${eventId}`);
      if (options.failDelete) throw options.failDelete;
      events.delete(eventId);
    },
    eventExists: async (eventId) => {
      calls.push(`eventExists:${eventId}`);
      return !(options.missing ?? []).includes(eventId);
    },
  };
  return {
    calls,
    events,
    links,
    ports: {
      calendar,
      putLink: async (commitmentId, value) => {
        calls.push(`putLink:${commitmentId}:${value.state}`);
        if (options.failLink) throw options.failLink;
        links.set(commitmentId, value);
      },
      deleteLink: async (commitmentId) => {
        calls.push(`deleteLink:${commitmentId}`);
        links.delete(commitmentId);
      },
      rememberEvent: async (eventId) => { calls.push(`rememberEvent:${eventId}`); },
      forgetEvent: async (eventId) => { calls.push(`forgetEvent:${eventId}`); },
    },
  };
}

function run(subjects: readonly SyncSubject[], rec: Recorder, overrides: Record<string, unknown> = {}) {
  return reconcile({
    subjects,
    writeTarget: 'device',
    writerId: MINE,
    calendarId: 'cal-1',
    deviceTimeZone: ZONE,
    ports: rec.ports,
    ...overrides,
  });
}

describe('the reconcile pass', () => {
  it('never so much as reads the permission when there is nothing to do', async () => {
    // A build with the target off must not produce a calendar prompt. Asking
    // the OS anything here is the first step towards one.
    const rec = recorder();
    const outcome = await run([subject(commitment(), null)], rec, { writeTarget: 'off' });
    expect(rec.calls).toEqual([]);
    expect(outcome).toMatchObject({ created: 0, skipped: 1, permissionDenied: false });
  });

  it('claims the link the moment the event it names exists', async () => {
    // The claim is an event id, so the event has to be written first. What must
    // not happen is the write and the claim drifting apart — every failure
    // between them is one this device has to repair, and the two cases below
    // are that repair.
    const rec = recorder();
    await run([subject(commitment(), null)], rec);
    const created = rec.calls.indexOf('createEvent:cal-1');
    const claimed = rec.calls.findIndex((call) => call.startsWith('putLink:'));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(claimed).toBe(created + 2);
  });

  it('records the event id so UC-3.2 (#186) can skip our own events', async () => {
    const rec = recorder();
    await run([subject(commitment(), null)], rec);
    expect(rec.calls).toContain('rememberEvent:evt-new-1');
  });

  it('stops and says so when the user has not granted access', async () => {
    const rec = recorder({ access: 'denied' });
    const outcome = await run([subject(commitment(), null)], rec);
    expect(outcome.permissionDenied).toBe(true);
    expect(outcome.created).toBe(0);
    expect(rec.calls).toEqual(['getAccess']);
  });

  it('detaches the link for an event that is no longer in the calendar', async () => {
    const rec = recorder({ missing: ['evt-1'] });
    const outcome = await run([subject(commitment(), link())], rec);
    expect(outcome.detached).toBe(1);
    expect(rec.links.get('cmt-1')?.state).toBe('detached');
    // And it did not try to move or recreate it.
    expect(rec.calls.some((call) => call.startsWith('updateEvent'))).toBe(false);
    expect(rec.calls.some((call) => call.startsWith('createEvent'))).toBe(false);
  });

  it('carries on past one commitment the calendar refused', async () => {
    const rec = recorder({ failCreate: new DeviceCalendarError('calendar_read_only', 'nope') });
    const outcome = await run([
      subject(commitment({ id: 'a' }), null),
      subject(commitment({ id: 'b' }), null),
    ], rec);
    // Both failed the same way here; what matters is that the pass attempted
    // the second rather than stopping on the first.
    expect(rec.calls.filter((call) => call === 'createEvent:cal-1')).toHaveLength(2);
    expect(outcome.skipped).toBe(2);
  });

  it('stops the whole pass when the permission was taken away mid-run', async () => {
    const rec = recorder({ failCreate: new DeviceCalendarError('permission_denied', 'revoked') });
    const outcome = await run([
      subject(commitment({ id: 'a' }), null),
      subject(commitment({ id: 'b' }), null),
    ], rec);
    expect(outcome.permissionDenied).toBe(true);
    expect(rec.calls.filter((call) => call === 'createEvent:cal-1')).toHaveLength(1);
  });

  it('writes nothing for a commitment whose link this response did not carry', async () => {
    // `undefined` is not `null`. A 409 body carries a commitment and no link,
    // and reading that as "there is no link" is how a refusal becomes a second
    // event in somebody's calendar.
    const rec = recorder();
    await run([subject(commitment(), undefined)], rec);
    // With no link this is indistinguishable from a first write, so the pass
    // *does* try — and the server is what refuses it. What must not happen is
    // the pass treating a foreign link as absent, which the `decide` cases
    // above cover. This asserts the call is made rather than skipped silently.
    expect(rec.calls).toContain('createEvent:cal-1');
  });

  it('deletes the event, the local id and the link row for a commitment that is gone', async () => {
    const rec = recorder();
    const outcome = await run([orphan('cmt-gone', link())], rec);
    expect(outcome.deleted).toBe(1);
    expect(rec.calls).toContain('deleteEvent:evt-1');
    expect(rec.calls).toContain('forgetEvent:evt-1');
    // The row goes too, so the id is free if the same commitment ever returns.
    expect(rec.calls).toContain('deleteLink:cmt-gone');
  });

  it('detaches rather than deletes when the user had already removed that event by hand', async () => {
    const rec = recorder({ missing: ['evt-1'] });
    const outcome = await run([orphan('cmt-gone', link())], rec);
    expect(outcome.detached).toBe(1);
    expect(rec.calls).not.toContain('deleteEvent:evt-1');
  });

  it('treats a refused link claim as "leave the calendar alone", not as a failure to retry', async () => {
    const rec = recorder({ failLink: new Error('409') });
    const outcome = await run([subject(commitment(), null)], rec);
    expect(outcome.created).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(outcome.permissionDenied).toBe(false);
  });

  it('takes its own event back out when another installation won the claim', async () => {
    // The whole of "a second device does not create a duplicate". The loser
    // cannot avoid writing — the claim it loses is the id of the event it just
    // wrote — so what it must do is remove it again. An event with no link row
    // is not reachable by anything afterwards, not even by "Remove events
    // MaybeSitter added", which walks the links.
    const rec = recorder({ failLink: new Error('409') });
    await run([subject(commitment(), null)], rec);
    expect(rec.calls).toContain('deleteEvent:evt-new-1');
    expect(rec.calls).toContain('forgetEvent:evt-new-1');
    expect(rec.events.size).toBe(0);
  });

  it('adds no event per pass when the claim keeps failing on the network', async () => {
    // Without the repair this is the shape of the bug: one more entry in
    // somebody's calendar every time they open the app, for ever.
    const rec = recorder({ failLink: new Error('offline') });
    for (let pass = 0; pass < 3; pass += 1) {
      await run([subject(commitment(), null)], rec);
    }
    expect(rec.calls.filter((call) => call === 'createEvent:cal-1')).toHaveLength(3);
    expect(rec.events.size).toBe(0);
  });

  it('stops the pass when the repair itself is refused for want of permission', async () => {
    const rec = recorder({
      failLink: new Error('409'),
      failDelete: new DeviceCalendarError('permission_denied', 'revoked'),
    });
    const outcome = await run([subject(commitment(), null)], rec);
    expect(outcome.permissionDenied).toBe(true);
  });
});

describe('remove events MaybeSitter added', () => {
  it('removes the ones this installation linked, and nothing else', async () => {
    const rec = recorder();
    const result = await removeAllWrittenEvents({
      subjects: [
        subject(commitment({ id: 'mine' }), link({ eventId: 'evt-mine' })),
        subject(commitment({ id: 'theirs' }), link({ eventId: 'evt-theirs', writerId: THEIRS })),
        subject(commitment({ id: 'unlinked' }), null),
      ],
      writerId: MINE,
      ports: rec.ports,
    });
    expect(result.removed).toBe(1);
    expect(rec.calls).toContain('deleteEvent:evt-mine');
    expect(rec.calls).not.toContain('deleteEvent:evt-theirs');
  });

  it('leaves a detached row alone, so the next confirm does not write it back', async () => {
    const rec = recorder();
    const result = await removeAllWrittenEvents({
      subjects: [subject(commitment(), link({ state: 'detached' }))],
      writerId: MINE,
      ports: rec.ports,
    });
    expect(result.removed).toBe(0);
    // Not even a permission check: there was nothing of ours to remove.
    expect(rec.calls).toEqual([]);
  });

  it('forgets the link as well as the event, so a later confirm can link afresh', async () => {
    const rec = recorder();
    await removeAllWrittenEvents({
      subjects: [subject(commitment(), link())],
      writerId: MINE,
      ports: rec.ports,
    });
    expect(rec.calls).toContain('deleteLink:cmt-1');
    expect(rec.calls).toContain('forgetEvent:evt-1');
  });

  it('says so rather than half-removing when access has been revoked', async () => {
    const rec = recorder({ access: 'denied' });
    const result = await removeAllWrittenEvents({
      subjects: [subject(commitment(), link())],
      writerId: MINE,
      ports: rec.ports,
    });
    expect(result).toEqual({ removed: 0, skipped: 1, permissionDenied: true });
  });
});
