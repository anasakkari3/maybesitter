/**
 * Keeps the home-screen widget in step with the account (UC-3.R1, #203).
 *
 * ── When it writes ───────────────────────────────────────────────
 *
 *  - whenever Today or the next step change — which covers every commitment
 *    mutation, because they all invalidate both queries;
 *  - whenever the title setting, the language or the zone change — so turning
 *    titles off rewrites the widget from the switch's own render, not at the
 *    next launch;
 *  - when the app goes to the background, so the snapshot the widget keeps
 *    showing is the freshest one this session had.
 *
 * It writes only once Today has loaded. An empty snapshot written in the frame
 * before the first list arrives would tell the home screen "nothing open", and
 * a failed list is not an empty day either: the old snapshot is left to expire
 * into "stale", which is the honest thing for the widget to say.
 *
 * ── When it clears ───────────────────────────────────────────────
 *
 * Before a sign-out (every reason — the phone left in a drawer signs out with
 * `session_expired`, and is the one about to be handed to someone), and when
 * the signed-in tree unmounts, which is also what deleting the account does.
 * Nothing can be written after that: the only writer is this hook's effect,
 * and an unmounted tree runs no effects.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { onBeforeSignOut } from '../../auth/beforeSignOut';
import { useNextStep, useToday } from '../../api/queries';
import { formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import {
  loadWidgetTitlesAllowed,
  saveWidgetTitlesAllowed,
  subscribeWidgetTitlesAllowed,
} from '../../lib/deviceSettings/widget';
import { buildSnapshot } from './snapshot';
import { widgetLabelsFor } from './labels';
import { createNativeWidgetBridge, type WidgetBridge } from './widgetBridge';

/** The user's answer for this account on this phone. `false` until read, and on any doubt. */
export function useWidgetTitlesAllowed(uid: string | null): {
  allowed: boolean;
  setAllowed: (next: boolean) => Promise<boolean>;
} {
  const [state, setState] = useState<{ uid: string | null; allowed: boolean }>({ uid: null, allowed: false });

  useEffect(() => {
    if (!uid) return;
    let active = true;
    void loadWidgetTitlesAllowed(uid).then((allowed) => {
      if (active) setState({ uid, allowed });
    });
    const unsubscribe = subscribeWidgetTitlesAllowed((changedUid, allowed) => {
      if (active && changedUid === uid) setState({ uid, allowed });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [uid]);

  return {
    // Held under its uid, so another account's yes is never read as this one's.
    allowed: uid !== null && state.uid === uid && state.allowed,
    setAllowed: (next) => (uid ? saveWidgetTitlesAllowed(uid, next) : Promise.resolve(false)),
  };
}

export function useWidgetSnapshotSync(options: { bridge?: WidgetBridge; now?: () => Date } = {}): void {
  const uid = useAuth().user?.uid ?? null;
  const { t, lang } = useApp();
  const timeZone = useTimeZone();
  const today = useToday();
  const nextStep = useNextStep();
  const { allowed } = useWidgetTitlesAllowed(uid);
  const [defaultBridge] = useState(createNativeWidgetBridge);
  const bridge = options.bridge ?? defaultBridge;
  const nowRef = useRef(options.now ?? (() => new Date()));
  const [backgrounded, setBackgrounded] = useState(0);

  const todayItems = today.isSuccess ? today.data.items : undefined;
  const primaryStep = nextStep.isSuccess ? nextStep.data.recommendation.primaryStep ?? null : null;

  useEffect(() => {
    if (!uid || todayItems === undefined) return;
    const snapshot = buildSnapshot({
      today: todayItems,
      nextStep: primaryStep,
      titlesAllowed: allowed,
      surface: 'widget',
      locale: lang,
      labels: widgetLabelsFor(t),
      now: nowRef.current(),
      formatTime: (date) => formatTime(date, { locale: lang, timeZone }),
    });
    void bridge.write(JSON.stringify(snapshot));
  }, [uid, todayItems, primaryStep, allowed, lang, t, timeZone, bridge, backgrounded]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') setBackgrounded((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const clear = () => bridge.clear();
    const unregister = onBeforeSignOut(clear);
    return () => {
      unregister();
      void clear();
    };
  }, [bridge]);
}

/** Draws nothing; mounted once in `Root` for the signed-in session. */
export function WidgetSnapshotHost(): null {
  useWidgetSnapshotSync();
  return null;
}
