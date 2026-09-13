import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useColorScheme } from 'react-native';
import { strings, type Lang, type Strings } from '../i18n/strings';
import { setLocale, tFor } from '../i18n';
import {
  loadLanguagePref, nextLanguagePref, resolveLanguage, saveLanguagePref, systemLanguageTag, type LanguagePref,
} from '../i18n/language';
import { googleCalendarDemoEnabled } from '../config/env';
import { palettes, type Palette, type Scheme } from '../theme/tokens';
import { analyzeText, exampleText } from '../services/mockCapture';
import { seedCommitments, seedYesterday, TODAY } from './seed';
import type {
  CapState, Commitment, ExampleKey, Part, Proposal, Screen, Sheet, Status, ThemePref, YesterdayItem,
} from './types';

export type AppState = {
  screen: Screen;
  prev: Screen;
  cap: CapState;
  input: string;
  liveWords: number;
  exampleKey: ExampleKey | null;
  proposals: Proposal[];
  parts: Part[];
  kind: string | null;
  sheet: Sheet;
  toast: string;
  undoLeft: number;
  savedIds: string[];
  nextDismissed: boolean;
  fmMode: 'sessions' | 'twomin';
  /**
   * Which day of the week strip is open, as an offset from today (0 = today).
   *
   * Was a weekday index into the seed week (UC-2.R3, #173). The strip now runs
   * forward from today, so a fixed index would mean a different day depending
   * on what day it is.
   */
  selDay: number;
  detailId: string | null;
  commitments: Commitment[];
  yesterday: YesterdayItem[];
};

const initial: AppState = {
  screen: 'today', prev: 'today',
  cap: 'idle', input: '', liveWords: 0, exampleKey: null,
  proposals: [], parts: [], kind: null,
  sheet: null, toast: '',
  undoLeft: 5, savedIds: [],
  nextDismissed: false, fmMode: 'sessions', selDay: 0, detailId: null,
  commitments: seedCommitments, yesterday: seedYesterday,
};

const captureReset = { cap: 'idle' as CapState, input: '', proposals: [] as Proposal[], parts: [] as Part[] };

