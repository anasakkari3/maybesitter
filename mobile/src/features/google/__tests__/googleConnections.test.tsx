/**
 * The three Google rows, in each of their states (CL6a).
 *
 * The screen runs with its real hooks and a real query client; only the
 * network (`endpoints/google`) and the system browser (`expo-web-browser`)
 * are replaced. Statuses are the recorded fixtures, so a row is tested
 * against the shape the server actually sends.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { AppProvider, useApp } from '../../../state/AppContext';
import { strings, type Lang, type Strings } from '../../../i18n/strings';
import * as google from '../../../api/endpoints/google';
import { GoogleRefusedError, QuotaExceededError } from '../../../api/errors';
import type { GoogleStatus } from '../../../api/schemas/google';
import notConfigured from '../../../api/__fixtures__/google.notConfigured.json';
import notConnected from '../../../api/__fixtures__/google.notConnected.json';
import connected from '../../../api/__fixtures__/google.connected.json';
import allFeatures from '../../../api/__fixtures__/google.status.json';
import needsReauth from '../../../api/__fixtures__/google.needsReauth.json';
import disconnected from '../../../api/__fixtures__/google.disconnected.json';
import connectStarted from '../../../api/__fixtures__/google.connectStarted.json';
import drivePicker from '../../../api/__fixtures__/google.drivePicker.json';
import gmailScan from '../../../api/__fixtures__/google.gmailScan.json';
import gmailScanNotRead from '../../../api/__fixtures__/google.gmailScanNotRead.json';
import gmailScanPartialEmpty from '../../../api/__fixtures__/google.gmailScanPartialEmpty.json';
import gmailScanBudgetEmpty from '../../../api/__fixtures__/google.gmailScanBudgetEmpty.json';
import driveImport from '../../../api/__fixtures__/google.driveImport.json';
import { GoogleIntegrationScreen } from '../GoogleIntegrationScreen';
import { IntegrationsScreen } from '../../product/ControlScreens';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), openBrowserAsync: jest.fn() }));
jest.mock('../../../api/endpoints/google', () => ({
  getGoogleStatus: jest.fn(),
  startGoogleConnect: jest.fn(),
  completeGoogleConnect: jest.fn(),
  disconnectGoogle: jest.fn(),
  syncGoogleCalendar: jest.fn(),
  listGoogleBusy: jest.fn(),
  scanGmail: jest.fn(),
  beginDrivePick: jest.fn(),
  importDriveFile: jest.fn(),
}));
jest.mock('../../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
const mockConsent = { ai: true, calendar: true };
jest.mock('../../../api/queries', () => ({
  ...(jest.requireActual('../../../api/queries') as object),
  useAiConsentGranted: () => ({ granted: mockConsent.ai, asked: true, loading: false }),
  useTrust: () => ({ data: { trust: { calendarConsent: mockConsent.calendar } } }),
}));
const mockAdoptProposal = jest.fn();
jest.mock('../../capture/CaptureProvider', () => ({ useCaptureFlow: () => ({ adoptProposal: mockAdoptProposal }) }));

const api = google as jest.Mocked<typeof google>;
const browser = WebBrowser as jest.Mocked<typeof WebBrowser>;
const statusOf = (fixture: { google: unknown }) => fixture.google as GoogleStatus;

let client: QueryClient;

/** Shows which screen the app moved to, so a hand-off to review is visible. */
function Where() {
  const { s, lang } = useApp();
  return <><Text testID="where">{s.screen}</Text><Text testID="lang">{lang}</Text></>;
}

/** The element carries exactly this sentence. */
function textOf(testID: string, expected: string): boolean {
  const found = screen.getByTestId(testID);
  expect(screen.getByText(expected)).toBe(found);
  return true;
}

/** The copy in whichever language the app resolved to, so assertions read the real words. */
function copy(): Strings {
  return strings[screen.getByTestId('lang').props.children as Lang];
}

async function show(status: GoogleStatus, Page: () => React.JSX.Element = GoogleIntegrationScreen) {
  api.getGoogleStatus.mockResolvedValue({ success: true, google: status } as never);
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <AppProvider>
        <QueryClientProvider client={client}>
          <Page />
          <Where />
        </QueryClientProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(api.getGoogleStatus).toHaveBeenCalled());
  if (Page === GoogleIntegrationScreen) await waitFor(() => expect(screen.queryByTestId('google-row-calendar')).not.toBeNull());
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockConsent.ai = true;
  mockConsent.calendar = true;
  jest.clearAllMocks();
});
afterEach(() => { cleanup(); client.clear(); });

