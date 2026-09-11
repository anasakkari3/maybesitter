/**
 * Prove that nothing a user confirmed disappears when MaybeSitter redeploys or
 * runs on several instances (UC-1.9, #153).
 *
 * Run against a deployed staging service, never production:
 *
 *   FIREBASE_WEB_API_KEY=… node --loader ./scripts/ts-resolver.mjs \
 *     scripts/verify-durability.ts --base-url https://…run.app \
 *     --service maybesitter-api-staging --region europe-west1
 *
 * ── What it does to the service, and undoes ──────────────────────
 *
 * Scaling to two instances and narrowing concurrency is the only way to prove
 * anything about more than one process. The recommendation module is off by
 * default (`MODULE_FEATURE_FLAG_DEFAULTS`), and `decidePilotExposure` refuses
 * before it ever looks at consent, so the run also turns that flag on. Both,
 * and the throwaway account, are undone in `finally` — including when a check
 * fails, which is when leaving `min-instances=2` running would quietly cost
 * money.
 *
 * ── The identity ─────────────────────────────────────────────────
 *
 * A throwaway `durability-<runId>` account, created through Identity
 * Toolkit's REST `accounts:signUp` with the project's web API key, which
 * returns a real Firebase ID token. Deliberately not `createCustomToken`:
 * that needs a service account to sign with, and no durability test is worth
 * broadening IAM for.
 *
 * ── What the judgements are ──────────────────────────────────────
 *
 * None of them live here. `lib/durability/checks.ts` holds them and is unit
 * tested, so a red run means the data was wrong, not that this script misread
 * it. This file gathers evidence and hands it over.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// The scheduler store is the real one, so the job this run injects is shaped
// exactly like a job the product creates. Both must be set before anything
// touches storage: the adapter resolves the backend and database on first use.
process.env.MAYBESITTER_STORAGE_BACKEND = 'firestore';
process.env.MAYBESITTER_FIRESTORE_DATABASE_ID ??= 'staging';

import { createStorageSchedulerStore } from '../lib/scheduler/storageSchedulerStore.ts';
import { createFirestoreStorage } from '../lib/storage/firestoreAdapter.ts';
import { userDoc } from '../lib/storage/paths.ts';
import {
  countDistinctInstances,
  finalStateFrom,
  finalStatusFromCommitmentStatus,
  jobRanExactlyOnce,
  latestByUpdatedAt,
  revisionChanged,
  summaryExitCode,
  tallyIdempotency,
} from '../lib/durability/checks.ts';
import type { AppliedAction, CheckResult, CommitmentActionKind, DurabilitySummary } from '../lib/durability/checks.ts';

/* ── Arguments and environment ───────────────────────────────────── */

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value && fallback === undefined) {
    console.error(`missing required argument --${name}`);
    process.exit(2);
  }
  return value ?? fallback!;
}

const BASE_URL = arg('base-url').replace(/\/$/, '');
const SERVICE = arg('service', 'maybesitter-api-staging');
const REGION = arg('region', 'europe-west1');
const PROJECT = arg('project', 'maybesitter-app');
const ITEMS = Number(arg('items', '8'));
const API_KEY = process.env.FIREBASE_WEB_API_KEY;

if (!API_KEY) {
  console.error('FIREBASE_WEB_API_KEY is required (the project web API key; it is not a secret, and it is not committed)');
  process.exit(2);
}
if (/maybesitter-api(-|$)/.test(SERVICE) && SERVICE === 'maybesitter-api') {
  console.error('refusing to run against production; this test writes data and rescales the service');
  process.exit(2);
}

const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const startedAt = Date.now();
const counts: Record<string, number> = {};
const checks: Record<string, CheckResult> = {};
const record = (name: string, ok: boolean) => {
  checks[name] = ok ? 'pass' : 'fail';
  console.error(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

/* ── Small helpers ───────────────────────────────────────────────── */

function gcloud(args: readonly string[]): string {
  return execFileSync('gcloud', [...args, '--project', PROJECT], { encoding: 'utf8' }).trim();
}

let idToken = '';
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Phase 0: a throwaway identity ───────────────────────────────── */

async function signUp(): Promise<{ uid: string; token: string }> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `durability-${runId}@durability.invalid`,
      password: randomUUID(),
      returnSecureToken: true,
    }),
  });
  const body = (await response.json()) as { idToken?: string; localId?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken || !body.localId) {
    throw new Error(`could not create the test account: ${body.error?.message ?? response.status}`);
  }
  return { uid: body.localId, token: body.idToken };
}

async function deleteAccount(token: string): Promise<boolean> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
  return response.ok;
}

