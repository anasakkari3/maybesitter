/**
 * The capability table is a claim about the product, checked here against the
 * screens that draw it.
 *
 * On the first iPhone run the owner found rows that said "Coming soon" and
 * still opened something unrelated when pressed (WhatsApp opened the generic
 * Add hub), and work that already ships through the Share Sheet — WhatsApp
 * exports, PDFs, photos — labelled as not built yet. Both are the same defect:
 * the badge and the action drifted apart. So every product screen is rendered,
 * with the share flag on and off, and each badge is held to its row:
 *
 *   - a LIVE / AVAILABLE / VIA_SHARE row is an enabled button;
 *   - nothing says "coming soon" at all (last describe): an unbuilt thing is
 *     absent, never badged (council ruling; UAT 2026-09-27, #17).
 */
import React from 'react';
import { Platform } from 'react-native';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import {
  ActionModesScreen, AddToMaybeSitterScreen, GoalExecutionScreen, GoogleIntegrationScreen, HabitDetailScreen,
  IntegrationsScreen, MyMaybeSitterScreen, PatchReviewScreen,
} from '../ControlScreens';
import { CommitmentsScreen, ContextualAssistantScreen, PersonalizationScreen } from '../ContextScreens';
import { BackgroundActivityScreen, WatchBuilderScreen } from '../WatcherScreens';
import { capabilities, capabilityDependsOn, shareCapability, type CapabilityKey } from '../capabilities';

const query = (data: unknown) => () => ({ data, isPending: false, isFetching: false, error: null, refetch: jest.fn() });
const mutation = () => () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null });

