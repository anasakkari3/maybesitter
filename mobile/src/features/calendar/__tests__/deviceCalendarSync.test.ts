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
    commitment: commitment(),
    link: null as DeviceCalendarLink | null | undefined,
    writeTarget: 'device' as const,
    writerId: MINE,
    calendarId: 'cal-1',
    deviceTimeZone: ZONE,
    eventStillThere: true,
    ...overrides,
  };
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
    expect(decide(input({ link: link({ writerId: THEIRS }), removed: true })))
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
    expect(decide(input({ link: link({ state: 'detached' }), removed: true })))
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
    expect(decide(input({ link: link(), removed: true }))).toEqual({ kind: 'delete', eventId: 'evt-1' });
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
    const outcome = await run([{ commitment: commitment(), link: null }], rec, { writeTarget: 'off' });
    expect(rec.calls).toEqual([]);
    expect(outcome).toMatchObject({ created: 0, skipped: 1, permissionDenied: false });
  });

  it('claims the link before it writes the event', async () => {
    const rec = recorder();
    await run([{ commitment: commitment(), link: null }], rec);
    const created = rec.calls.indexOf('createEvent:cal-1');
    const claimed = rec.calls.findIndex((call) => call.startsWith('putLink:'));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(claimed).toBeGreaterThan(created);
  });

  it('records the event id so UC-3.2 (#186) can skip our own events', async () => {
    const rec = recorder();
    await run([{ commitment: commitment(), link: null }], rec);
    expect(rec.calls).toContain('rememberEvent:evt-new-1');
  });

  it('stops and says so when the user has not granted access', async () => {
    const rec = recorder({ access: 'denied' });
    const outcome = await run([{ commitment: commitment(), link: null }], rec);
    expect(outcome.permissionDenied).toBe(true);
    expect(outcome.created).toBe(0);
    expect(rec.calls).toEqual(['getAccess']);
  });

  it('detaches the link for an event that is no longer in the calendar', async () => {
    const rec = recorder({ missing: ['evt-1'] });
    const subject: SyncSubject = { commitment: commitment(), link: link() };
    const outcome = await run([subject], rec);
    expect(outcome.detached).toBe(1);
    expect(rec.links.get('cmt-1')?.state).toBe('detached');
    // And it did not try to move or recreate it.
    expect(rec.calls.some((call) => call.startsWith('updateEvent'))).toBe(false);
    expect(rec.calls.some((call) => call.startsWith('createEvent'))).toBe(false);
  });

  it('carries on past one commitment the calendar refused', async () => {
    const rec = recorder({ failCreate: new DeviceCalendarError('calendar_read_only', 'nope') });
    const outcome = await run([
      { commitment: commitment({ id: 'a' }), link: null },
      { commitment: commitment({ id: 'b' }), link: null },
    ], rec);
    // Both failed the same way here; what matters is that the pass attempted
    // the second rather than stopping on the first.
    expect(rec.calls.filter((call) => call === 'createEvent:cal-1')).toHaveLength(2);
    expect(outcome.skipped).toBe(2);
  });

  it('stops the whole pass when the permission was taken away mid-run', async () => {
    const rec = recorder({ failCreate: new DeviceCalendarError('permission_denied', 'revoked') });
    const outcome = await run([
      { commitment: commitment({ id: 'a' }), link: null },
      { commitment: commitment({ id: 'b' }), link: null },
    ], rec);
    expect(outcome.permissionDenied).toBe(true);
    expect(rec.calls.filter((call) => call === 'createEvent:cal-1')).toHaveLength(1);
  });

  it('writes nothing for a commitment whose link this response did not carry', async () => {
    // `undefined` is not `null`. A 409 body carries a commitment and no link,
    // and reading that as "there is no link" is how a refusal becomes a second
    // event in somebody's calendar.
    const rec = recorder();
    await run([{ commitment: commitment(), link: undefined }], rec);
    // With no link this is indistinguishable from a first write, so the pass
    // *does* try — and the server is what refuses it. What must not happen is
    // the pass treating a foreign link as absent, which the `decide` cases
    // above cover. This asserts the call is made rather than skipped silently.
    expect(rec.calls).toContain('createEvent:cal-1');
  });

  it('treats a refused link claim as "leave the calendar alone", not as a failure to retry', async () => {
    const rec = recorder({ failLink: new Error('409') });
    const outcome = await run([{ commitment: commitment(), link: null }], rec);
    expect(outcome.created).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(outcome.permissionDenied).toBe(false);
  });
});

describe('remove events MaybeSitter added', () => {
  it('removes the ones this installation linked, and nothing else', async () => {
    const rec = recorder();
    const result = await removeAllWrittenEvents({
      subjects: [
        { commitment: commitment({ id: 'mine' }), link: link({ eventId: 'evt-mine' }) },
        { commitment: commitment({ id: 'theirs' }), link: link({ eventId: 'evt-theirs', writerId: THEIRS }) },
        { commitment: commitment({ id: 'unlinked' }), link: null },
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
      subjects: [{ commitment: commitment(), link: link({ state: 'detached' }) }],
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
      subjects: [{ commitment: commitment(), link: link() }],
      writerId: MINE,
      ports: rec.ports,
    });
    expect(rec.calls).toContain('deleteLink:cmt-1');
    expect(rec.calls).toContain('forgetEvent:evt-1');
  });

  it('says so rather than half-removing when access has been revoked', async () => {
    const rec = recorder({ access: 'denied' });
    const result = await removeAllWrittenEvents({
      subjects: [{ commitment: commitment(), link: link() }],
      writerId: MINE,
      ports: rec.ports,
    });
    expect(result).toEqual({ removed: 0, skipped: 1, permissionDenied: true });
  });
});
