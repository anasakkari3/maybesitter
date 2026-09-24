import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ClarityProvider, useClarityStage, useReplayEvent } from '../ClarityProvider';
import { ClarityConsent } from '../ClarityConsent';
import { createReplayController } from '../controller';
import en from '../../i18n/locales/en.json';

let mockAuth = { status: 'signedIn', user: { uid: 'account-a' } };
let mockScreen = 'today';
jest.mock('../../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('../native', () => ({ clarityAvailable: () => true, loadClarity: jest.fn() }));
jest.mock('../../state/AppContext', () => ({ useApp: () => ({
  s: { screen: mockScreen }, lang: 'ar', scheme: 'light', t: require('../../i18n/locales/en.json'),
  p: { ln: 'grey', ac: 'coral', mu: 'grey' },
}) }));
jest.mock('../../ui/primitives', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text, View } = require('react-native');
  return { Txt: Text, Card: View };
});
jest.mock('../controller', () => ({ createReplayController: jest.fn(() => ({ update: jest.fn(), stop: jest.fn(), event: jest.fn() })) }));

const replay = (createReplayController as jest.Mock<typeof createReplayController>).mock.results[0]!.value as ReturnType<typeof createReplayController>;
function App({ nested = false }: { nested?: boolean }) {
  return <ClarityProvider><ClarityConsent />{nested ? <Stages /> : null}</ClarityProvider>;
}
function Stages() {
  useClarityStage('onboarding_about');
  return <ImportStage />;
}
function ImportStage() { useClarityStage('ai_import_review'); return null; }

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { status: 'signedIn', user: { uid: 'account-a' } };
  mockScreen = 'today';
  process.env.EXPO_PUBLIC_CLARITY_ENABLED = 'true';
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
});
afterEach(() => { delete process.env.EXPO_PUBLIC_CLARITY_ENABLED; jest.restoreAllMocks(); });

it('starts off and requires its own accessible switch to grant consent', async () => {
  await render(<App />);
  expect(screen.getByRole('switch', { name: en.clarityConsentTitle }).props.value).toBe(false);
  expect(replay.update).toHaveBeenLastCalledWith(expect.objectContaining({ screen: 'today' }), false, true);
  await fireEvent(screen.getByTestId('clarity-consent-switch'), 'valueChange', true);
  expect(replay.update).toHaveBeenLastCalledWith(expect.anything(), true, true);
  await fireEvent(screen.getByTestId('clarity-consent-switch'), 'valueChange', false);
  expect(replay.stop).toHaveBeenCalled();
  expect(replay.update).toHaveBeenLastCalledWith(expect.anything(), false, true);
});

it('a second account and a cold mount never inherit consent', async () => {
  const view = await render(<App />);
  await fireEvent(screen.getByTestId('clarity-consent-switch'), 'valueChange', true);
  mockAuth = { status: 'signedIn', user: { uid: 'account-b' } };
  await view.rerender(<App />);
  expect(screen.getByTestId('clarity-consent-switch').props.value).toBe(false);
  expect(replay.stop).toHaveBeenCalled();
  await fireEvent(screen.getByTestId('clarity-consent-switch'), 'valueChange', true);
  await view.unmount();
  await render(<App />);
  expect(screen.getByTestId('clarity-consent-switch').props.value).toBe(false);
  expect(JSON.stringify(jest.mocked(replay.update).mock.calls)).not.toContain('account-');
});

it('hides the control and denies capture while signed out or build-disabled', async () => {
  mockAuth.status = 'signedOut';
  const view = await render(<App />);
  expect(screen.queryByTestId('clarity-consent-switch')).toBeNull();
  expect(replay.update).toHaveBeenLastCalledWith(expect.anything(), false, false);
  mockAuth.status = 'signedIn'; process.env.EXPO_PUBLIC_CLARITY_ENABLED = 'false';
  await view.rerender(<App />);
  expect(screen.queryByTestId('clarity-consent-switch')).toBeNull();
});

it('pauses excluded screens and backgrounding immediately', async () => {
  let change!: (state: string) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => {
    change = callback as (state: string) => void; return { remove: jest.fn() };
  });
  const view = await render(<App />);
  await fireEvent(screen.getByTestId('clarity-consent-switch'), 'valueChange', true);
  mockScreen = 'account'; await view.rerender(<App />);
  expect(replay.update).toHaveBeenLastCalledWith(null, true, true);
  await act(() => change('background'));
  expect(replay.stop).toHaveBeenCalled();
  expect(replay.update).toHaveBeenLastCalledWith(null, false, true);
});

it('tracks the nested AI import stage ahead of its onboarding parent', async () => {
  await render(<App nested />);
  expect(replay.update).toHaveBeenLastCalledWith(expect.objectContaining({ screen: 'ai_import_review', flow: 'ai_import' }), false, true);
});

it('keeps children mounted across logout while discarding callbacks from the old account', async () => {
  const mounted = jest.fn();
  let report!: ReturnType<typeof useReplayEvent>;
  function Receipt() {
    const currentReport = useReplayEvent();
    React.useEffect(() => { report = currentReport; }, [currentReport]);
    React.useEffect(() => { mounted(); }, []);
    return null;
  }
  const tree = <ClarityProvider><Receipt /><ClarityConsent /></ClarityProvider>;
  const view = await render(tree);
  const oldReport = report;
  mockAuth = { status: 'signedOut', user: { uid: '' } };
  await view.rerender(<ClarityProvider><Receipt /><ClarityConsent /></ClarityProvider>);
  expect(mounted).toHaveBeenCalledTimes(1);
  oldReport('goal_confirmed');
  expect(replay.event).not.toHaveBeenCalled();
});
