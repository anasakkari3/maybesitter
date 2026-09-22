import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useColorScheme } from 'react-native';
import { strings, type Lang, type Strings } from '../i18n/strings';
import { setLocale, tFor } from '../i18n';
import { isRtl, scriptFor } from '../i18n/locale';
import type { Script } from '../theme/fonts';
import {
  loadLanguagePref, nextLanguagePref, resolveLanguage, saveLanguagePref, systemLanguageTag, type LanguagePref,
} from '../i18n/language';
import { googleCalendarDemoEnabled } from '../config/env';
import { loadThemePref, saveThemePref } from '../lib/deviceSettings/theme';
import { palettes, type Palette, type Scheme } from '../theme/tokens';
import { seedCommitments, TODAY } from './seed';
import type { Commitment, Screen, Sheet, Status, ThemePref, Toast } from './types';
import * as nav from './navigation';
import type { CaptureInputMode, CaptureSource } from '../features/capture/captureMachine';

export type AppState = {
  /**
   * The navigation history (Round 2, Phase B): a tab, a stack per tab, and
   * an optional task over it. See src/state/navigation.ts. `screen`,
   * `detailId` and `planDate` below are *derived* from it after every
   * change, so the screens keep reading the fields they always read.
   */
  nav: nav.Nav;
  screen: Screen;
  /** Whether the tab bar is showing: no task open and the current tab at its root. */
  showTabs: boolean;
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
  toast: Toast | null;
  nextDismissed: boolean;
  /**
   * Which day of the week strip is open, as an offset from today (0 = today).
   *
   * Was a weekday index into the seed week (UC-2.R3, #173). The strip now runs
   * forward from today, so a fixed index would mean a different day depending
   * on what day it is.
   */
  selDay: number;
  /** Derived from `nav`: the commitment the top entry was opened for. */
  detailId: string | null;
  /** Derived from `nav`: the `YYYY-MM-DD` the plan screen is showing, or null when it is closed. */
  planDate: string | null;
  commitments: Commitment[];
};

/** Recompute the three derived fields from the history. Every nav change goes through here. */
function withNav(st: AppState, next: nav.Nav): AppState {
  const d = nav.derive(next);
  return { ...st, nav: next, screen: d.screen, detailId: d.detailId, planDate: d.planDate, showTabs: d.showTabs };
}

const initial: AppState = {
  nav: nav.initialNav, screen: 'today', showTabs: true,
  captureSource: 'tab', captureInput: 'text',
  sheet: null, toast: null,
  nextDismissed: false, selDay: 0, detailId: null, planDate: null,
  commitments: seedCommitments,
};

