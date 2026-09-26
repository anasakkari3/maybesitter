/**
 * Place reminders — the rules (closure CL4).
 *
 * The region task runs with no React tree, so every rule it follows is a pure
 * function over the armed store and is tested here against fakes: which
 * commitments are watched, which regions the OS is given, and what one region
 * event does — record the first look, fire on a crossing in the reminder's own
 * direction, fire once, and wait for the end of quiet hours.
 */
import { describe, expect, it } from '@jest/globals';
import type { Commitment } from '../../../api/schemas/common';
import type { ArmedReminder, ArmedStore, Place } from '../../../lib/deviceSettings/placeReminders';
import {
  GEOFENCE_ENTER,
  GEOFENCE_EXIT,
  MAX_REGIONS,
  REGION_RADIUS_M,
  desiredArmed,
  emptyArmed,
  handleGeofenceEvent,
  placeReminderBody,
  regionIdentifier,
  regionsFor,
  type GeofenceDeps,
  type PlaceNotification,
} from '../placeReminderEngine';
import { endOfQuietWindow } from '../../reminders/quietHours';

const HOME: Place = { id: 'place_home', kind: 'home', label: 'Home', latitude: 32.0853, longitude: 34.7818, updatedAt: '2026-09-20T08:00:00.000Z' };
const GYM: Place = { id: 'place_gym1', kind: 'custom', label: 'Gym', latitude: 32.1, longitude: 34.8, updatedAt: '2026-09-20T08:00:00.000Z' };
const COPY = { arrive: (place: string) => `Arrived: ${place}`, leave: (place: string) => `Left: ${place}` };

function commitment(id: string, extra: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title: `Title ${id}`, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-20T08:00:00.000Z', updatedAt: '2026-09-20T08:00:00.000Z',
    confirmedAt: '2026-09-20T08:00:00.000Z', completedAt: null, droppedAt: null,
    ...extra,
  } as Commitment;
}

const arriveHome = { kind: 'arrive' as const, placeId: HOME.id, label: 'Home' };

describe('what this phone watches', () => {
  it('a live commitment whose trigger names a place saved here, with its title and the line for its direction', () => {
    const armed = desiredArmed([commitment('c1', { locationTrigger: arriveHome })], [HOME], [], COPY);
    expect(armed).toEqual([{
      commitmentId: 'c1', kind: 'arrive', placeId: HOME.id, key: `arrive:${HOME.id}:${HOME.updatedAt}`,
      title: 'Title c1', body: 'Arrived: Home', side: null, firedAt: null,
    }]);
  });

  it('not a finished, dropped or unconfirmed one, not one with no trigger, and not a place saved on another phone', () => {
    const armed = desiredArmed([
      commitment('done', { status: 'completed', locationTrigger: arriveHome }),
      commitment('dropped', { status: 'dropped', locationTrigger: arriveHome }),
      commitment('pending', { status: 'pending_confirmation', locationTrigger: arriveHome }),
      commitment('none'),
      commitment('elsewhere', { locationTrigger: { kind: 'leave', placeId: 'place_other', label: 'Office' } }),
    ], [HOME], [], COPY);
    expect(armed).toEqual([]);
  });

  it('keeps the side and the fired mark while nothing about the reminder changed', () => {
    const previous: ArmedReminder = { ...desiredArmed([commitment('c1', { locationTrigger: arriveHome })], [HOME], [], COPY)[0]!, side: 'outside', firedAt: '2026-09-20T09:00:00.000Z' };
    const again = desiredArmed([commitment('c1', { title: 'Renamed', locationTrigger: arriveHome })], [HOME], [previous], COPY);
    expect(again[0]).toMatchObject({ side: 'outside', firedAt: '2026-09-20T09:00:00.000Z', title: 'Renamed' });
  });

  it('starts fresh when the direction changes or the pin moves', () => {
    const previous: ArmedReminder = { ...desiredArmed([commitment('c1', { locationTrigger: arriveHome })], [HOME], [], COPY)[0]!, side: 'inside', firedAt: '2026-09-20T09:00:00.000Z' };
    const leaving = desiredArmed([commitment('c1', { locationTrigger: { ...arriveHome, kind: 'leave' } })], [HOME], [previous], COPY);
    expect(leaving[0]).toMatchObject({ side: null, firedAt: null, body: 'Left: Home' });
    const moved = desiredArmed([commitment('c1', { locationTrigger: arriveHome })], [{ ...HOME, updatedAt: '2026-09-21T08:00:00.000Z' }], [previous], COPY);
    expect(moved[0]).toMatchObject({ side: null, firedAt: null });
  });
});

describe('the regions the OS is given', () => {
  it('one per unfired reminder, 150 m, both edges, never a fired one', () => {
    const armed = desiredArmed([
      commitment('c1', { locationTrigger: arriveHome }),
      commitment('c2', { locationTrigger: { kind: 'leave', placeId: GYM.id, label: 'Gym' } }),
    ], [HOME, GYM], [], COPY);
    const fired = armed.map((entry, index) => (index === 1 ? { ...entry, firedAt: '2026-09-20T09:00:00.000Z' } : entry));
    expect(regionsFor(fired, [HOME, GYM])).toEqual([{
      identifier: regionIdentifier('c1'), latitude: HOME.latitude, longitude: HOME.longitude,
      radius: REGION_RADIUS_M, notifyOnEnter: true, notifyOnExit: true,
    }]);
    expect(REGION_RADIUS_M).toBe(150);
  });

  it('stops at the iOS limit', () => {
    const many = Array.from({ length: 30 }, (_, index) => commitment(`c${index}`, { locationTrigger: arriveHome }));
    expect(regionsFor(desiredArmed(many, [HOME], [], COPY), [HOME])).toHaveLength(MAX_REGIONS);
  });
});

