import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useUid, useSendNativeReadiness } from '../../api/queries';
import type { HealthKitReadinessNativeModule } from '../../../modules/healthkit-readiness';
import {
  clearHealthConnection,
  loadHealthConnection,
  saveHealthConnection,
} from '../../lib/deviceSettings/healthConnection';
import { createDeviceHealthKitReadinessAdapter } from './healthKitDeviceAdapter';

/**
 * Health → energy: Apple Health read on the phone, summarized there, and sent
 * to `POST /api/mobile/readiness` as a readiness snapshot.
 *
 * ── When Health is asked ─────────────────────────────────────────
 *
 * Permission is requested only when the user presses «استعمل بيانات الصحة»,
 * never at launch. On mount the adapter is asked *without* requesting, which
 * is how an iPad or a build without the native module finds out it has no
 * Health at all and says so instead of offering a button that cannot work.
 *
 * ── Denied looks like "no data" on iOS ───────────────────────────
 *
 * HealthKit never tells an app that a read was refused; a refused type simply
 * returns nothing. So after the sheet, "nothing came back" is shown with the
 * way to change the permission in Health, and the connection stays on — the
 * next foreground read picks the data up if the user turns access on.
 * `permission_denied` is still handled, because the adapter reports it when
 * the authorization request itself fails.
 *
 * ── Refresh ──────────────────────────────────────────────────────
 *
 * On return to the foreground, at most once per
 * `HEALTH_REFRESH_MIN_INTERVAL_MS`. Readiness is a morning-and-afternoon
 * signal; reading Health on every app switch would cost battery for a number
 * that has not moved.
 *
 * ── Android ──────────────────────────────────────────────────────
 *
 * Hidden. The Health Connect module exists, but the app declares no
 * permissions-rationale activity, without which Android 14 does not show the
 * Health Connect permission sheet at all — a button there could only fail.
 */
export const HEALTH_REFRESH_MIN_INTERVAL_MS = 30 * 60 * 1000;

/** How far back one read looks: last night's sleep and today's steps. */
export const HEALTH_READ_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HealthCardState =
  | 'hidden'
  | 'checking'
  | 'unavailable'
  | 'idle'
  | 'working'
  | 'connected'
  | 'noData'
  | 'denied'
  | 'failed';

function systemNow(): Date {
  return new Date();
}

export interface HealthReadinessOptions {
  /** Tests pass a fake. Production reads the real optional native module. */
  nativeModule?: HealthKitReadinessNativeModule | null;
  platform?: string;
  now?: () => Date;
}

export function useHealthReadiness(options: HealthReadinessOptions = {}) {
  const uid = useUid();
  const send = useSendNativeReadiness();
  const platform = options.platform ?? Platform.OS;
  const clock = options.now ?? systemNow;
  // Stable across renders (TanStack keeps `mutateAsync`'s identity), so the
  // callbacks below are too, and the foreground listener is not re-attached
  // on every render.
  const sendSnapshot = send.mutateAsync;
  const { nativeModule } = options;
  const adapter = useMemo(
    () => createDeviceHealthKitReadinessAdapter({}, nativeModule),
    [nativeModule],
  );
  const [state, setState] = useState<HealthCardState>(platform === 'ios' ? 'checking' : 'hidden');
  const [connected, setConnected] = useState(false);
  const lastAttemptAt = useRef<number | null>(null);
  const busy = useRef(false);

  const sync = useCallback(async () => {
    if (busy.current || uid === 'signed-out') return;
    busy.current = true;
    setState('working');
    const at = clock();
    lastAttemptAt.current = at.getTime();
    try {
      await saveHealthConnection(uid, { connected: true, lastAttemptAt: at.toISOString() });
      const result = await adapter.collect({
        scopeId: uid,
        computedAt: at.toISOString(),
        windowStart: new Date(at.getTime() - HEALTH_READ_WINDOW_MS).toISOString(),
        windowEnd: at.toISOString(),
      });
      if (result.state === 'fresh' && result.snapshot) {
        await sendSnapshot(result.snapshot);
        setState('connected');
      } else if (result.state === 'empty' || result.state === 'stale') {
        // Nothing current to plan with. A stale reading is not sent: it would
        // arrive stamped "now" and read as today's energy.
        setState('noData');
      } else if (result.state === 'permission_denied') {
        setState('denied');
      } else if (result.state === 'unavailable') {
        setState('unavailable');
      } else {
        setState('failed');
      }
    } catch {
      setState('failed');
    } finally {
      busy.current = false;
    }
  }, [adapter, clock, sendSnapshot, uid]);

  const connect = useCallback(async () => {
    if (busy.current || uid === 'signed-out') return;
    setState('working');
    try {
      const authorization = await adapter.authorize(true);
      if (authorization.state === 'unavailable') {
        setState('unavailable');
        return;
      }
      if (authorization.state === 'denied' || authorization.state === 'error') {
        setState(authorization.state === 'denied' ? 'denied' : 'failed');
        return;
      }
    } catch {
      setState('failed');
      return;
    }
    setConnected(true);
    await sync();
  }, [adapter, sync, uid]);

  const disconnect = useCallback(async () => {
    if (busy.current) return;
    try {
      await adapter.disconnect();
    } finally {
      await clearHealthConnection(uid);
      setConnected(false);
      lastAttemptAt.current = null;
      setState('idle');
    }
  }, [adapter, uid]);

  // First look: is there Health here, and did this account connect it on this
  // phone? No permission is requested.
  useEffect(() => {
    if (platform !== 'ios' || uid === 'signed-out') return;
    let cancelled = false;
    void (async () => {
      let availability: string;
      try {
        availability = (await adapter.authorize(false)).state;
      } catch {
        availability = 'error';
      }
      const stored = await loadHealthConnection(uid);
      if (cancelled) return;
      if (availability === 'unavailable') {
        setState('unavailable');
        return;
      }
      if (!stored) {
        setState('idle');
        return;
      }
      setConnected(true);
      lastAttemptAt.current = stored.lastAttemptAt ? Date.parse(stored.lastAttemptAt) : null;
      setState('connected');
      const due = lastAttemptAt.current === null
        || clock().getTime() - lastAttemptAt.current >= HEALTH_REFRESH_MIN_INTERVAL_MS;
      if (due) await sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, clock, platform, sync, uid]);

  // Back in the foreground: refresh a connected Health read if it is due.
  useEffect(() => {
    if (platform !== 'ios' || !connected) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const last = lastAttemptAt.current;
      if (last !== null && clock().getTime() - last < HEALTH_REFRESH_MIN_INTERVAL_MS) return;
      void sync();
    });
    return () => subscription.remove();
  }, [clock, connected, platform, sync]);

  return { state, connected, connect, refresh: sync, disconnect };
}