describe('not configured', () => {
  it('says the one honest line and offers no connect button anywhere', async () => {
    await show(statusOf(notConfigured));
    await waitFor(() => expect(screen.getByTestId('google-not-configured')).toBeTruthy());
    expect(textOf('google-not-configured', copy().googleNotConfigured)).toBeTruthy();
    for (const feature of ['calendar', 'gmail', 'drive']) {
      expect(screen.queryByTestId(`google-connect-${feature}`)).toBeNull();
      expect(screen.queryByTestId(`google-reconnect-${feature}`)).toBeNull();
    }
    expect(screen.queryByTestId('google-disconnect')).toBeNull();
    // Never "coming soon".
    expect(screen.queryByText(/Coming soon|قريبًا|בקרוב/)).toBeNull();
    expect(screen.queryByTestId('row-status-COMING_SOON')).toBeNull();
  });
});

describe('connect', () => {
  it('opens Google in an auth session and posts back what it returned, signed in', async () => {
    await show(statusOf(notConnected));
    await waitFor(() => expect(screen.getByTestId('google-connect-calendar')).toBeTruthy());
    expect(screen.getByTestId('google-connect-gmail')).toBeTruthy();
    expect(screen.getByTestId('google-connect-drive')).toBeTruthy();
    expect(screen.queryByTestId('google-not-configured')).toBeNull();

    api.startGoogleConnect.mockResolvedValue(connectStarted as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'maybesitter://oauth/google?code=4%2F0Abc&state=st-1' } as never);
    api.completeGoogleConnect.mockResolvedValue(connected as never);
    await fireEvent.press(screen.getByTestId('google-connect-calendar'));

    await waitFor(() => expect(api.completeGoogleConnect).toHaveBeenCalledWith({ code: '4/0Abc', state: 'st-1' }));
    expect(api.startGoogleConnect).toHaveBeenCalledWith('calendar');
    expect(browser.openAuthSessionAsync).toHaveBeenCalledWith(connectStarted.authorizationUrl, 'maybesitter://oauth/google');
    await waitFor(() => expect(screen.getByTestId('google-calendar-line')).toBeTruthy());
    expect(screen.getByTestId('google-calendar-sync')).toBeTruthy();
    // Gmail was not part of this grant, so it still offers its own connect.
    expect(screen.getByTestId('google-connect-gmail')).toBeTruthy();
    expect(textOf('google-notice', copy().googleConnected)).toBeTruthy();
  });

  it('closing the auth session is not a failure and sends nothing', async () => {
    await show(statusOf(notConnected));
    await waitFor(() => expect(screen.getByTestId('google-connect-gmail')).toBeTruthy());
    api.startGoogleConnect.mockResolvedValue(connectStarted as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' } as never);
    await fireEvent.press(screen.getByTestId('google-connect-gmail'));
    await waitFor(() => expect(browser.openAuthSessionAsync).toHaveBeenCalled());
    expect(api.completeGoogleConnect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('google-notice')).toBeNull();
  });

  it('a refusal becomes its own sentence, never the server text', async () => {
    await show(statusOf(notConnected));
    await waitFor(() => expect(screen.getByTestId('google-connect-calendar')).toBeTruthy());
    api.startGoogleConnect.mockResolvedValue(connectStarted as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'maybesitter://oauth/google?code=c&state=s' } as never);
    api.completeGoogleConnect.mockRejectedValue(new GoogleRefusedError('google_account_mismatch'));
    await fireEvent.press(screen.getByTestId('google-connect-calendar'));
    await waitFor(() => expect(textOf('google-notice', copy().googleErrOtherAccount)).toBeTruthy());
  });

  it('"Cancel" on Google\'s consent screen is posted as the closed error and reads as nothing changed', async () => {
    await show(statusOf(notConnected));
    await waitFor(() => expect(screen.getByTestId('google-connect-drive')).toBeTruthy());
    api.startGoogleConnect.mockResolvedValue(connectStarted as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'maybesitter://oauth/google?error=access_denied' } as never);
    api.completeGoogleConnect.mockRejectedValue(new GoogleRefusedError('google_access_denied'));
    await fireEvent.press(screen.getByTestId('google-connect-drive'));
    await waitFor(() => expect(api.completeGoogleConnect).toHaveBeenCalledWith({ error: 'access_denied' }));
    await waitFor(() => expect(textOf('google-notice', copy().googleErrDenied)).toBeTruthy());
  });
});

