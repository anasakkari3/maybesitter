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
}));
jest.mock('../useWatchers', () => ({
  useBackgroundActivity: query({ paused: false, monitors: [] }),
  useBackgroundAttribution: query({ actions: [], orphanCount: 0 }),
  useWatcherAction: mutation(),
  useSetBackgroundActivityPaused: mutation(),
  useCreateReadinessWatcher: mutation(),
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
      'assistantName', 'assistantPersonality', 'assistantPreparation', 'camera', 'drive', 'export', 'files',
      'gmail', 'googleCalendar', 'location', 'photos', 'weeklyMode', 'whatsapp',
    ]);
  });
});