jest.mock('../../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'u', email: 'a@b.c', displayName: 'Sami' } }),
  useOptionalAuth: () => ({ user: { uid: 'u', email: 'a@b.c', displayName: 'Sami' } }),
}));
jest.mock('../../../api/queries', () => ({
  useUid: () => 'u',
  useConsents: query({ currentVersions: { personalization: 'v1' }, personalization: null, recommendations: { state: 'granted' } }),
  useSetPersonalizationConsent: mutation(),
  useIntelligenceDecided: () => () => undefined,
  useMemory: query({ items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot', createdAt: '2026-09-20T10:00:00.000Z' }], suggestions: [] }),
  useCreateMemory: mutation(),
  useMemorySuggestion: mutation(),
  useToday: query({ items: [] }),
  useUpcoming: query({ items: [] }),
  useHabits: query([{
    habitId: 'h1', title: 'Walk', status: 'active', cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 30,
    preferredWindows: [], flexibility: 'flexible', recoveryPolicy: 'skip',
  }]),
  useCreateHabit: mutation(),
  useSetHabitStatus: mutation(),
  useDeleteHabit: mutation(),
  usePlan: query(null),
  usePlanAction: mutation(),
  useGenerateGoalExecution: mutation(),
  useGoalExecution: query(null),
  useConfirmGoalSelections: mutation(),
  useRegenerateGoalExecution: mutation(),
  useUnlinkGoalNode: mutation(),
  useCommitment: query(null),
  useTrust: query({ trust: { calendarConsent: false } }),
  // A server with calendar links on; the build flag still decides alone here.
  useIcsFeeds: query({ success: true, feeds: [], deadlines: [] }),
  // The recorded answer of a server with no match data key (closure CL7);
  // a test that needs the key flips `mockFootballConfigured`.
  useFootballSettings: () => ({
    data: { ...require('../../../api/__fixtures__/football.settings.json'), providerConfigured: mockFootballConfigured },
    isPending: false, isFetching: false, error: null, refetch: jest.fn(),
  }),
}));
let mockFootballConfigured = false;
jest.mock('../../google/useGoogle', () => ({
  // Not configured: the state every build is in until the owner adds the
  // OAuth client. The rows' other states are held in googleConnections.test.
  useGoogleStatus: query({
    status: 'not_configured', accountEmail: null, features: { calendar: false, gmail: false, drive: false },
    pickerAvailable: false, connectedAt: null,
  }),
  useGoogleConnect: mutation(),
  useGoogleDisconnect: mutation(),
  useGoogleCalendarSync: mutation(),
  useGmailScan: mutation(),
  useDrivePick: mutation(),
}));
jest.mock('../../capture/CaptureProvider', () => ({ useCaptureFlow: () => ({ adoptProposal: jest.fn() }) }));
jest.mock('../useWatchers', () => ({
  useBackgroundActivity: query({ paused: false, monitors: [] }),
  useBackgroundAttribution: query({ actions: [], orphanCount: 0 }),
  useWatcherAction: mutation(),
  useSetBackgroundActivityPaused: mutation(),
  useCreateReadinessWatcher: mutation(),
  useCreateFootballWatcher: mutation(),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const wrap = (child: React.ReactNode) => (
  <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}</AppProvider></SafeAreaProvider>
);

const SCREENS: Record<string, () => React.JSX.Element> = {
  MyMaybeSitterScreen, IntegrationsScreen, GoogleIntegrationScreen, ActionModesScreen, AddToMaybeSitterScreen,
  PatchReviewScreen, HabitDetailScreen, GoalExecutionScreen,
  PersonalizationScreen, CommitmentsScreen, ContextualAssistantScreen,
  BackgroundActivityScreen, WatchBuilderScreen,
};

type Host = { props: Record<string, any>; parent: Host | null };

/** The nearest enclosing control, if the element sits inside one. */
function enclosingControl(element: Host): Host | null {
  for (let node: Host | null = element.parent; node; node = node.parent) {
    const role = node.props.accessibilityRole ?? node.props.role;
    if (role === 'button' || role === 'link' || typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function') return node;
  }
  return null;
}
const enabled = (node: Host) => node.props.accessibilityState?.disabled !== true && node.props['aria-disabled'] !== true;

const original = process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE;
afterAll(() => { process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = original; });
afterEach(cleanup);

describe.each([['on', 'true'], ['off', '']])('with share intake %s', (_label, flag) => {
  beforeEach(() => { process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = flag; });

  it.each(Object.keys(SCREENS))('%s: every badge matches what its row does', async (name) => {
    const Screen = SCREENS[name]!;
    await render(wrap(<Screen />));

    for (const badge of screen.queryAllByTestId('row-status-COMING_SOON') as unknown as Host[]) {
      expect({ name, soonRowHasAction: enclosingControl(badge) !== null }).toEqual({ name, soonRowHasAction: false });
    }
    for (const status of ['LIVE', 'AVAILABLE', 'VIA_SHARE']) {
      for (const badge of screen.queryAllByTestId(`row-status-${status}`) as unknown as Host[]) {
        const control = enclosingControl(badge);
        expect({ name, status, rowHasAction: control !== null && enabled(control) }).toEqual({ name, status, rowHasAction: true });
      }
    }
    for (const section of screen.queryAllByTestId('product-section-COMING_SOON')) {
      // Not even a disabled one: a greyed-out button still reads as a
      // control, and "Coming soon" already says everything it could.
      const controls = within(section).queryAllByRole('button');
      expect({ name, soonSectionControls: controls.length }).toEqual({ name, soonSectionControls: 0 });
    }
  });
});

describe('the Share Sheet rows', () => {
  afterEach(() => { process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = original; });

  it('WhatsApp explains the export when share intake is on, and goes nowhere else', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = 'true';
    await render(wrap(<IntegrationsScreen />));
    expect(within(screen.getByTestId('integration-whatsapp')).getByTestId('row-status-VIA_SHARE')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('integration-whatsapp'));
    const guide = screen.getByTestId('share-guide-whatsapp');
    // Only the verified path: Export chat → Without media → MaybeSitter. The
    // unverified long-press alternative is gone, and so are the other
    // platform's menus (UAT 2026-09-27, #17: iOS spelled out Android's ⋮).
    // jest-expo's default platform is ios.
    expect(within(guide).getByText(en.xWhatsappStep2Ios)).toBeTruthy();
    expect(within(guide).queryByText(en.xWhatsappStep2Android)).toBeNull();
    expect(within(guide).queryAllByText(/Android|⋮/)).toHaveLength(0);
    expect(within(guide).getByText(en.xWhatsappStep3)).toBeTruthy();
    expect(en.xWhatsappStep3).toMatch(/Without media/);
    expect(within(guide).getAllByLabelText(/^\d\. /)).toHaveLength(3);
    expect(within(guide).queryByText(/long-press/i)).toBeNull();
    expect(Object.keys(en)).not.toContain('xWhatsappGuideOr');
    // Still the integrations page underneath: the row opened the guide, not the Add hub.
    expect(screen.getByTestId('product-integrations')).toBeTruthy();
    expect(screen.queryByTestId('product-add')).toBeNull();
    await fireEvent.press(within(guide).getByTestId('share-guide-close'));
    expect(screen.queryByTestId('share-guide-whatsapp')).toBeNull();
  });

  it('WhatsApp shows only Android\'s steps on Android, in every language', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = 'true';
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await render(wrap(<IntegrationsScreen />));
      await fireEvent.press(screen.getByTestId('integration-whatsapp'));
      const guide = screen.getByTestId('share-guide-whatsapp');
      const shown = [en, ar, he].filter(t => within(guide).queryAllByText(t.xWhatsappStep2Android).length > 0);
      expect(shown).toHaveLength(1);
      for (const t of [en, ar, he]) expect(within(guide).queryAllByText(t.xWhatsappStep2Ios)).toHaveLength(0);
      expect(within(guide).queryAllByText(/iPhone|آيفون|אייפון/)).toHaveLength(0);
      expect(within(guide).getAllByLabelText(/^\d\. /)).toHaveLength(3);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  it('each platform\'s step names only its own menus, in all three languages', () => {
    expect(en.xWhatsappStep2Android).toMatch(/⋮ → More → Export chat/);
    for (const t of [en, ar, he] as unknown as Record<string, string>[]) {
      expect(t.xWhatsappStep2Ios).not.toMatch(/⋮|Android|أندرويد|אנדרואיד/);
      expect(t.xWhatsappStep2Android).not.toMatch(/iPhone|آيفون|אייפון/);
      expect(Object.keys(t)).not.toContain('xWhatsappStep2');
    }
  });

  it('WhatsApp, files and photos are absent — not «قريبًا» — when share intake is off', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = '';
    await render(wrap(<IntegrationsScreen />));
    expect(screen.queryByTestId('integration-whatsapp')).toBeNull();
    expect(screen.queryAllByText(/WhatsApp/)).toHaveLength(0);
    await cleanup();
    await render(wrap(<AddToMaybeSitterScreen />));
    for (const id of ['add-whatsapp', 'add-pdf', 'add-photos']) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByText(en.xShareGuide)).toBeNull();
  });

  it('files and photos open the one-line share guide on the Add page', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = 'true';
    await render(wrap(<AddToMaybeSitterScreen />));
    await fireEvent.press(screen.getByTestId('add-pdf'));
    expect(within(screen.getByTestId('share-guide-files')).getByText(en.xFilesStep1)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('share-guide-close'));
    await fireEvent.press(screen.getByTestId('add-photos'));
    expect(screen.getByTestId('share-guide-files')).toBeTruthy();
  });
});

describe('the capability table', () => {
  const repo = join(__dirname, '../../../../..');
  const keys = [...Object.keys(capabilities), 'whatsapp', 'files', 'photos'] as CapabilityKey[];

  it('names what each capability depends on, for every key', () => {
    expect(Object.keys(capabilityDependsOn).sort()).toEqual([...keys].sort());
  });

  it('declares only server routes that exist', () => {
    for (const key of keys) {
      const api = capabilityDependsOn[key].api;
      if (api === null) continue;
      expect({ key, exists: existsSync(join(repo, 'src/app', api, 'route.ts')) }).toEqual({ key, exists: true });
    }
  });

  it('lists only what is built: every capability has a screen and a route', () => {
    // Nothing unbuilt is listed at all (council: COMING_SOON = FAIL). A
    // capability that is not built is absent from this table, not badged.
    for (const key of keys) {
      const dependency = capabilityDependsOn[key];
      expect({ key, api: dependency.api !== null, screen: dependency.screen !== null }).toEqual({ key, api: true, screen: true });
    }
    expect(keys).not.toContain('camera');
  });

  it('the share capability is shipped when switched on and absent when off — never "soon"', () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = 'true';
    expect(shareCapability()).toBe('VIA_SHARE');
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = '';
    expect(shareCapability()).toBeNull();
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = original;
  });
});

describe('what the product does not promise', () => {
  // «حضّرني» shipped (CL5a) and its "coordination with others" row did not:
  // acting on other people's behalf is outside the approved strategy, not a
  // missing credential (council verdict 2026-09-26, item 5). Removed, not
  // relabelled — a Coming-soon badge on it would still be the promise.
  it('no coordination row or string, in any of the three languages', async () => {
    for (const bundle of [en, ar, he] as unknown as Record<string, unknown>[]) {
      expect(Object.keys(bundle)).not.toContain('xCoordination');
      expect(Object.values(bundle).filter((value) => /coordinat|تنسيق|תיאום/i.test(String(value)))).toEqual([]);
    }
    await render(wrap(<AddToMaybeSitterScreen />));
    expect(screen.queryByText(/coordinat/i)).toBeNull();
  });
});

describe('«مايبي سيتر إلي» says «قريبًا» nowhere (UAT 2026-09-27, #17; council: COMING_SOON = FAIL)', () => {
  // «أسلوب الحكي» and «اسم المساعد» were a Coming-soon section with nothing
  // built behind them. Removed, not relabelled: any «قريبًا» here is red.
  it('has no Coming-soon badge, section or word in any language', async () => {
    await render(wrap(<MyMaybeSitterScreen />));
    for (const id of ['row-status-COMING_SOON', 'section-status-COMING_SOON', 'product-section-COMING_SOON', 'availability-COMING_SOON']) {
      expect({ id, count: screen.queryAllByTestId(id).length }).toEqual({ id, count: 0 });
    }
    expect(screen.queryAllByText(/Coming soon|قريبًا|בקרוב/).length).toBe(0);
  });

  it('keeps no personality or assistant-name capability, row or string', () => {
    expect(Object.keys(capabilities)).not.toContain('assistantPersonality');
    expect(Object.keys(capabilities)).not.toContain('assistantName');
    for (const bundle of [en, ar, he] as unknown as Record<string, unknown>[]) {
      expect(Object.keys(bundle)).not.toContain('xPersonality');
      expect(Object.keys(bundle)).not.toContain('xAssistantName');
    }
  });
});

describe('the watcher screens say «قريبًا» nowhere (council ruling: COMING_SOON = FAIL, closure CL7)', () => {
  // A row another lane owns and turns LIVE at integration. Location was the
  // only one (CL4's `explore-location`); it is LIVE now, so nothing is exempt
  // and any «قريبًا» on these screens is a failure.
  const OWNED_BY_ANOTHER_LANE: string[] = [];
  const soonBadges = () => ['row-status-COMING_SOON', 'section-status-COMING_SOON', 'availability-COMING_SOON']
    .flatMap(id => screen.queryAllByTestId(id) as unknown as Host[]);
  const rowOf = (badge: Host) => {
    for (let node: Host | null = badge.parent; node; node = node.parent) {
      if (typeof node.props.testID === 'string' && !/COMING_SOON/.test(node.props.testID)) return node.props.testID as string;
    }
    return null;
  };

  afterEach(() => { mockFootballConfigured = false; });

  const WATCHER_SCREENS: [string, () => React.JSX.Element, boolean][] = [
    ['BackgroundActivityScreen', BackgroundActivityScreen, false], ['BackgroundActivityScreen', BackgroundActivityScreen, true],
    ['WatchBuilderScreen', WatchBuilderScreen, false], ['WatchBuilderScreen', WatchBuilderScreen, true],
  ];
  it.each(WATCHER_SCREENS)('%s has no COMING_SOON row but the ones another lane owns (football key: %s)', async (_name, Screen, configured) => {
    mockFootballConfigured = configured;
    await render(wrap(<Screen />));
    const rows = soonBadges().map(rowOf);
    expect(rows.filter(row => row === null || !OWNED_BY_ANOTHER_LANE.includes(row))).toEqual([]);
    // No «قريبًا» drawn outside a badge either.
    const soonWords = screen.queryAllByText(/Coming soon|قريبًا|בקרוב/).length;
    expect(soonWords).toBe(rows.length);
    // WHOOP and Notion have no provider and no owner approval: absent, not labelled.
    expect(screen.queryAllByText(/WHOOP|Notion/i)).toHaveLength(0);
  });
});

describe('flights and parcels (council ruling, closure CL7)', () => {
  // Removed until the owner approves a provider and its price — not
  // "coming soon", not "in progress": absent.
  const FLIGHT_OR_PARCEL = /flight|parcel|package|رحلة طيران|طرد|شحن|טיסה|חבילה|משלוח/i;
  const ics = process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
  afterEach(() => {
    mockFootballConfigured = false;
    if (ics === undefined) delete process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
    else process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = ics;
  });

  it('have no copy left in any language', () => {
    for (const [name, locale] of [['en', en], ['ar', ar], ['he', he]] as const) {
      const keys = Object.keys(locale).filter(key => /^x(Flight|Package|FlightDelay|Gate|Departure|Cancelled|Delivery)$/.test(key));
      expect({ name, keys }).toEqual({ name, keys: [] });
      const values = Object.entries(locale).filter(([key, value]) => key.startsWith('x') && typeof value === 'string' && FLIGHT_OR_PARCEL.test(value)).map(([key]) => key);
      expect({ name, values }).toEqual({ name, values: [] });
    }
  });

  it.each(Object.keys(SCREENS))('%s offers neither', async (name) => {
    const Screen = SCREENS[name]!;
    await render(wrap(<Screen />));
    expect(screen.queryAllByText(FLIGHT_OR_PARCEL)).toHaveLength(0);
  });

  it('the Sources row is hidden when there is nothing behind it, and shown once football is set up', async () => {
    process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = '';
    await render(wrap(<IntegrationsScreen />));
    expect(screen.queryByTestId('integration-sources')).toBeNull();
    await cleanup();
    mockFootballConfigured = true;
    await render(wrap(<IntegrationsScreen />));
    expect(screen.getByTestId('integration-sources')).toBeTruthy();
  });
});

describe('no reachable screen says «قريبًا» (council: COMING_SOON = FAIL; UAT 2026-09-27, #17)', () => {
  /**
   * Three guards, because each alone has a hole:
   *  - the source: no file outside tests names a COMING_SOON status, so no
   *    screen — including one this file does not render — can draw the badge;
   *  - the copy: no string in any language says "coming soon", so no screen
   *    can say it in words either;
   *  - the render: every product screen, under every build switch that used
   *    to turn a row into «قريبًا», draws neither.
   */
  const SRC = join(__dirname, '../../..');
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === '__fixtures__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

  it('no source file names a COMING_SOON status', () => {
    const hits = sources(SRC).filter(file => readFileSync(file, 'utf8').includes('COMING_SOON')).map(file => file.slice(SRC.length));
    expect(hits).toEqual([]);
  });

  // Hebrew «בקרוב» is also plain "soon" (starts soon, try again soon). These
  // keys use it that way; a string that promises a feature is not among them.
  const TEMPORAL_HE = new Set(['notifHardTitle', 'xPrepareTooSoon', 'googleGmailPartial', 'googleGmailNotRead', 'googleErrUnavailable']);
  // Arabic as a whole word: «تقريباً» ("about") contains «قريباً».
  const SOON: Record<string, RegExp> = {
    en: /coming soon|(not|n't) available yet|in a future/i,
    ar: /(?<![\u0621-\u064A])قريب(ًا|اً)|لسا مش متاح|لسّا مش متاح/,
    he: /בקרוב|תגיע בהמשך|עדיין לא זמין/,
  };

  it('no string in any language promises something later', () => {
    for (const [name, bundle] of [['en', en], ['ar', ar], ['he', he]] as const) {
      const hits = Object.entries(bundle as Record<string, unknown>)
        .filter(([key, value]) => typeof value === 'string' && SOON[name]!.test(value) && !(name === 'he' && TEMPORAL_HE.has(key)))
        .map(([key]) => key);
      expect({ name, hits }).toEqual({ name, hits: [] });
      for (const key of ['xSoon', 'xCamera', 'xOccurrences', 'xPatchFuture', 'xHabitPreview', 'xPreview', 'xPreviewBody']) {
        expect({ name, key, present: key in bundle }).toEqual({ name, key, present: false });
      }
    }
  });

  /**
   * Review round 2 (I-2): "not … yet" is the same promise in other words —
   * «لسّا مش مشغّلة», "isn't switched on yet", «עדיין לא». These patterns
   * catch it. The keys below use "yet" about the user's own state (they have
   * not done, decided, allowed or saved something), never about the product
   * gaining a feature, and each says why.
   */
  const YET: Record<string, RegExp> = {
    ar: /(لسّا|لسا)\s+مش|(لسّا|لسا)\s+ما\s+بي|مش[^.،]*\sبعد/,
    en: /(\bnot\b|\bcannot\b|n['’]t\b)[^.]*\byet\b/i,
    he: /עדיין\s+(לא|אינ)|עוד\s+לא/,
  };
  const USER_STATE_YET: Record<string, string> = {
    suggestionNote: 'nothing changes until the user confirms',
    notYet: 'the «لسّا» answer: the user has not done the item',
    memorySureNot: "the user's own answer: not sure",
    seedsNotCommitment: 'the user has not made this a commitment',
    seedsLede: 'things the user has not decided on',
    financialBandUnknown: "not enough of the user's own data",
    notifAllowBody: "the phone's permission, the user's to grant",
    obAboutReviewLede: 'nothing is saved until the user ticks it',
    activityWeekDone: "a count of the user's own activity",
    settingsKnowsSub: "a count of the user's own saved memory",
    readinessNoCheckIn: 'the user has not checked in',
    memoryWhyDeferNoPlanUse: "the user's plan does not use this memory",
    planOfflineCold: "today's plan has not arrived (no network)",
    planReasonNoLength: "the item's length is not known",
    planRowProposalSub: 'the proposal is not saved until the user accepts',
  };

  it('no string promises a feature "yet" — only the user\'s own state may be "not yet"', () => {
    for (const [name, bundle] of [['en', en], ['ar', ar], ['he', he]] as const) {
      const hits = Object.entries(bundle as Record<string, unknown>)
        .filter(([key, value]) => typeof value === 'string' && YET[name]!.test(value) && !(key in USER_STATE_YET))
        .map(([key]) => key);
      expect({ name, hits }).toEqual({ name, hits: [] });
      expect({ name, xGoalPreview: 'xGoalPreview' in bundle }).toEqual({ name, xGoalPreview: false });
    }
  });

  // Review round 2 (I-3): a server- or build-side switch, never a user's. The
  // line must not send anyone looking for a toggle they do not have.
  it('the feature-unavailable line names no switch', () => {
    expect([en.errorsFeatureDisabled, ar.errorsFeatureDisabled, he.errorsFeatureDisabled])
      .toEqual(["This feature isn't available.", 'هاي الميزة مش متاحة.', 'התכונה הזו לא זמינה.']);
  });

  const BUILDS: [string, Record<string, string>][] = [
    ['share off, calendar off', { EXPO_PUBLIC_FEATURE_SHARE_INTAKE: '', EXPO_PUBLIC_FEATURE_CALENDAR_READ: 'false', EXPO_PUBLIC_FEATURE_CALENDAR_WRITE: '' }],
    ['share on, calendar read', { EXPO_PUBLIC_FEATURE_SHARE_INTAKE: 'true', EXPO_PUBLIC_FEATURE_CALENDAR_READ: '', EXPO_PUBLIC_FEATURE_CALENDAR_WRITE: '' }],
    ['share on, calendar write only', { EXPO_PUBLIC_FEATURE_SHARE_INTAKE: 'true', EXPO_PUBLIC_FEATURE_CALENDAR_READ: 'false', EXPO_PUBLIC_FEATURE_CALENDAR_WRITE: 'true' }],
  ];
  const saved = Object.fromEntries(Object.keys(BUILDS[0]![1]).map(key => [key, process.env[key]]));
  afterEach(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  const cases = BUILDS.flatMap(([build], index) => Object.keys(SCREENS).map(name => [`${build} · ${name}`, index, name] as const));
  it.each(cases)('%s draws no «قريبًا»', async (_label, index, name) => {
    Object.assign(process.env, BUILDS[index]![1]);
    const Screen = SCREENS[name]!;
    await render(wrap(<Screen />));
    // A render that mounted nothing would pass everything below.
    expect(screen.queryAllByTestId(/^product-/).length).toBeGreaterThan(0);
    expect({ name, badges: screen.queryAllByTestId(/COMING_SOON/).length }).toEqual({ name, badges: 0 });
    expect({ name, words: screen.queryAllByText(/قريبًا|قريباً|coming soon|בקרוב/i).length }).toEqual({ name, words: 0 });
  });

  it('the device calendar row is absent, not «قريبًا», when calendar access is switched off', async () => {
    Object.assign(process.env, BUILDS[0]![1]);
    await render(wrap(<IntegrationsScreen />));
    expect(screen.getByTestId('product-integrations')).toBeTruthy();
    expect(screen.queryByTestId('integration-device')).toBeNull();
  });
});
