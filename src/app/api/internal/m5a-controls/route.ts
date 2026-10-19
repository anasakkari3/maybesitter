import { randomUUID } from 'node:crypto';
import { authorizeSchedulerRequest, schedulerAuthErrorResponse } from '../../../../../lib/auth/schedulerOidc';
import { getStorage } from '../../../../../lib/storage';
import {
  INITIAL_M5A_CONTROLS,
  M5A_CONTROLS_LOG,
  M5A_CONTROLS_PATH,
  parseM5aControls,
  type M5aCapability,
  type M5aControls,
} from '../../../../../lib/release/m5aControls';
import { readJsonBody, RequestBodyTooLargeError } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

function deployerAuthEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MAYBESITTER_SCHEDULER_SA_EMAIL: process.env.MAYBESITTER_DEPLOYER_SA_EMAIL,
  };
}

function capability(value: unknown): M5aCapability | null {
  return value === 'email' || value === 'calendar' ? value : null;
}

export async function POST(request: Request) {
  if (!request.headers.get('authorization')) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = await authorizeSchedulerRequest(request, { env: deployerAuthEnv() });
  if (!auth.ok) return schedulerAuthErrorResponse(auth);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ success: false, error: 'payload_too_large' }, { status: 413 });
    }
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  const action = body.action;
  const storage = getStorage();
  const now = new Date().toISOString();

  try {
    const controls = await storage.runTransaction(async (tx) => {
      const currentRaw = await tx.get<unknown>(M5A_CONTROLS_PATH);
      if (action === 'init') {
        if (currentRaw !== null) throw new Error('already_initialized');
        tx.create(M5A_CONTROLS_PATH, INITIAL_M5A_CONTROLS);
        return INITIAL_M5A_CONTROLS;
      }
      const current = parseM5aControls(currentRaw);
      if (!current) throw new Error('not_initialized');
      const selected = capability(body.capability);
      if (!selected) throw new Error('invalid_capability');
      if (action === 'enable') {
        if (!Number.isSafeInteger(body.expectedEpoch) || body.expectedEpoch !== current[selected].epoch) throw new Error('epoch_mismatch');
        const next: M5aControls = { ...current, [selected]: { ...current[selected], enabled: true } };
        tx.set(M5A_CONTROLS_PATH, next);
        return next;
      }
      if (action === 'kill') {
        if (current[selected].epoch === Number.MAX_SAFE_INTEGER) throw new Error('epoch_exhausted');
        const next: M5aControls = { ...current, [selected]: { epoch: current[selected].epoch + 1, enabled: false } };
        const rawLog = await tx.get<unknown>(M5A_CONTROLS_LOG);
        const priorEntries = rawLog === null
          ? {}
          : (rawLog && typeof rawLog === 'object' && !Array.isArray(rawLog)
            && (rawLog as Record<string, unknown>).entries
            && typeof (rawLog as Record<string, unknown>).entries === 'object'
            && !Array.isArray((rawLog as Record<string, unknown>).entries)
            ? (rawLog as { entries: Record<string, unknown> }).entries
            : null);
        if (!priorEntries) throw new Error('control_log_malformed');
        const logId = `${Date.now()}-${randomUUID()}`;
        tx.set(M5A_CONTROLS_PATH, next);
        tx.set(M5A_CONTROLS_LOG, { entries: { ...priorEntries, [logId]: {
          capability: selected, epoch: next[selected].epoch, at: now, caller: auth.caller,
        } } });
        return next;
      }
      throw new Error('invalid_action');
    });
    return Response.json({ success: true, controls });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'control_failed';
    const status = ['already_initialized', 'epoch_mismatch'].includes(code) ? 409 : 400;
    return Response.json({ success: false, error: code }, { status });
  }
}