describe('connected', () => {
  it('each feature offers its own action, and Gmail\'s proposal opens in review', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-gmail-scan')).toBeTruthy());
    expect(within(screen.getByTestId('google-row-calendar')).getByText('Connected · ⁦person@example.com⁩')).toBeTruthy();
    expect(screen.getByTestId('google-calendar-sync')).toBeTruthy();
    expect(screen.getByTestId('google-drive-pick')).toBeTruthy();

    api.scanGmail.mockResolvedValue(gmailScan as never);
    await fireEvent.press(screen.getByTestId('google-gmail-scan'));
    await waitFor(() => expect(mockAdoptProposal).toHaveBeenCalledWith(gmailScan));
    expect(screen.getByTestId('where').props.children).toBe('capture');
  });

  it('a scan the model could not read is not "nothing to save": it stays here and says so', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-gmail-scan')).toBeTruthy());
    api.scanGmail.mockResolvedValue(gmailScanNotRead as never);
    await fireEvent.press(screen.getByTestId('google-gmail-scan'));
    await waitFor(() => expect(screen.getByTestId('google-notice')).toBeTruthy());
    expect(textOf('google-notice', copy().googleGmailNotRead)).toBe(true);
    expect(mockAdoptProposal).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').props.children).not.toBe('capture');
  });

  it('a scan the model cap stopped, with nothing in what it read, says how many and to try again soon', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-gmail-scan')).toBeTruthy());
    // Recorded from the route (CL6a round 2, N4): 3 read, 17 the cap refused.
    api.scanGmail.mockResolvedValue(gmailScanPartialEmpty as never);
    await fireEvent.press(screen.getByTestId('google-gmail-scan'));
    await waitFor(() => expect(screen.getByTestId('google-notice')).toBeTruthy());
    expect(textOf('google-notice', copy().googleGmailPartial.replace('{read}', '3').replace('{total}', '20'))).toBe(true);
    expect(mockAdoptProposal).not.toHaveBeenCalled();
  });

  it('a scan the call budget stopped, with nothing in what it read, says how many and nothing about trying again', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-gmail-scan')).toBeTruthy());
    // Recorded from the route: 9 read, 11 past the three-call budget. Pressing
    // again reads the same nine, so "try again soon" would be false (N2).
    api.scanGmail.mockResolvedValue(gmailScanBudgetEmpty as never);
    await fireEvent.press(screen.getByTestId('google-gmail-scan'));
    await waitFor(() => expect(screen.getByTestId('google-notice')).toBeTruthy());
    expect(textOf('google-notice', copy().googleGmailPartialNewest.replace('{read}', '9').replace('{total}', '20'))).toBe(true);
    expect(mockAdoptProposal).not.toHaveBeenCalled();
  });

  it('a Drive file the model quota stopped says to try later, not that Google is down', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-drive-pick')).toBeTruthy());
    api.beginDrivePick.mockResolvedValue(drivePicker as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'maybesitter://oauth/google/drive?fileId=doc_fixture_12345' } as never);
    api.importDriveFile.mockRejectedValue(new QuotaExceededError('user_minute', 30, 'quota') as never);
    await fireEvent.press(screen.getByTestId('google-drive-pick'));
    await waitFor(() => expect(screen.getByTestId('google-notice')).toBeTruthy());
    expect(textOf('google-notice', copy().aiQuotaTryLater)).toBe(true);
    expect(mockAdoptProposal).not.toHaveBeenCalled();
  });

  it('Drive opens the picker page and reads the one file picked into review', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-drive-pick')).toBeTruthy());
    api.beginDrivePick.mockResolvedValue(drivePicker as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'maybesitter://oauth/google/drive?fileId=doc_fixture_12345' } as never);
    api.importDriveFile.mockResolvedValue(driveImport as never);
    await fireEvent.press(screen.getByTestId('google-drive-pick'));
    await waitFor(() => expect(api.importDriveFile).toHaveBeenCalledWith({ fileId: 'doc_fixture_12345', timezone: expect.any(String) }));
    expect(browser.openAuthSessionAsync).toHaveBeenCalledWith(drivePicker.pickerUrl, 'maybesitter://oauth/google/drive');
    await waitFor(() => expect(mockAdoptProposal).toHaveBeenCalledWith(driveImport));
  });

  it('without AI consent Gmail and Drive say why and point at the setting, with no button that can only be refused', async () => {
    mockConsent.ai = false;
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-gmail-needs-ai')).toBeTruthy());
    expect(screen.getByTestId('google-drive-needs-ai')).toBeTruthy();
    expect(screen.queryByTestId('google-gmail-scan')).toBeNull();
    expect(screen.queryByTestId('google-drive-pick')).toBeNull();
    expect(screen.getByTestId('google-calendar-sync')).toBeTruthy();
  });

  it('without the Trust Center calendar switch the calendar row says so instead of syncing', async () => {
    mockConsent.calendar = false;
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-calendar-needs-consent')).toBeTruthy());
    expect(screen.queryByTestId('google-calendar-sync')).toBeNull();
  });
});

