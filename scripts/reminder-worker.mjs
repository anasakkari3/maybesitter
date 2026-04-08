#!/usr/bin/env node
/**
 * Maybesitter reminder worker
 *
 * Polls POST /api/reminders/run on a fixed interval so the reminder state
 * machine advances even when no browser tab is open.
 *
 * Environment variables:
 *   PORT                          - port Next.js is listening on (default: 3000)
 *   MAYBESITTER_BASE_URL          - full override, e.g. http://localhost:3001
 *   MAYBESITTER_WORKER_INTERVAL_MS - polling interval (default: 30000)
 */

const port = process.env.PORT || 3000;
const baseUrl = (process.env.MAYBESITTER_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const intervalMs = Number(process.env.MAYBESITTER_WORKER_INTERVAL_MS) || 30_000;
const endpoint = `${baseUrl}/api/reminders/run`;

let stopped = false;
let pollCount = 0;

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptPoll() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }

  return response.json();
}

async function tick() {
  const ts = new Date().toISOString();
  let lastErr = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const snapshot = await attemptPoll();
      pollCount += 1;
      const items = snapshot?.items?.length ?? '?';
      const attempts = snapshot?.reminderAttempts?.length ?? '?';
      console.log(`[${ts}] poll #${pollCount} ok — items: ${items}, attempts: ${attempts}`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length && !stopped) {
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(`[${ts}] poll attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  pollCount += 1;
  console.error(`[${ts}] poll #${pollCount} failed after ${RETRY_DELAYS_MS.length + 1} attempts:`, lastErr?.message);
}

async function main() {
  console.log(`[reminder-worker] Starting. Polling ${endpoint} every ${intervalMs / 1000}s`);

  // Brief startup delay so Next.js can finish booting
  await sleep(3_000);

  while (!stopped) {
    await tick();
    if (!stopped) await sleep(intervalMs);
  }

  console.log('[reminder-worker] Stopped.');
}

process.on('SIGTERM', () => {
  console.log('[reminder-worker] SIGTERM — shutting down');
  stopped = true;
});

process.on('SIGINT', () => {
  console.log('[reminder-worker] SIGINT — shutting down');
  stopped = true;
  process.exit(0);
});

main().catch((err) => {
  console.error('[reminder-worker] Fatal:', err);
  process.exit(1);
});