function useAppModel() {
  const [s, setS] = useState<AppState>(initial);
  // The stored choice (System / English / العربية) and the language it resolves
  // to. The device tag is read once: changing the phone's language restarts the
  // app anyway, and re-reading it every render is a native call for nothing.
  const [langPref, setLangPref] = useState<LanguagePref>('system');
  const systemTag = useMemo(() => systemLanguageTag(), []);
  const lang: Lang = resolveLanguage(langPref, systemTag);
  const [themePref, setThemePref] = useState<ThemePref>('system');
  const system = useColorScheme();
  const scheme: Scheme = themePref === 'system' ? (system === 'dark' ? 'dark' : 'light') : themePref;
  const t: Strings = strings[lang];
  // ICU-aware, key-checked `t` for the three count messages `fill` cannot
  // inflect (confirmN, lockedTitle, progressWords). See src/i18n/README.md.
  const tr = useMemo(() => tFor(lang), [lang]);
  const p: Palette = palettes[scheme];

  // Read the persisted preference once, then keep i18next on whatever language
  // the app is actually rendering, so `tr` and the screens never disagree.
  useEffect(() => {
    let active = true;
    void loadLanguagePref().then(pref => { if (active) setLangPref(pref); });
    return () => { active = false; };
  }, []);
  useEffect(() => { void setLocale(lang); }, [lang]);

  const sRef = useRef(s);
  sRef.current = s;
  const tRef = useRef(t);
  tRef.current = t;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };
  const set = (patch: Partial<AppState> | ((st: AppState) => Partial<AppState> | null)) =>
    setS(st => {
      const next = typeof patch === 'function' ? patch(st) : patch;
      return next ? { ...st, ...next } : st;
    });
  const holdAt = useRef(0);

  const applyLangPref = (pref: LanguagePref) => {
    setLangPref(pref);
    void saveLanguagePref(pref);
  };

  /**
   * Throws away everything this session held (UC-1.4 #148 step 4).
   *
   * Called when the signed-in uid changes. The query cache is cleared by
   * `ApiProvider`, but this provider also holds commitments, proposals, a
   * half-typed capture and the selected day in memory — and one of those
   * rendering for the next account, even for the frame before a refetch
   * lands, is somebody reading somebody else's commitments.
   *
   * `useCallback` with no dependencies on purpose: `ApiProvider` lists it as
   * an effect dependency, and an identity that changed every render would
   * re-run that effect forever.
   */
  const resetForNewUser = useCallback(() => setS(initial), []);

  const actions = {
    resetForNewUser,
    go: (screen: Screen) => set(st => ({ prev: st.screen, screen, sheet: null })),
    back: () => set(st => ({ screen: st.prev === 'details' || st.prev === 'firstmove' ? 'today' : st.prev, sheet: null })),
    goCapture: () => set(st => ({ prev: st.screen, screen: 'capture', cap: 'idle', input: '', sheet: null })),
    openDetail: (id: string) => set(st => ({ detailId: id, prev: st.screen, screen: 'details' })),
    toggle: (id: string) => set(st => ({
      commitments: st.commitments.map(c => (c.id === id ? { ...c, status: c.status === 'done' ? 'active' : 'done' } : c)),
    })),
    setSelDay: (d: number) => set({ selDay: d }),
    dismissNext: () => set({ nextDismissed: true }),

    // capture
    setInput: (input: string) => set({ input }),
    startListening: () => {
      const key = sRef.current.exampleKey || 'doctor';
      const text = exampleText(key, tRef.current);
      set({ cap: 'listening', input: text, liveWords: 0, exampleKey: key });
      const words = text.split(' ').length;
      for (let i = 1; i <= words; i++) later(() => set(st => (st.cap === 'listening' ? { liveWords: i } : null)), 350 + i * 320);
    },
    stopListening: () => set({ cap: 'transcript' }),
    micDown: () => { holdAt.current = Date.now(); actions.startListening(); },
    micUp: () => { if (Date.now() - holdAt.current > 700) actions.stopListening(); },
    startTyping: () => set({ cap: 'typing', input: '' }),
    useExample: (key: ExampleKey) => set({ exampleKey: key, input: exampleText(key, tRef.current), cap: 'typing' }),
    analyze: () => {
      if (!sRef.current.input.trim()) return;
      set({ cap: 'processing' });
      later(() => {
        const res = analyzeText(sRef.current.input, tRef.current, lang);
        if (res.kind === 'hi') { set({ cap: 'nothing', kind: 'hi' }); return; }
        const needsTime = res.proposals.some(pr => pr.needsTime);
        const ambiguous = res.proposals.some(pr => pr.ambiguous);
        set({
          kind: res.kind, parts: res.parts, proposals: res.proposals,
          screen: 'review', prev: 'capture',
          sheet: needsTime ? 'clarify' : ambiguous ? 'readings' : null,
        });
      }, 1300);
    },
    backToCapture: () => set({ screen: 'capture', cap: 'transcript', sheet: null }),
    closeCapture: () => set({ ...captureReset, sheet: null, screen: 'today' }),

    // review
    setProposalTitle: (id: string, title: string) => set(st => ({ proposals: st.proposals.map(q => (q.id === id ? { ...q, title } : q)) })),
    removeProposal: (id: string) => set(st => ({ proposals: st.proposals.filter(q => q.id !== id) })),
    cycleDay: (id: string) => set(st => ({ proposals: st.proposals.map(q => (q.id === id ? { ...q, day: (q.day + 1) % 7 } : q)) })),
    cycleTime: (id: string) => set(st => ({
      proposals: st.proposals.map(q => (q.id === id ? { ...q, h: q.h == null ? 9 : q.h + 1 > 21 ? 8 : q.h + 1, needsTime: false } : q)),
    })),
    confirm: () => {
      const st0 = sRef.current;
      if (!st0.proposals.length) return;
      const stamp = Date.now();
      const created: Commitment[] = st0.proposals.map((q, i) => ({
        id: `n${stamp}${i}`, title: { ar: q.title, en: q.title }, day: q.day, h: q.h, m: q.m, dur: 60, imp: q.imp, status: 'active',
      }));
      set(st => ({ commitments: [...st.commitments, ...created], savedIds: created.map(c => c.id), screen: 'saved', prev: 'review', undoLeft: 5 }));
      for (let i = 1; i <= 5; i++) later(() => set(st => (st.screen === 'saved' ? { undoLeft: 5 - i } : null)), i * 1000);
    },

    // saved
    undo: () => set(st => ({ commitments: st.commitments.filter(c => !st.savedIds.includes(c.id)), screen: 'review', savedIds: [] })),
    finishSaved: () => set(st => ({ ...captureReset, screen: st.kind === 'study' ? 'firstmove' : 'today', prev: 'saved' })),
    viewSavedDay: () => set(st => {
      // Capture is still on the mock proposals, whose `day` is a seed weekday
      // index; the difference from the seed's today is a real day offset.
      const d = st.proposals[0]?.day ?? TODAY;
      return { ...captureReset, screen: d === TODAY ? 'today' : 'calendar', selDay: Math.max(0, d - TODAY) };
    }),

    // sheets
    closeSheet: () => set({ sheet: null }),
    closeSheetHome: () => set({ sheet: null, screen: 'today' }),
    openReadings: () => set({ sheet: 'readings' }),
    openRearrange: () => set({ sheet: 'rearrange' }),
    pickTime: (h: number) => set(st => ({ proposals: st.proposals.map(q => (q.needsTime ? { ...q, h, m: 0, needsTime: false } : q)), sheet: null })),
    clarifySkip: () => set(st => ({ proposals: st.proposals.map(q => ({ ...q, needsTime: false })), sheet: null })),
    pickReading: (day: number) => set(st => ({ proposals: st.proposals.map(q => (q.ambiguous ? { ...q, day, ambiguous: false } : q)), sheet: null })),

    // details / rearrange
    setStatus: (id: string, status: Status, toast: string) =>
      set(st => ({ commitments: st.commitments.map(c => (c.id === id ? { ...c, status } : c)), sheet: 'toast', toast })),
    intensify: (id: string) =>
      set(st => ({ commitments: st.commitments.map(c => (c.id === id ? { ...c, dur: 30 } : c)), sheet: 'toast', toast: tRef.current.toastIntensify })),
    extend: (id: string) =>
      set(st => ({ commitments: st.commitments.map(c => (c.id === id ? { ...c, day: TODAY + 1, h: 10, m: 0 } : c)), sheet: 'toast', toast: tRef.current.toastExtend })),
    shrink: () => set({ sheet: 'toast', toast: tRef.current.toastShrink }),

    // close-out
    markYesterday: (id: string, res: 'done' | 'later') => set(st => ({ yesterday: st.yesterday.map(q => (q.id === id ? { ...q, res } : q)) })),
    finishCloseout: () => { if (sRef.current.yesterday.every(q => q.res != null)) actions.go('today'); },

    // first move
    setFmMode: (fmMode: 'sessions' | 'twomin') => set({ fmMode }),
    fmAccept: () => set({ nextDismissed: true, screen: 'today', sheet: 'toast', toast: tRef.current.toastFm }),

    // preferences
    // The language picker: System → English → العربية → System. Hebrew is not
    // offered; src/i18n/README.md says what it is still waiting on.
    cycleLanguage: () => applyLangPref(nextLanguagePref(langPref)),
    cycleTheme: () => setThemePref(v => (v === 'system' ? 'light' : v === 'light' ? 'dark' : 'system')),
    // A maybesitter://<screen>?lang=ar link picks a language explicitly, so it
    // stops following the system exactly as tapping the row does.
    setLang: (l: Lang) => applyLangPref(l),
    setThemePref,

    /**
     * Opens a screen or state directly — the design's "jump to a screen or
     * state" list, reachable through maybesitter://<name> links (src/links.ts).
     */
    jump: (name: string) => {
      const tt = tRef.current;
      const review = (text: string) => {
        const res = analyzeText(text, tt, lang);
        return res.kind === 'hi' ? {} : { kind: res.kind, parts: res.parts, proposals: res.proposals, input: text, cap: 'transcript' as CapState, screen: 'review' as Screen, prev: 'capture' as Screen };
      };
      switch (name) {
        // Development only, so a release build cannot reach the gallery.
        case 'gallery': if (__DEV__) set({ screen: 'gallery', sheet: null }); return;
        // Additionally behind an env flag the release guard refuses to let a
        // staging or production build set at all (UC-1.8 #152).
        case 'calendarDemo': if (googleCalendarDemoEnabled()) set({ screen: 'calendarDemo', sheet: null }); return;
        case 'today': case 'calendar': case 'settings': case 'closeout': case 'firstmove':
          set({ screen: name, sheet: null }); return;
        case 'capture': set({ ...captureReset, screen: 'capture', sheet: null }); return;
        case 'typing': set({ screen: 'capture', cap: 'typing', input: tt.exDoctor, sheet: null }); return;
        case 'listening': set({ screen: 'capture', sheet: null, exampleKey: 'doctor' }); actions.startListening(); return;
        case 'processing': set({ screen: 'capture', cap: 'processing', input: tt.exDoctor, sheet: null }); return;
        case 'nothing': set({ screen: 'capture', cap: 'nothing', input: tt.exHi, sheet: null }); return;
        case 'review': set({ ...review(tt.exDoctor), sheet: null }); return;
        case 'clarify': set({ ...review(tt.exReport), sheet: 'clarify' }); return;
        case 'readings': set({ ...review(tt.exSami), sheet: 'readings' }); return;
        case 'saved': {
          const r = analyzeText(tt.exDoctor, tt, lang);
          if (r.kind === 'hi') return;
          const stamp = Date.now();
          const created: Commitment[] = r.proposals.map((q, i) => ({ id: `n${stamp}${i}`, title: { ar: q.title, en: q.title }, day: q.day, h: q.h, m: q.m, dur: 60, imp: q.imp, status: 'active' }));
          set(st => ({ kind: r.kind, parts: r.parts, proposals: r.proposals, commitments: [...st.commitments, ...created], savedIds: created.map(c => c.id), screen: 'saved', prev: 'review', undoLeft: 5, sheet: null }));
          return;
        }
        case 'details': set({ detailId: 'c3', prev: 'today', screen: 'details', sheet: null }); return;
        case 'rearrange': set({ detailId: 'c3', prev: 'today', screen: 'details', sheet: 'rearrange' }); return;
      }
    },
  };

  return { s, t, tr, p, lang, langPref, ar: lang === 'ar', scheme, themePref, actions };
}

export type AppModel = ReturnType<typeof useAppModel>;

const Ctx = createContext<AppModel | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const model = useAppModel();
  return <Ctx.Provider value={model}>{children}</Ctx.Provider>;
}

export function useApp(): AppModel {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
