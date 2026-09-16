import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useColorScheme } from 'react-native';
import { strings, type Lang, type Strings } from '../i18n/strings';
import { setLocale, tFor } from '../i18n';
import { isRtl, scriptFor } from '../i18n/locale';
import type { Script } from '../theme/fonts';
import {
  loadLanguagePrefState, nextLanguagePref, resolveLanguage, saveLanguagePref, systemLanguageTag,
  type LanguagePref, type SelectableLocale,
} from '../i18n/language';
import { googleCalendarDemoEnabled } from '../config/env';
import { loadThemePref, saveThemePref } from '../lib/deviceSettings/theme';
import { palettes, type Palette, type Scheme } from '../theme/tokens';
import { seedCommitments, seedYesterday, TODAY } from './seed';
import type { Commitment, Screen, Sheet, Status, ThemePref, YesterdayItem } from './types';
import type { CaptureInputMode, CaptureSource } from '../features/capture/captureMachine';

export type AppState = {
  screen: Screen;
  prev: Screen;
  /**
   * Capture holds none of its state here any more (UC-2.R2, #172).
   *
   * The draft, the proposal, the selection and the undo window live in
   * `CaptureProvider`'s reducer, mounted inside `Root`. That is deliberate: the
   * draft is the most sensitive text the product handles, and keeping it in the
   * app-wide store gave it the app's lifetime instead of the flow's. Signing
   * out unmounts `Root`, so it goes with it.
   */
  /** How capture was entered, for the flow to pick up on mount (#172). */
  captureSource: CaptureSource;
  captureInput: CaptureInputMode;
  sheet: Sheet;
  toast: string;
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
  /** The `YYYY-MM-DD` the plan screen is showing, or null when it is closed. */
  planDate: string | null;
  commitments: Commitment[];
  yesterday: YesterdayItem[];
};

const initial: AppState = {
  screen: 'today', prev: 'today',
  captureSource: 'tab', captureInput: 'text',
  sheet: null, toast: '',
  nextDismissed: false, fmMode: 'sessions', selDay: 0, detailId: null, planDate: null,
  commitments: seedCommitments, yesterday: seedYesterday,
};