function useAppModel() {
  const [s, setS] = useState<AppState>(initial);
  // The stored choice (System / English / العربية / עברית) and the language it resolves
  // to. The device tag is read once: changing the phone's language restarts the
  // app anyway, and re-reading it every render is a native call for nothing.
  const [langPref, setLangPref] = useState<LanguagePref>('system');
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
    void loadLanguagePref().then(pref => { if (active) setLangPref(pref); });
    // The same hydration for the scheme (#155). Both start at 'system', which
    // resolves to what the device already says, so the frame before either
    // read lands is the right answer for anyone who never overrode it — and a
    // wrong scheme for one frame is a flash, not a wrong word on a screen.
    void loadThemePref().then(pref => { if (active) setThemePref(pref); });
    return () => { active = false; };
  }, []);
  useEffect(() => { void setLocale(lang); }, [lang]);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };
  const set = (patch: Partial<AppState> | ((st: AppState) => Partial<AppState> | null)) =>
    setS(st => {
      const next = typeof patch === 'function' ? patch(st) : patch;
      return next ? { ...st, ...next } : st;
    });
  /** Apply a pure navigation step and re-derive what is on screen. Sheets close on every move. */
  const move = (step: (n: nav.Nav) => nav.Nav, extra?: Partial<AppState>) =>
    setS(st => ({ ...withNav(st, step(st.nav)), sheet: null, ...(extra ?? {}) }));
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
    /** A tab switches, a task opens, anything else is pushed onto the current tab. */
    go: (screen: Screen) => move(n => nav.go(n, screen)),
    /** One step back through the history. At a tab root this is a no-op; `canGoBack` says so. */
    back: () => move(nav.back),
    canGoBack: () => nav.canGoBack(s.nav),
    openDetail: (id: string) => move(n => nav.push(n, { name: 'details', detailId: id })),
    /** A commitment opened from outside — a notification or a link — with Today underneath. */
    arriveAtDetail: (id: string) => move(n => nav.arrive(n, { name: 'details', detailId: id })),
    /**
     * Today's plan, for one named date (UC-3.10b, #195).
     *
     * The date is always passed in, never defaulted here: it arrives from a
     * `maybesitter://plan/<date>` link, which `src/links.ts` has already
     * checked is a plain `YYYY-MM-DD`.
     */
    openPlan: (date: string) => move(n => nav.push(n, { name: 'plan', planDate: date })),
    /**
     * The plan opened from the morning notification or a link: the plan, with
     * Today underneath and nothing else, so back is Today (UC-3.10b, #195).
     */
    arriveAtPlan: (date: string) => move(n => nav.arrive(n, { name: 'plan', planDate: date })),
    /** A tab or task named by a link. */
    arriveAt: (screen: Screen) => move(n => nav.arrive(n, { name: screen })),
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
      move(n => nav.openTask(n, { name: 'capture' }), { captureSource: source, captureInput: inputMode }),
    /** Leave the flow. The tab underneath is exactly as it was. */
    closeCapture: () => move(nav.closeTask),

    // sheets
    closeSheet: () => set({ sheet: null }),
    /** Close the sheet and return to Today's root — the calm landing after a write. */
    closeSheetHome: () => move(n => nav.switchTab(n, 'today')),
    openPostpone: () => set({ sheet: 'postpone' }),
    openEdit: () => set({ sheet: 'edit' }),
    openConfirmDrop: () => set({ sheet: 'confirmDrop' }),
    openConfirmDelete: () => set({ sheet: 'confirmDelete' }),
    /**
     * The calm confirmation of a write that worked (Round 2): a line at the
     * bottom that fades on its own, carrying undo when the write can be
     * taken back. It replaces Round 1's blocking OK sheet.
     */
    toast: (message: string, undo?: () => void) => set({ toast: { id: Date.now(), text: message, undo } }),
    dismissToast: (id: number) => set(st => (st.toast?.id === id ? { toast: null } : null)),

    // details
    setStatus: (id: string, status: Status, toast: string) =>
      set(st => ({ commitments: st.commitments.map(c => (c.id === id ? { ...c, status } : c)), toast: { id: Date.now(), text: toast } })),

    // preferences
    // The language picker: System → English → العربية → עברית → System.
    cycleLanguage: () => applyLangPref(nextLanguagePref(langPref)),
    cycleTheme: () =>
      applyThemePref(themePref === 'system' ? 'light' : themePref === 'light' ? 'dark' : 'system'),
    // A maybesitter://<screen>?lang=ar link picks a language explicitly, so it
    // stops following the system exactly as tapping the row does.
    setLang: (l: Lang) => applyLangPref(l),
    /** The picker's answer, including "system" (Round 2). */
    setLangPref: (pref: LanguagePref) => applyLangPref(pref),
    setThemePref: applyThemePref,

    /**
     * Opens a screen or state directly — the design's "jump to a screen or
     * state" list, reachable through maybesitter://<name> links (src/links.ts).
     */
    jump: (name: string) => {
      switch (name) {
        // Development only, so a release build cannot reach the gallery.
        case 'gallery': if (__DEV__) move(n => nav.arrive(n, { name: 'gallery' })); return;
        // Additionally behind an env flag the release guard refuses to let a
        // staging or production build set at all (UC-1.8 #152).
        case 'calendarDemo': if (googleCalendarDemoEnabled()) move(n => nav.arrive(n, { name: 'calendarDemo' })); return;
        case 'today': case 'calendar': case 'settings':
          move(n => nav.arrive(n, { name })); return;
        // Capture has one entry now. The gallery's old `typing`, `listening`,
        // `processing`, `nothing`, `review`, `clarify`, `readings` and `saved`
        // jumps each forced a mock sub-state directly; those states are the
        // reducer's and are reached by using the flow (UC-2.R2, #172).
        case 'capture': move(n => nav.arrive(n, { name: 'capture' }), { captureSource: 'tab', captureInput: 'text' }); return;
        case 'details': move(n => nav.arrive(n, { name: 'details', detailId: 'c3' })); return;
        case 'postpone': move(n => nav.arrive(n, { name: 'details', detailId: 'c3' }), { sheet: 'postpone' }); return;
      }
    },
  };

  return {
    s, t, tr, p, lang, langPref, scheme, themePref, actions,
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