/* ── The run ─────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const identity = await signUp();
  idToken = identity.token;
  console.error(`run ${runId} as ${identity.uid} against ${SERVICE}`);

  let scaledOut = false;
  const jobId = `job_durability_${runId}`;
  // Hoisted: the summary reports them, and the finally block runs before it.
  let revisionBefore: string | null = null;
  let revisionAfter: string | null = null;

  try {
    /* Phase 1 — scale out. Without two instances nothing below proves anything. */
    gcloud(['run', 'services', 'update', SERVICE, '--region', REGION,
      '--min-instances=2', '--concurrency=4',
      '--update-env-vars', 'MAYBESITTER_FEATURE_RECOMMENDATION=true']);
    scaledOut = true;

    const instanceIds: string[] = [];
    for (let attempt = 0; attempt < 40 && countDistinctInstances(instanceIds) < 2; attempt += 1) {
      const health = await Promise.all([api('/api/health'), api('/api/health'), api('/api/health')]);
      for (const { body } of health) if (body?.instanceId) instanceIds.push(body.instanceId);
      if (countDistinctInstances(instanceIds) < 2) await sleep(2000);
    }
    const instances = countDistinctInstances(instanceIds);
    counts.instances = instances;
    record('scaled_to_two_instances', instances >= 2);

    /* Phase 2a — N captures, each confirmed. */
    const commitmentIds: string[] = [];
    await Promise.all(
      Array.from({ length: ITEMS }, async (_, index) => {
        const proposal = await api('/api/mobile/capture', {
          method: 'POST',
          body: JSON.stringify({ text: `durability ${runId} item ${index} tomorrow at 9` }),
        });
        const items: Array<{ itemId: string }> = proposal.body?.items ?? [];
        if (proposal.body?.status !== 'proposed' || items.length === 0) return;
        const confirmed = await api('/api/mobile/capture/confirm', {
          method: 'POST',
          body: JSON.stringify({ proposalId: proposal.body.proposalId, itemIds: [items[0]!.itemId] }),
        });
        for (const persisted of confirmed.body?.persisted ?? []) commitmentIds.push(persisted.commitmentId);
      }),
    );
    counts.commitments = commitmentIds.length;
    record('every_capture_persisted', commitmentIds.length === ITEMS);

    /* Phase 2b — 20 decisions, one idempotency key: exactly one may be recorded. */
    await api('/api/mobile/pilot/trust', {
      method: 'POST',
      body: JSON.stringify({ action: { type: 'grant_recommendation_consent' } }),
    });
    const nextStep = await api('/api/mobile/recommendations/next-step');
    const proposalId = nextStep.body?.recommendation?.proposalId ?? null;
    if (proposalId) {
      const key = `durability-${runId}-decision`;
      const responses = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const { status, body } = await api('/api/mobile/recommendations/next-step/actions', {
            method: 'POST',
            body: JSON.stringify({ proposalId, decision: 'accept', idempotencyKey: key }),
          });
          return { status, replayed: body?.replayed === true };
        }),
      );
      const tally = tallyIdempotency(responses);
      counts.decisionsAccepted = tally.accepted;
      counts.decisionsReplayed = tally.replayed;
      record('one_decision_recorded_for_one_key', tally.ok);
    } else {
      // Reported rather than skipped silently: a run that could not obtain a
      // recommendation has not tested idempotency at all.
      record('one_decision_recorded_for_one_key', false);
      console.error(`  no recommendation was offered (reason: ${nextStep.body?.reason ?? nextStep.status})`);
    }

    /* Phase 2c — 10 mixed actions on one commitment race each other. */
    const target = commitmentIds[0];
    if (target) {
      const kinds: CommitmentActionKind[] = Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? 'complete' : 'postpone'));
      const applied: AppliedAction[] = await Promise.all(
        kinds.map(async (kind) => {
          const { status, body } = await api(`/api/mobile/commitments/${target}/actions`, {
            method: 'POST',
            body: JSON.stringify(
              kind === 'postpone'
                ? { action: 'postpone', postponedUntil: new Date(Date.now() + 86_400_000).toISOString() }
                : { action: kind },
            ),
          });
          // `at` is the server's own updatedAt, never this process's clock.
          return { kind, accepted: status < 400 && body?.success === true, at: body?.commitment?.updatedAt ?? new Date(0).toISOString() };
        }),
      );
      const expected = finalStateFrom(applied);
      const after = await api(`/api/mobile/commitments/${target}`);
      const observed = finalStatusFromCommitmentStatus(after.body?.commitment?.status ?? after.body?.status ?? '');
      counts.actionsAccepted = expected.acceptedCount;
      record('mixed_actions_settle_on_one_state', expected.status === observed);
    } else {
      record('mixed_actions_settle_on_one_state', false);
    }

    /* Phase 2d — 10 alternating consent toggles; the last write must win. */
    const toggles = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const granted = index % 2 === 0;
        const { body } = await api('/api/mobile/pilot/trust', {
          method: 'POST',
          body: JSON.stringify({ action: { type: 'set_analytics_consent', granted } }),
        });
        return { granted, updatedAt: body?.trust?.updatedAt ?? new Date(0).toISOString() };
      }),
    );
    const lastWrite = latestByUpdatedAt(toggles);
    const consentNow = await api('/api/mobile/pilot/trust');
    record('consent_matches_the_last_write', Boolean(lastWrite) && consentNow.body?.trust?.analyticsConsent === lastWrite!.granted);

    /* Phase 3 — read everywhere: every read sees every item. */
    const reads = await Promise.all(Array.from({ length: 30 }, () => api('/api/mobile/commitments/upcoming')));
    const complete = reads.filter(({ body }) => {
      const ids = new Set((body?.items ?? []).map((item: { id: string }) => item.id));
      return commitmentIds.every((id) => ids.has(id));
    });
    counts.completeReads = complete.length;
    record('every_read_sees_every_item', commitmentIds.length > 0 && complete.length === reads.length);

    /* Phase 4 — redeploy the same image; nothing may change but the revision. */
    const historyBefore = await api('/api/mobile/feedback/history');
    const consentBefore = consentNow.body?.trust?.analyticsConsent;
    revisionBefore = (await api('/api/health')).body?.revision ?? null;

    // A job due now, shaped exactly like one the product creates, left for the
    // real Cloud Scheduler tick to claim while the redeploy happens.
    const store = createStorageSchedulerStore();
    await store.createJob({
      id: jobId,
      uid: identity.uid,
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: `rem_durability_${runId}`,
      runAt: new Date(Date.now() - 1000).toISOString(),
      payload: { reminderId: `rem_durability_${runId}` },
    });

    const image = gcloud(['run', 'services', 'describe', SERVICE, '--region', REGION,
      '--format=value(spec.template.spec.containers[0].image)']);
    gcloud(['run', 'deploy', SERVICE, '--region', REGION, '--image', image, '--quiet']);
    revisionAfter = (await api('/api/health')).body?.revision ?? null;
    record('redeploy_made_a_new_revision', revisionChanged({ before: revisionBefore, after: revisionAfter }));

    const readsAfter = await api('/api/mobile/commitments/upcoming');
    const idsAfter = new Set((readsAfter.body?.items ?? []).map((item: { id: string }) => item.id));
    record('data_survived_the_redeploy', commitmentIds.every((id) => idsAfter.has(id)));

    const consentAfter = (await api('/api/mobile/pilot/trust')).body?.trust?.analyticsConsent;
    record('consent_survived_the_redeploy', consentAfter === consentBefore);

    const historyAfter = await api('/api/mobile/feedback/history');
    record('feedback_history_survived_the_redeploy',
      JSON.stringify(historyAfter.body?.items ?? []) === JSON.stringify(historyBefore.body?.items ?? []));

    // Cloud Scheduler ticks every minute; give it two, then read the job back.
    // "Exactly once" is about execution, not about the command succeeding: the
    // reminder this job names does not exist, so the handler rejects it and the
    // runner fails it without a retry. One attempt, one terminal state.
    let job = null;
    for (let attempt = 0; attempt < 24 && !job; attempt += 1) {
      await sleep(5000);
      job = (await store.listJobs()).find((candidate) => candidate.id === jobId && candidate.status !== 'pending' && candidate.status !== 'claimed') ?? null;
    }
    counts.jobAttempts = job?.attempts ?? 0;
    record('scheduler_ran_the_job_exactly_once', jobRanExactlyOnce(job));
  } finally {
    /* Phase 5 — always undo everything this run changed. */
    const cleanup: string[] = [];
    try {
      if (await deleteAccount(idToken)) cleanup.push('account deleted');
    } catch (error) {
      cleanup.push(`account NOT deleted: ${(error as Error).message}`);
    }
    try {
      await createFirestoreStorage().deleteTree(userDoc(identity.uid));
      cleanup.push('user tree deleted');
    } catch (error) {
      cleanup.push(`user tree NOT deleted: ${(error as Error).message}`);
    }
    try {
      await createFirestoreStorage().delete(`jobs/${jobId}`);
      cleanup.push('job deleted');
    } catch (error) {
      cleanup.push(`job NOT deleted: ${(error as Error).message}`);
    }
    if (scaledOut) {
      try {
        gcloud(['run', 'services', 'update', SERVICE, '--region', REGION,
          '--min-instances=0', '--concurrency=40',
          '--remove-env-vars', 'MAYBESITTER_FEATURE_RECOMMENDATION']);
        cleanup.push('scaling and feature flag restored');
      } catch (error) {
        cleanup.push(`SERVICE NOT RESTORED — min-instances is still 2: ${(error as Error).message}`);
      }
    }
    console.error(`cleanup: ${cleanup.join('; ')}`);
  }

  const summary: DurabilitySummary = {
    runId,
    revisions: { before: revisionBefore, after: revisionAfter },
    instances: counts.instances ?? 0,
    counts,
    checks,
    durationMs: Date.now() - startedAt,
  };
  // The summary carries no tokens and no commitment text.
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summaryExitCode(summary));
}

void main();