function useAppModel() {
  const [s, setS] = useState<AppState>(initial);
  // The stored choice (System / English / العربية / עברית) and the language it resolves
  // to. The device tag is read once: changing the phone's language restarts the
  // app anyway, and re-reading it every render is a native call for nothing.
  const [langPref, setLangPref] = useState<LanguagePref>('system');
  // Whether a language was ever chosen, null until the store has answered
  // (#469). `LanguageGate` asks the question while this is false; `'system'`
  // alone cannot say, because it is also what a fresh install resolves to.
  const [langChosen, setLangChosen] = useState<boolean | null>(null);
  const systemTag = useMemo(() => systemLanguageTag(), []);
  const lang: Lang = resolveLanguage(langPref, systemTag);
  // Direction and alphabet are two questions, not one. See the fields below.
  const rtl = isRtl(lang);
  const script = scriptFor(lang);
  const rtlScript: Script | false = rtl ? script : false;
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
    void loadLanguagePrefState().then(({ pref, chosen }) => {
      if (!active) return;
      setLangPref(pref);
      setLangChosen(chosen);
    });
    // The same hydration for the scheme (#155). Both start at 'system', which
    // resolves to what the device already says, so the frame before either
    // read lands is the right answer for anyone who never overrode it — and a
    // wrong scheme for one frame is a flash, not a wrong word on a screen.
    void loadThemePref().then(pref => { if (active) setThemePref(pref); });
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

  // Every route that changes the scheme goes through here, so none of them can
  // be the one that forgets to write it down.
  const applyThemePref = (pref: ThemePref) => {
    setThemePref(pref);
    void saveThemePref(pref);
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
    openDetail: (id: string) => set(st => ({ detailId: id, prev: st.screen, screen: 'details' })),
    /**
     * Today's plan, for one named date (UC-3.10b, #195).
     *
     * The date is always passed in, never defaulted here: it arrives from a
     * `maybesitter://plan/<date>` link, which `src/links.ts` has already
     * checked is a plain `YYYY-MM-DD`.
     */
    openPlan: (date: string) => set(st => ({ planDate: date, prev: st.screen, screen: 'plan', sheet: null })),
    toggle: (id: string) => set(st => ({
      commitments: st.commitments.map(c => (c.id === id ? { ...c, status: c.status === 'done' ? 'active' : 'done' } : c)),
    })),
    setSelDay: (d: number) => set({ selDay: d }),
    dismissNext: () => set({ nextDismissed: true }),

    /**
     * Enter the capture flow (UC-2.R2, #172).
     *
     * `source` is recorded so a widget or share entry is distinguishable from a
     * tab tap, and `inputMode` so `input=voice` can focus the mic. The flow's
     * own reducer picks both up on mount; nothing about the draft is stored
     * here.
     */
    goCapture: (source: CaptureSource = 'tab', inputMode: CaptureInputMode = 'text') =>
      set(st => ({ prev: st.screen, screen: 'capture', captureSource: source, captureInput: inputMode, sheet: null })),
    closeCapture: () => set({ sheet: null, screen: 'today' }),

    // sheets
    closeSheet: () => set({ sheet: null }),
    closeSheetHome: () => set({ sheet: null, screen: 'today' }),
    openPostpone: () => set({ sheet: 'postpone' }),
    openEdit: () => set({ sheet: 'edit' }),
    openConfirmDrop: () => set({ sheet: 'confirmDrop' }),
    openConfirmDelete: () => set({ sheet: 'confirmDelete' }),
    /** Sheet-as-toast, the design's confirmation for a write that succeeded. */
    toast: (message: string) => set({ sheet: 'toast', toast: message }),

    // details
    setStatus: (id: string, status: Status, toast: string) =>
      set(st => ({ commitments: st.commitments.map(c => (c.id === id ? { ...c, status } : c)), sheet: 'toast', toast })),

    // close-out
    markYesterday: (id: string, res: 'done' | 'later') => set(st => ({ yesterday: st.yesterday.map(q => (q.id === id ? { ...q, res } : q)) })),
    finishCloseout: () => { if (sRef.current.yesterday.every(q => q.res != null)) actions.go('today'); },

    // first move
    setFmMode: (fmMode: 'sessions' | 'twomin') => set({ fmMode }),
    fmAccept: () => set({ nextDismissed: true, screen: 'today', sheet: 'toast', toast: tRef.current.toastFm }),

    // preferences
    // The language picker: System → English → العربية → עברית → System.
    cycleLanguage: () => applyLangPref(nextLanguagePref(langPref)),
    cycleTheme: () =>
      applyThemePref(themePref === 'system' ? 'light' : themePref === 'light' ? 'dark' : 'system'),
    // A maybesitter://<screen>?lang=ar link picks a language explicitly, so it
    // stops following the system exactly as tapping the row does.
    setLang: (l: Lang) => applyLangPref(l),
    // The language screen's Continue (#469). `applyLangPref` writes the key,
    // which is what makes the choice durable: the next launch finds it stored.
    chooseLanguage: (locale: SelectableLocale) => { applyLangPref(locale); setLangChosen(true); },
    setThemePref: applyThemePref,

    /**
     * Opens a screen or state directly — the design's "jump to a screen or
     * state" list, reachable through maybesitter://<name> links (src/links.ts).
     */
    jump: (name: string) => {
      switch (name) {
        // Development only, so a release build cannot reach the gallery.
        case 'gallery': if (__DEV__) set({ screen: 'gallery', sheet: null }); return;
        // Additionally behind an env flag the release guard refuses to let a
        // staging or production build set at all (UC-1.8 #152).
        case 'calendarDemo': if (googleCalendarDemoEnabled()) set({ screen: 'calendarDemo', sheet: null }); return;
        case 'today': case 'calendar': case 'settings': case 'closeout': case 'firstmove':
          set({ screen: name, sheet: null }); return;
        // Capture has one entry now. The gallery's old `typing`, `listening`,
        // `processing`, `nothing`, `review`, `clarify`, `readings` and `saved`
        // jumps each forced a mock sub-state directly; those states are the
        // reducer's and are reached by using the flow (UC-2.R2, #172).
        case 'capture': set({ screen: 'capture', captureSource: 'tab', captureInput: 'text', sheet: null }); return;
        case 'details': set({ detailId: 'c3', prev: 'today', screen: 'details', sheet: null }); return;
        case 'postpone': set({ detailId: 'c3', prev: 'today', screen: 'details', sheet: 'postpone' }); return;
      }
    },
  };

  return {
    s, t, tr, p, lang, langPref, langChosen, scheme, themePref, actions,
    /**
     * Which way the UI reads. Arabic and Hebrew both go right to left; `Root`
     * is the single place that acts on it (`direction` on the root view).
     */
    rtl,
    /**
     * Which alphabet to set text in: 'latin' | 'arabic' | 'hebrew'. Separate
     * from `rtl` because Hebrew shares Arabic's direction and none of its
     * glyphs — see `src/theme/fonts.ts`.
     */
    script,
    /**
     * The RTL script, or `false` when the UI reads left to right.
     *
     * This used to be `lang === 'ar'`, from when the app had two languages and
     * "is it Arabic" answered three different questions at once — direction,
     * alignment and font. Widening `Lang` made it wrong for all three, and
     * `false | Script` is the shape that keeps every existing spelling of those
     * questions correct without a cast: `ar ? 'rtl' : 'ltr'` and
     * `ar ? 'right' : 'left'` still read as before, and `family(400, ar)` now
     * resolves to Noto Sans Hebrew in Hebrew instead of to a Latin face with no
     * Hebrew glyphs in it.
     *
     * New code should read `rtl` and `script`, which say what they mean. The
     * one file still on this name is `src/screens/Sheets.tsx`, which is owned
     * by another change in flight; it is correct in all three languages as it
     * stands, and the field goes when its last reader does.
     */
    ar: rtlScript,
  };
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
