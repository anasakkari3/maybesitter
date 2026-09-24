import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { onBeforeSignOut } from '../auth/beforeSignOut';
import { useApp } from '../state/AppContext';
import { appEnv } from '../config/env';
import { clarityEnabled } from './config';
import { createReplayController } from './controller';
import { clarityAvailable, loadClarity } from './native';
import { screenContext, type ClarityStage, type ReplayEvent } from './policy';

const replay = createReplayController(loadClarity);
interface ReplayModel {
  enabled: boolean;
  consent: boolean;
  setConsent: (allowed: boolean) => void;
  stage: (owner: symbol, value: ClarityStage | null) => void;
  event: (event: ReplayEvent) => void;
}
const Context = createContext<ReplayModel | null>(null);

export function ClarityProvider({ children }: { children: React.ReactNode }) {
  const { user, status } = useAuth();
  // Local consent scope only. It is never passed to Clarity, stored or logged.
  // Do not key the provider subtree: account-deletion receipts must survive logout.
  const scope = `${status}:${user?.uid ?? ''}`;
  const { s, lang, scheme } = useApp();
  // Deliberately session-only. A cold start or account change always asks again;
  // a failed storage write cannot resurrect a consent the person withdrew.
  const [answer, setAnswer] = useState({ scope, allowed: false });
  if (answer.scope !== scope) setAnswer({ scope, allowed: false });
  const consent = answer.scope === scope && answer.allowed;
  const activeScope = useRef<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [stages, setStages] = useState<Map<symbol, ClarityStage>>(() => new Map());
  const enabled = clarityEnabled() && status === 'signedIn' && clarityAvailable();
  const setConsent = useCallback((allowed: boolean) => {
    if (activeScope.current !== scope) return;
    if (!allowed) replay.stop();
    setAnswer({ scope, allowed });
  }, [scope]);
  const stage = useCallback((owner: symbol, value: ClarityStage | null) => {
    setStages(previous => {
      const next = new Map(previous);
      if (value === null) next.delete(owner); else next.set(owner, value);
      return next;
    });
  }, []);
  const stageValues = [...stages.values()];
  const currentStage = stageValues.find(value => value.startsWith('ai_import_')) ?? stageValues.at(-1) ?? null;
  const screen = screenContext(s.screen, currentStage);
  const screenName = screen?.screen;
  const flowName = screen?.flow;

  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => { activeScope.current = null; replay.stop(); };
  }, [scope]);
  useLayoutEffect(() => {
    replay.update(screenName && flowName ? {
      screen: screenName, flow: flowName, locale: lang, theme: scheme, environment: appEnv(),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    } : null, consent && foreground, enabled);
  }, [screenName, flowName, lang, scheme, consent, foreground, enabled]);

  useEffect(() => {
    const removeSignOut = onBeforeSignOut(async () => { setConsent(false); });
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') replay.stop();
      setForeground(state === 'active');
    });
    return () => { removeSignOut(); subscription.remove(); };
  }, [setConsent]);
  const event = useCallback((name: ReplayEvent) => {
    // An account A request finishing after A unmounts must not tag B's replay.
    if (activeScope.current === scope) replay.event(name);
  }, [scope]);
  const value = useMemo(() => ({ enabled, consent, setConsent, stage, event }), [enabled, consent, setConsent, stage, event]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useClarityConsent = () => useContext(Context);

const ignoreEvent = (_event: ReplayEvent) => {};
export const useReplayEvent = () => useContext(Context)?.event ?? ignoreEvent;

/** Nested flows override their route name with a closed set of stage names. */
export function useClarityStage(value: ClarityStage | null): void {
  const register = useContext(Context)?.stage;
  const [owner] = useState(() => Symbol());
  useEffect(() => {
    register?.(owner, value);
    return () => register?.(owner, null);
  }, [register, owner, value]);
}
