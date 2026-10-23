/**
 * Today follows a text-size change made while it is open (simulator
 * 2026-10-24, shots 10, 14 and 16a).
 *
 * Nothing about the date, the «خطوتك التالية» pill, the importance chip or the
 * time changes with the scale, so on a live change none of them got new props
 * and native kept the old measurement (RN 0.86 Fabric): growing to AX5 the
 * date was a sliver; back at the default size it kept a 157 pt box, the pill
 * stayed tall and empty and the meta row stayed stacked. Each now sits in a
 * `SaidWords` — a view that says the words and stays — whose drawn paragraph
 * is replaced on the change. The words inside the buttons are replaced by the
 * button's own boundary (`Btn`), the buttons stay. The next-step card's face
 * is held the same way.
 *
 * Round trip: the toggled nodes (the card, the meta row, the pill) commit what
 * a fresh open commits, and never a `flex` basis, which Yoga on Fabric keeps.
 *
 * Real `useWindowDimensions` and `Dimensions.set`, as in
 * understoodLiveTextScale.test; the default reading is restored after each test.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import type { Commitment } from '../../api/schemas/common';
import { TodayScreen } from '../TodayScreen';
import { NextStepCard } from '../../features/nextStep/NextStepCard';
import type { CommitmentView } from '../../features/commitments/model';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';
import * as consentEndpoints from '../../api/endpoints/consents';
import * as planEndpoints from '../../api/endpoints/plans';
import consentsFixture from '../../api/__fixtures__/consents.answered.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);

const AX5 = 3.12;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'today-live-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  setFontScale(1);
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(consentsFixture as never);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  setFontScale(1);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

type Host = ReturnType<typeof screen.getByTestId>;
type Style = Record<string, unknown>;
const flat = (node: Host) => (StyleSheet.flatten(node.props.style) ?? {}) as Style;
const ids = (list: readonly string[]) => list.map((id) => screen.getByTestId(id));
/** Every drawn paragraph inside the node, the ones a wrapper hides from a screen reader too. */
const drawnIn = (id: string) => within(screen.getByTestId(id)).getAllByText(/./, { includeHiddenElements: true });

function expectNoFlexBasis(style: Style) {
  expect(style.flex).toBeUndefined();
  expect(style.flexBasis).toBeUndefined();
}

/** The stable view says the words; the drawn paragraph inside it is no second focus target. */
function expectSaid(id: string) {
  const said = screen.getByTestId(id);
  expect(said.props.accessible).toBe(true);
  expect(String(said.props.accessibilityLabel).length).toBeGreaterThan(0);
  for (const text of drawnIn(id)) expect(text.props.accessible).toBe(false);
}

/**
 * Default → AX5 → default: every paragraph under `regions` is a new one after
 * each change, and every node in `kept` is the same instance throughout.
 */
async function expectRemeasured(regions: readonly string[], kept: readonly string[]) {
  const stable = ids(kept);
  let drawn = regions.flatMap(drawnIn);
  expect(drawn.length).toBeGreaterThanOrEqual(regions.length);
  for (const scale of [AX5, 1]) {
    await act(async () => { setFontScale(scale); });
    const next = regions.flatMap(drawnIn);
    expect(next).toHaveLength(drawn.length);
    for (const node of next) expect(drawn).not.toContain(node);
    kept.forEach((id, i) => expect(screen.getByTestId(id)).toBe(stable[i]));
    drawn = next;
  }
}

function item(id: string, title: string): Commitment {
  return {
    id, kind: 'task', title, description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z', confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null, droppedAt: null,
  } as Commitment;
}

async function showToday() {
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    success: true, participantId: USER.uid,
    recommendation: { version: 'v1', proposalId: 'next-step-empty', state: 'empty', locale: 'en', primaryStep: null, explanation: null },
  } as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [item('m', 'Pay the rent'), item('m2', 'Call the bank')] } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><TodayScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('today-primary')).not.toBeNull());
}

const TODAY_SAID = ['today-date-said', 'today-primary-badge', 'today-importance-m', 'today-time-m-said'];
const TODAY_BUTTONS = ['today-item-m', 'today-primary-complete', 'today-primary-postpone', 'reference-search', 'open-settings'];

