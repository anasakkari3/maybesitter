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
 *   - a COMING_SOON row is not a button and has nothing to press;
 *   - a COMING_SOON section holds no control at all, not even a disabled one;
 *   - a LIVE / AVAILABLE / VIA_SHARE row is an enabled button.
 *
 * A later lane that builds Gmail, export, Drive… flips the status in
 * `capabilities.ts`, and this file then fails until that row has an action.
 */
import React from 'react';
import { existsSync } from 'node:fs';
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
}));
jest.mock('../../../api/queries', () => ({
  useUid: () => 'u',
  useConsents: query({ currentVersions: { personalization: 'v1' }, personalization: null }),
  useSetPersonalizationConsent: mutation(),
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
  useAiConsentGranted: () => ({ granted: false, asked: false, loading: false }),
  useTrust: query({ trust: { calendarConsent: false } }),
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
    // Only the verified path: Export chat → Without media → MaybeSitter, with
    // the Android "More" hop. The unverified long-press alternative is gone.
    expect(within(guide).getByText(en.xWhatsappStep2)).toBeTruthy();
    expect(en.xWhatsappStep2).toMatch(/⋮ → More → Export chat/);
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

  it('WhatsApp is Coming soon and not pressable when share intake is off', async () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = '';
    await render(wrap(<IntegrationsScreen />));
    const row = screen.getByTestId('integration-whatsapp');
    expect(within(row).getByTestId('row-status-COMING_SOON')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /WhatsApp/ })).toBeNull();
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
  const status = (key: CapabilityKey) => (key in capabilities ? capabilities[key as keyof typeof capabilities] : shareCapability());

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

  it('marks something shipped only when it has a route, and Coming soon only when it does not', () => {
    for (const flag of ['true', '']) {
      process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = flag;
      for (const key of keys) {
        const shipped = status(key) !== 'COMING_SOON';
        const dependency = capabilityDependsOn[key];
        if (shipped) expect({ key, api: dependency.api !== null, screen: dependency.screen !== null }).toEqual({ key, api: true, screen: true });
      }
    }
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = original;
  });

  it('lists exactly what is still to come — update this when a server route ships', () => {
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = '';
    const soon = keys.filter(key => status(key) === 'COMING_SOON').sort();
    process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = original;
    expect(soon).toEqual([
      'assistantName', 'assistantPersonality', 'camera', 'files',
      'photos', 'whatsapp',
    ]);
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
    const soonWords = [en, ar, he].reduce((sum, t) => sum + screen.queryAllByText(t.xSoon).length, 0);
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