describe('reconnect', () => {
  it('a lapsed grant shows «أعد الربط» on every feature it held, and pressing it starts a new consent', async () => {
    await show(statusOf(needsReauth));
    await waitFor(() => expect(screen.getByTestId('google-reconnect-calendar')).toBeTruthy());
    expect(screen.getByTestId('google-reconnect-gmail')).toBeTruthy();
    expect(screen.getByTestId('google-reconnect-drive')).toBeTruthy();
    expect(screen.getAllByText(copy().googleReconnect).length).toBe(3);
    expect(screen.getByTestId('google-calendar-reauth')).toBeTruthy();
    expect(screen.queryByTestId('google-gmail-scan')).toBeNull();

    api.startGoogleConnect.mockResolvedValue(connectStarted as never);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'maybesitter://oauth/google?code=c2&state=s2' } as never);
    api.completeGoogleConnect.mockResolvedValue({ success: true, google: { ...statusOf(needsReauth), status: 'connected' } } as never);
    await fireEvent.press(screen.getByTestId('google-reconnect-gmail'));
    await waitFor(() => expect(screen.getByTestId('google-gmail-scan')).toBeTruthy());
    expect(api.startGoogleConnect).toHaveBeenCalledWith('gmail');
  });

  it('Arabic says «أعد الربط»', () => {
    expect(require('../../../i18n/locales/ar.json').googleReconnect).toBe('أعد الربط');
    expect(require('../../../i18n/locales/ar.json').googleNotConfigured).toBe('ربط Google بستنّى إعداد من صاحب التطبيق');
  });
});

describe('disconnect', () => {
  it('asks first, then withdraws the grant and returns every row to connect', async () => {
    await show(statusOf(allFeatures));
    await waitFor(() => expect(screen.getByTestId('google-disconnect')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('google-disconnect'));
    expect(screen.getByTestId('google-disconnect-dialog')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('google-disconnect-keep'));
    expect(screen.queryByTestId('google-disconnect-dialog')).toBeNull();
    expect(api.disconnectGoogle).not.toHaveBeenCalled();

    api.disconnectGoogle.mockResolvedValue(disconnected as never);
    await fireEvent.press(screen.getByTestId('google-disconnect'));
    await fireEvent.press(screen.getByTestId('google-disconnect-confirm'));
    await waitFor(() => expect(api.disconnectGoogle).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('google-connect-calendar')).toBeTruthy());
    expect(screen.getByTestId('google-connect-gmail')).toBeTruthy();
    expect(screen.queryByTestId('google-disconnect')).toBeNull();
  });
});

describe('the three rows on the Integrations page', () => {
  const rows = ['integration-google', 'integration-gmail', 'integration-drive'];

  it('not configured: each row says the one honest line, none says Coming soon, and each opens the Google page', async () => {
    await show(statusOf(notConfigured), IntegrationsScreen);
    for (const id of rows) {
      await waitFor(() => expect(within(screen.getByTestId(id)).getByText(copy().googleNotConfigured)).toBeTruthy());
      expect(within(screen.getByTestId(id)).queryByTestId('row-status-COMING_SOON')).toBeNull();
    }
    await fireEvent.press(screen.getByTestId('integration-gmail'));
    expect(screen.getByTestId('where').props.children).toBe('googleIntegration');
  });

  it('a lapsed grant says so on every row it held', async () => {
    await show(statusOf(needsReauth), IntegrationsScreen);
    for (const id of rows) {
      await waitFor(() => expect(within(screen.getByTestId(id)).getByText(copy().googleReconnectBody)).toBeTruthy());
    }
  });

  it('connected rows say so; a feature not in the grant keeps its own description', async () => {
    await show(statusOf(connected), IntegrationsScreen);
    await waitFor(() => expect(within(screen.getByTestId('integration-google')).getByText(copy().googleConnected)).toBeTruthy());
    expect(within(screen.getByTestId('integration-gmail')).getByText(copy().googleGmailBody)).toBeTruthy();
    expect(within(screen.getByTestId('integration-drive')).getByText(copy().googleDriveBody)).toBeTruthy();
  });
});