function fakeStore(entries: ArmedReminder[], extra: Partial<ArmedStore> = {}) {
  let store: ArmedStore = { ...emptyArmed('u1'), entries, ...extra };
  const sent: PlaceNotification[] = [];
  const deps: GeofenceDeps = {
    load: async () => store,
    save: async next => { store = next; },
    notify: async notification => { sent.push(notification); },
    now: () => new Date('2026-09-20T12:00:00.000Z'),
  };
  return { deps, sent, current: () => store };
}

const event = (commitmentId: string, eventType: number) => ({ data: { eventType, region: { identifier: regionIdentifier(commitmentId), latitude: 1, longitude: 2 } }, error: null });

function armedFor(kind: 'arrive' | 'leave'): ArmedReminder {
  return desiredArmed([commitment('c1', { locationTrigger: { ...arriveHome, kind } })], [HOME], [], COPY)[0]!;
}

describe('one region event', () => {
  it('the first look only records the side — saving "arrive home" while at home does not ring', async () => {
    const { deps, sent, current } = fakeStore([armedFor('arrive')]);
    expect(await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps)).toBe('recorded');
    expect(sent).toEqual([]);
    expect(current().entries[0]).toMatchObject({ side: 'inside', firedAt: null });
  });

  it('arriving after being outside posts the commitment title, the line, and opens that commitment', async () => {
    const { deps, sent, current } = fakeStore([armedFor('arrive')]);
    await handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps);
    expect(await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps)).toBe('fired');
    expect(sent).toEqual([{ identifier: regionIdentifier('c1'), title: 'Title c1', body: 'Arrived: Home', commitmentId: 'c1', at: null }]);
    expect(current().entries[0]!.firedAt).toBe('2026-09-20T12:00:00.000Z');
  });

  it('fires once: leaving and arriving again says nothing more', async () => {
    const { deps, sent } = fakeStore([armedFor('arrive')]);
    await handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps);
    await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps);
    await handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps);
    expect(await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps)).toBe('ignored');
    expect(sent).toHaveLength(1);
  });

  it('a leave reminder fires on leaving, not on arriving', async () => {
    const { deps, sent } = fakeStore([armedFor('leave')]);
    await handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps);
    expect(await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps)).toBe('ignored');
    expect(sent).toEqual([]);
    expect(await handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps)).toBe('fired');
    expect(sent[0]).toMatchObject({ body: 'Left: Home' });
  });

  it('a repeat of the same side is not a crossing', async () => {
    const { deps, sent } = fakeStore([armedFor('arrive')]);
    await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps);
    expect(await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps)).toBe('ignored');
    expect(sent).toEqual([]);
  });

  it('inside quiet hours it waits for their end instead of ringing now', async () => {
    const quiet = { start: '11:00', end: '14:00' };
    const { deps, sent } = fakeStore([armedFor('arrive')], { quiet, timeZone: 'UTC' });
    await handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps);
    await handleGeofenceEvent(event('c1', GEOFENCE_ENTER), deps);
    const end = endOfQuietWindow(quiet, Date.parse('2026-09-20T12:00:00.000Z'), 'UTC');
    expect(sent[0]!.at?.getTime()).toBe(end);
  });

  it('ignores what it cannot read: an error, an unknown region, another app\'s identifier', async () => {
    const { deps, sent } = fakeStore([armedFor('arrive')]);
    expect(await handleGeofenceEvent({ data: null, error: new Error('x') }, deps)).toBe('ignored');
    expect(await handleGeofenceEvent(event('someone-else', GEOFENCE_ENTER), deps)).toBe('ignored');
    expect(await handleGeofenceEvent({ data: { eventType: GEOFENCE_ENTER, region: { identifier: 'c1' } } }, deps)).toBe('ignored');
    expect(await handleGeofenceEvent(undefined, deps)).toBe('ignored');
    expect(sent).toEqual([]);
  });

  it('several events at once are applied one after another, so none is lost', async () => {
    const two = [armedFor('arrive'), { ...armedFor('leave'), commitmentId: 'c2' }];
    const { deps, current } = fakeStore(two);
    await Promise.all([
      handleGeofenceEvent(event('c1', GEOFENCE_EXIT), deps),
      handleGeofenceEvent(event('c2', GEOFENCE_ENTER), deps),
    ]);
    expect(current().entries.map(entry => entry.side)).toEqual(['outside', 'inside']);
  });
});

describe('the request body', () => {
  it('carries the three fields by name — a place\'s pin cannot ride along', () => {
    const body = placeReminderBody('arrive', HOME);
    expect(body).toEqual({ kind: 'arrive', placeId: 'place_home', label: 'Home' });
    expect(JSON.stringify(body)).not.toMatch(/lat|lng|lon|coord|radius/i);
  });
});
