/**
 * M4b Gate B, shared harness (PLAN-M4b after six review rounds, not formally
 * approved — the owner chose to build on it; WIRE-M4b binding on shape).
 * Gate author: Claude, written before Task B's build. Every test must fail on
 * 971bd421 for the reason its criterion names, except the parity guards, which
 * pin today's behaviour and pass on 971bd421 by design (named "parity" in the
 * test title).
 *
 * Capture tests reuse the M4a/M2b harness (real routes in-process, fake auth,
 * memory storage, the rules path). The process clock is pinned to REFERENCE
 * (Wednesday 2026-10-07 10:00 Jerusalem). The three M4b capabilities are on
 * here unless a test says otherwise; free slots (M4a) too, since R2 and R3
 * build on its finder.
 *
 * Copy belongs to the builders: only statuses, error codes, ids, shapes,
 * instants and what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { seedLiveAccount } from '../../support/liveAccount.ts';
import { applyParticipantCommands, readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import { replaceBusyBlocks } from '../../../lib/calendar/busyBlocks.ts';
import { createWeeklyBlock } from '../../../lib/weeklyBlocks/weeklyBlockService.ts';
import { PERSONALIZATION_CONSENT_VERSION, setPersonalizationConsent } from '../../../lib/consents/personalizationConsentService.ts';
import { upsertFixtures } from '../../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../../lib/football/followedClubs.ts';
import { projectFixturesForUser } from '../../../lib/football/projectFixtures.ts';
import { getRef } from '../../../lib/football/externalTaskRefStore.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION, type Fixture, type FixtureCore } from '../../../src/contracts/v1/fixtureContracts.ts';
import {
  REFERENCE,
  TZ,
  TODAY,
  TOMORROW,
  at,
  begin as beginM4a,
  call,
  confirmRaw,
  end as endM4a,
  savedCommitments,
  say,
  show,
  currentStorage,
  type Raw,
} from '../m4a/support.ts';

export { REFERENCE, TZ, TODAY, TOMORROW, at, call, savedCommitments, say, show, currentStorage };
export type { Raw };

/** A fixed test key for the slot HMAC (WIRE: never a real key in tests or fixtures). */
export const TEST_SLOT_KEY = 'm4b-gate-test-key-0123456789abcdef0123456789abcdef';

const ENV_KEYS = [
  'MAYBESITTER_FEATURE_EXTERNAL_CLASH_HOLD',
  'MAYBESITTER_KILL_SWITCH_EXTERNAL_CLASH_HOLD',
  'MAYBESITTER_FEATURE_EVENING_IMPACT',
  'MAYBESITTER_KILL_SWITCH_EVENING_IMPACT',
  'MAYBESITTER_FEATURE_SMART_POSTPONE',
  'MAYBESITTER_KILL_SWITCH_SMART_POSTPONE',
  'MAYBESITTER_POSTPONE_SLOT_HMAC_KEY',
] as const;
let saved: Record<string, string | undefined> | null = null;

export interface M4bSwitches {
  hold?: boolean;
  holdKilled?: boolean;
  impact?: boolean;
  impactKilled?: boolean;
  postpone?: boolean;
  postponeKilled?: boolean;
  /** The slot HMAC key; `null` removes it. Default TEST_SLOT_KEY. */
  slotKey?: string | null;
  /** MAYBESITTER_ENV (default 'test'). */
  environment?: string;
}

export function setM4bSwitches(switches: M4bSwitches = {}): void {
  if (saved === null) saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const flag = (value: boolean | undefined, fallback: boolean) => ((value ?? fallback) ? 'true' : 'false');
  process.env.MAYBESITTER_FEATURE_EXTERNAL_CLASH_HOLD = flag(switches.hold, true);
  process.env.MAYBESITTER_KILL_SWITCH_EXTERNAL_CLASH_HOLD = flag(switches.holdKilled, false);
  process.env.MAYBESITTER_FEATURE_EVENING_IMPACT = flag(switches.impact, true);
  process.env.MAYBESITTER_KILL_SWITCH_EVENING_IMPACT = flag(switches.impactKilled, false);
  process.env.MAYBESITTER_FEATURE_SMART_POSTPONE = flag(switches.postpone, true);
  process.env.MAYBESITTER_KILL_SWITCH_SMART_POSTPONE = flag(switches.postponeKilled, false);
  if (switches.slotKey === null) delete process.env.MAYBESITTER_POSTPONE_SLOT_HMAC_KEY;
  else process.env.MAYBESITTER_POSTPONE_SLOT_HMAC_KEY = switches.slotKey ?? TEST_SLOT_KEY;
  if (switches.environment) process.env.MAYBESITTER_ENV = switches.environment;
}

/** The rules path, clock pinned to REFERENCE, M4a free slots on, M4b switches set. */
export function begin(switches: M4bSwitches = {}): string {
  const uid = beginM4a({ freeSlots: true, environment: switches.environment ?? 'test' });
  setM4bSwitches(switches);
  return uid;
}