describe('Today after a live text-size change', () => {
  it('the date, the pill, the chip and the time are said by views that stay; each drawn paragraph is new after each change', async () => {
    await showToday();
    TODAY_SAID.forEach(expectSaid);
    expect(screen.getByTestId('today-date-said').props.accessibilityLabel).toBe(screen.getByTestId('today-date').props.children);
    await expectRemeasured(TODAY_SAID, [...TODAY_SAID, ...TODAY_BUTTONS, 'today-scroll']);
  });

  it('the words inside the card\'s buttons are new after each change, the buttons the same ones', async () => {
    await showToday();
    await expectRemeasured(['today-item-m', 'today-primary-complete', 'today-primary-postpone'], TODAY_BUTTONS);
  });

  it('default → AX5 → default: the card, its meta row and the pill commit what a fresh open commits, with no flex basis', async () => {
    await showToday();
    const read = () => ({
      card: flat(screen.getByTestId('today-primary')),
      meta: flat(screen.getByTestId('today-primary-meta')),
      pill: flat(screen.getByTestId('today-primary-badge')),
      time: flat(screen.getByTestId('today-time-m-said')),
      date: flat(screen.getByTestId('today-date-said')),
    });
    const fresh = read();
    await act(async () => { setFontScale(AX5); });
    const ax5 = read();
    // The card does switch with the mode (it is the proof the round trip ran).
    expect(ax5.card.padding).not.toBe(fresh.card.padding);
    await act(async () => { setFontScale(1); });
    expect(read()).toEqual(fresh);
    for (const style of [...Object.values(fresh), ...Object.values(ax5)]) expectNoFlexBasis(style);
  });
});

const ITEM: CommitmentView = {
  id: 'c-1', title: 'Send the report', importance: 'should', status: 'active',
  shownAt: '2026-10-06T07:00:00.000Z', allDay: false, isPast: true,
  importanceIsStated: false, rank: undefined, reasonCodes: [],
};

async function showCard() {
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    success: true, participantId: USER.uid,
    recommendation: {
      version: 'v1', proposalId: 'p-1', state: 'ready', locale: 'en',
      primaryStep: { commitmentId: 'c-1', title: 'Send the report' },
      explanation: { summary: 'x', evidenceLabels: ['x'], sensitiveInferenceUsed: false, evidenceCodes: [] },
      availableActions: ['accept', 'defer', 'done'],
      persistence: { occurred: false, confirmationRequired: true },
    },
  } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><NextStepCard lookup={new Map([['c-1', ITEM]])} /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('next-step-open')).not.toBeNull());
}

const CARD_SAID = ['next-step-badge-said', 'next-step-importance', 'next-step-when-said'];
const CARD_BUTTONS = ['next-step-open', 'next-step-accept', 'next-step-done', 'next-step-defer'];

describe('the next-step card after a live text-size change', () => {
  it('its pill, chip and time are said by views that stay; the drawn paragraphs and the buttons\' words are new, the buttons the same', async () => {
    await showCard();
    CARD_SAID.forEach(expectSaid);
    await expectRemeasured([...CARD_SAID, ...CARD_BUTTONS], [...CARD_SAID, ...CARD_BUTTONS, 'next-step-card']);
  });

  it('default → AX5 → default: the pill and the buttons commit what a fresh open commits, with no flex basis', async () => {
    await showCard();
    const read = (): Record<string, Style> => ({ pill: flat(screen.getByTestId('next-step-badge-said')), ...Object.fromEntries(CARD_BUTTONS.map((id) => [id, flat(screen.getByTestId(id))])) });
    const fresh = read();
    await act(async () => { setFontScale(AX5); });
    const ax5 = read();
    await act(async () => { setFontScale(1); });
    expect(read()).toEqual(fresh);
    // The pill and the start action switch with the mode: never a flex basis.
    for (const at of [fresh, ax5]) for (const key of ['pill', 'next-step-accept']) expectNoFlexBasis(at[key] as Style);
    // The two answers keep `flexBasis: 120` in every mode, in a row that never
    // changes direction: the basis Yoga keeps is the one they always ask for.
    for (const key of ['next-step-done', 'next-step-defer']) expect([fresh[key]?.flexBasis, ax5[key]?.flexBasis]).toEqual([120, 120]);
  });
});
