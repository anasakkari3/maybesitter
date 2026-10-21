/**
 * M6a-1 Gate B, shared harness (PLAN-M6a, scope split at r3, dispositions
 * through r4 binding). Gate author: Claude, written before Task B's build.
 * Every test must fail on daf27abf for the reason its criterion names, except
 * the parity guards, which pin today's behaviour (named "parity").
 *
 * Built on the M5b harness: real routes in-process, fake auth, memory storage,
 * the process clock pinned to REFERENCE (Wednesday 2026-10-07 10:00
 * Jerusalem) and moved only by `setClock`. The M6 search-history capability
 * (`MAYBESITTER_FEATURE_SEARCH_HISTORY`) is on unless a test says otherwise.
 *
 * Only statuses, error codes, ids, order and what is persisted are asserted.
 */
import assert from 'node:assert/strict';
import { applyParticipantCommands } from '../../../lib/services/mobile/participantState.ts';
import {
  REFERENCE, TZ, TODAY, TOMORROW, at, call, currentStorage, show, setClock, plusMinutes, nextId,
  addCommitment, begin as beginM5b, end as endM5b, loadModule, setAccount, NOW, type Raw,
} from '../m5b/support.ts';

export { REFERENCE, TZ, TODAY, TOMORROW, at, call, currentStorage, show, setClock, plusMinutes, nextId, addCommitment, loadModule, setAccount, NOW };
export type { Raw };

const ENV_KEYS = ['MAYBESITTER_FEATURE_SEARCH_HISTORY', 'MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY'] as const;
let saved: Record<string, string | undefined> | null = null;

export interface M6Switches {
  /** MAYBESITTER_FEATURE_SEARCH_HISTORY (default on). `null` leaves it unset. */
  on?: boolean | null;
  killed?: boolean;
  environment?: string;
}

export function setM6Switches(switches: M6Switches = {}): void {
  if (saved === null) saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  if (switches.on === null) delete process.env.MAYBESITTER_FEATURE_SEARCH_HISTORY;
  else process.env.MAYBESITTER_FEATURE_SEARCH_HISTORY = (switches.on ?? true) ? 'true' : 'false';
  process.env.MAYBESITTER_KILL_SWITCH_SEARCH_HISTORY = switches.killed ? 'true' : 'false';
}

export async function begin(switches: M6Switches = {}, account: { timezone?: string; locale?: string } = {}): Promise<string> {
  const uid = await beginM5b({ environment: switches.environment ?? 'staging' }, account);
  setM6Switches(switches);
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
  endM5b();
}

const DAY = 24 * 60 * 60_000;
export const minusDays = (iso: string, days: number) => new Date(Date.parse(iso) - days * DAY).toISOString();
export const minusMs = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();

/** A confirmed commitment created at `createdAt` (the clock is moved there and back). */
export async function addAt(uid: string, createdAt: string, title: string, timeSpec: Record<string, unknown>): Promise<string> {
  const back = NOW();
  setClock(createdAt);
  try {
    return await addCommitment(uid, title, timeSpec);
  } finally {
    setClock(back);
  }
}

/** Settles a commitment at `when` ('Complete' or 'Drop'), moving the clock there and back. */
export async function settleAt(uid: string, id: string, kind: 'Complete' | 'Drop', when: string): Promise<void> {
  const back = NOW();
  setClock(when);
  try {
    await applyParticipantCommands(uid, [{ type: kind, commitmentId: id, now: when } as any]);
  } finally {
    setClock(back);
  }
}

export async function postpone(uid: string, id: string, until: string): Promise<void> {
  await applyParticipantCommands(uid, [{ type: 'Postpone', commitmentId: id, postponedUntil: until, now: NOW() } as any]);
}

export async function search(uid: string, query: Record<string, string>): Promise<Raw> {
  return call(uid, 'commitments/search', 'GET', { query });
}

export async function searchOk(uid: string, q: string, limit?: string): Promise<any> {
  const result = await search(uid, limit === undefined ? { q } : { q, limit });
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

export const idsOf = (body: any): string[] => (body.items as Array<{ id: string }>).map((item) => item.id);