export function end(): void {
  if (saved) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved = null;
  }
  endM4a();
}

export const NOW = () => new Date().toISOString();

/** The ordinary capture confirm, for the given items of a proposal body. */
export function confirmProposal(uid: string, proposal: any, itemIds: string[], idempotencyKey: string): Promise<Raw> {
  return confirmRaw(uid, { proposalId: proposal.proposalId, itemIds, revision: proposal.revision ?? 0, idempotencyKey });
}

export function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function localDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function localTimeOf(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export type Interval = { startsAt: string; endsAt: string };

export function overlaps(a: Interval, b: Interval): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

/* ── occupancy writers (the real writers, never invented rows) ───────── */

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

/** A confirmed commitment with an arbitrary `timeSpec` (the domain's own commands). */
export async function addCommitment(uid: string, title: string, timeSpec: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const id = nextId('0c0ffee5');
  const now = NOW();
  await seedLiveAccount(uid); // #772: the user document a live account has before its first domain write
  await applyParticipantCommands(uid, [
    { type: 'CreateDraft', now, commitment: { id, kind: 'task', title, timeSpec: { timezone: TZ, ...timeSpec }, ...extra } } as any,
    { type: 'ConfirmCommitment', commitmentId: id, now } as any,
  ]);
  return id;
}

/** A scheduled event; `endsAt` omitted → an end-less event (30-minute fallback). */
export function addEvent(uid: string, title: string, startsAt: string, endsAt?: string, extra: Record<string, unknown> = {}): Promise<string> {
  return addCommitment(uid, title, { kind: 'scheduled_event', dueAt: startsAt, ...(endsAt ? { endAt: endsAt } : {}), allDay: false }, extra);
}

/** A timed deadline (a `due_by` with a clock time, no end). */
export function addTimedDeadline(uid: string, title: string, dueAt: string): Promise<string> {
  return addCommitment(uid, title, { kind: 'due_by', dueAt, allDay: false });
}

/** An all-day scheduled event on a local date. */
export function addAllDayEvent(uid: string, title: string, localDate: string): Promise<string> {
  const startsAt = at(localDate, '00:00');
  const next = new Date(Date.parse(at(localDate, '12:00')) + 24 * 3_600_000);
  const nextDate = localDateOf(next.toISOString());
  return addCommitment(uid, title, { kind: 'scheduled_event', dueAt: startsAt, endAt: at(nextDate, '00:00'), allDay: true });
}

export async function postponeLegacy(uid: string, commitmentId: string, until: string): Promise<void> {
  await applyParticipantCommands(uid, [{ type: 'Postpone', commitmentId, postponedUntil: until, now: NOW() } as any]);
}

export async function dropCommitment(uid: string, commitmentId: string): Promise<void> {
  await applyParticipantCommands(uid, [{ type: 'Drop', commitmentId, now: NOW() } as any]);
}

export async function moveCommitment(uid: string, commitmentId: string, startsAt: string, endsAt?: string): Promise<void> {
  await applyParticipantCommands(uid, [{ type: 'UpdateCommitment', commitmentId, now: NOW(),
    updates: { timeSpec: { dueAt: startsAt, ...(endsAt ? { endAt: endsAt } : {}) } } } as any]);
}

export async function commitment(uid: string, id: string): Promise<any> {
  const state = await readParticipantState(uid);
  return (state.commitments as Record<string, any>)[id];
}

export async function allCommitments(uid: string): Promise<any[]> {
  const state = await readParticipantState(uid);
  return Object.values(state.commitments as Record<string, any>);
}

/**
 * Device busy time through the real writer, with an honest coverage window
 * (default: today → three weeks), so the source is connected and covering.
 */
export async function addDeviceBusy(uid: string, blocks: Interval[], window?: Interval, sourceId = 'device:gate-m4b'): Promise<void> {
  const coverage = window ?? { startsAt: at(TODAY, '00:00'), endsAt: at('2026-10-28', '00:00') };
  await replaceBusyBlocks(uid, sourceId, coverage,
    blocks.map((block, index) => ({ blockId: `${sourceId}-${index}`, sourceId, sourceKind: 'device', startAt: block.startsAt, endAt: block.endsAt, allDay: false }) as any),
    { platform: 'ios', now: new Date() } as any);
}

/** A weekly block through the real writer (weekday 0 = Sunday). */
export async function addWeekly(uid: string, title: string, weekdays: number[], start: string, endTime: string): Promise<string> {
  await seedLiveAccount(uid, currentStorage() as any); // #772: weekly block writers re-read a live account
  const { block } = await createWeeklyBlock(uid, { title, weekdays, start, end: endTime, timezone: TZ, confirmedAt: NOW() }, { storage: currentStorage() as any, now: new Date() } as any);
  return block.id;
}

export async function grantPersonalization(uid: string): Promise<void> {
  await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
}

/* ── football (the real fixture store and projection) ────────────────── */

export const FIXTURE_MINUTES = 120;

export function fixture(id: string, kickoffUtc: string, over: Partial<FixtureCore> = {}): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

/** A second followed club's match (Atlético at home to Valencia), for two-followed-clubs cases; follow `['barcelona', 'atletico-madrid']`. */
export function otherClubFixture(id: string, kickoffUtc: string): Fixture {
  return fixture(id, kickoffUtc, { homeTeamId: '78', awayTeamId: '95', homeTeamName: 'Club Atlético de Madrid', awayTeamName: 'Valencia CF' });
}

export async function follow(uid: string, clubs: string[] = ['barcelona']): Promise<void> {
  await seedLiveAccount(uid); // #772: the projection writes commitments for this uid
  await setFollowedClubs(uid, clubs, NOW());
}

export async function putFixtures(...fixtures: Fixture[]): Promise<void> {
  await upsertFixtures(fixtures);
}

export function project(uid: string) {
  return projectFixturesForUser(uid, NOW());
}

export function fixtureRef(uid: string, providerMatchId: string): Promise<any> {
  return getRef(uid, `football-data:${providerMatchId}`);
}

/** The active commitment a fixture's ref links to, or null. */
export async function fixtureCommitment(uid: string, providerMatchId: string): Promise<any | null> {
  const ref = await fixtureRef(uid, providerMatchId);
  if (!ref?.linkedCommitmentId) return null;
  const linked = await commitment(uid, ref.linkedCommitmentId);
  return linked && linked.status === 'active' ? linked : null;
}

/** A match kickoff `days` days after TODAY at a local `time`. */
export function kickoff(days: number, time: string): string {
  const date = localDateOf(new Date(Date.parse(at(TODAY, '12:00')) + days * 24 * 3_600_000).toISOString());
  return at(date, time);
}

/* ── named seams (the gate's, for Task B to export) ──────────────────── */

async function freeSlotsModule(): Promise<Record<string, unknown>> {
  try {
    return await import('../../../lib/planning/freeSlots.ts') as Record<string, unknown>;
  } catch (error) {
    assert.fail(`lib/planning/freeSlots.ts failed to load (${(error as Error).message.split('\n')[0]})`);
  }
}

/**
 * `setScheduleDecisionHookForTests(hook | null)` from `lib/planning/freeSlots.ts`
 * (PLAN R1.2, M4B-R2-002): called inside every writing transaction of M4b
 * (`site`: 'football' | 'ics' | 'heldAdd' | 'postpone' | 'impact') after its
 * transactional schedule reads and before it writes. A retried transaction
 * calls it again. The gate uses it to commit a concurrent write mid-decision.
 */
export type DecisionSite = 'football' | 'ics' | 'heldAdd' | 'postpone' | 'impact';
export async function decisionHook(): Promise<(hook: ((site: DecisionSite) => Promise<void>) | null) => void> {
  const seam = (await freeSlotsModule()).setScheduleDecisionHookForTests;
  assert.equal(typeof seam, 'function', 'setScheduleDecisionHookForTests is not exported (the gate\'s named seam)');
  return seam as any;
}

/** M4a's reader seam, to count schedule reads (R1 risk: zero on a no-change run). */
export async function readerSeam(): Promise<(wrap: ((original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>) | null) => void> {
  const seam = (await freeSlotsModule()).setFreeSlotScheduleReaderForTests;
  assert.equal(typeof seam, 'function', 'setFreeSlotScheduleReaderForTests is not exported');
  return seam as any;
}

/** `candidateClashes` (PLAN R1.1). */
export async function candidateClashesFn(): Promise<(schedule: any, candidate: any, options?: any) => any> {
  const fn = (await freeSlotsModule()).candidateClashes;
  assert.equal(typeof fn, 'function', 'candidateClashes is not exported from lib/planning/freeSlots.ts (PLAN R1.1)');
  return fn as any;
}

export async function readScheduleFn(): Promise<(uid: string, window: { from: string; to: string } | Interval, storage?: any, now?: Date) => Promise<any>> {
  const fn = (await freeSlotsModule()).readFreeSlotSchedule;
  assert.equal(typeof fn, 'function', 'readFreeSlotSchedule missing');
  return fn as any;
}

/** Counts schedule reads while `body` runs. */
export async function countReads<T>(body: () => Promise<T>): Promise<{ result: T; reads: number }> {
  const seam = await readerSeam();
  let reads = 0;
  seam((original) => async (...args: any[]) => { reads += 1; return original(...args); });
  try {
    return { result: await body(), reads };
  } finally {
    seam(null);
  }
}

/** Runs `write` once, the first time the decision hook fires at `site`. */
export async function raceAt(site: DecisionSite, write: () => Promise<void>): Promise<() => void> {
  const install = await decisionHook();
  let done = false;
  install(async (where) => {
    if (where !== site || done) return;
    done = true;
    await write();
  });
  return () => install(null);
}
