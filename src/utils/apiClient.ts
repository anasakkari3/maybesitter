import type { AppSnapshot } from '@/server/dataStore';
import type { DailyDigest } from '@/types';

async function parseJsonResponse(response: Response): Promise<AppSnapshot> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Request failed with ${response.status}`);
  }
  return response.json();
}

export async function fetchAppSnapshot(): Promise<AppSnapshot> {
  return parseJsonResponse(await fetch('/api/state', { cache: 'no-store' }));
}

export async function postAppAction(type: string, payload: Record<string, unknown> = {}): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    })
  );
}

export async function runReminderScheduler(): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch('/api/reminders/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

export async function exportAppData(): Promise<string> {
  const snapshot = await fetchAppSnapshot();
  return JSON.stringify({ ...snapshot, exportedAt: new Date().toISOString() }, null, 2);
}

export async function createCommitment(item: Record<string, unknown>): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch('/api/commitment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item }),
    })
  );
}

export async function postCommitmentAction(id: string, action: string): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch(`/api/commitment/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
  );
}

export async function patchCommitment(id: string, updates: Record<string, unknown>): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch(`/api/commitment/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    })
  );
}

export async function clearCommitments(): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch('/api/commitments/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

export async function seedDemoData(): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch('/api/dev/seed-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

export async function confirmDailyDigest(digest: DailyDigest, today: string): Promise<AppSnapshot> {
  return parseJsonResponse(
    await fetch('/api/digest/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest, today }),
    })
  );
}
