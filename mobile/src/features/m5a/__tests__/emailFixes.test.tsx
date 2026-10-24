/**
 * The email-side findings of Codex's Task A inspection (M5A-A-REV-010/011/012).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import {
  ACCOUNT_A,
  NOW,
  addedItem,
  completeScan,
  initialState,
  prepare,
  press,
  showIntelligence,
  teardown,
  waitForRequest,
  type M5aHarness,
} from '../../../__acceptance__/m5a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5aHarness | undefined;

function exactTextPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

describe('email status says what happened', () => {
  it('REV-010: a failed daily sweep names the failure, not a summary', async () => {
    harness = await prepare('en', initialState({
      scanDaily: {
        scanId: 'scan-daily-1', status: 'failed', day: '2030-03-28', failure: 'reconnect_needed',
        from: '2030-03-27T22:00:00.000Z', until: '2030-03-28T22:00:00.000Z',
        startedAt: '2030-03-29T03:00:00.000Z', failedAt: '2030-03-29T03:02:00.000Z',
        messagesRead: 2, messagesUnavailable: 0, messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
      },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-daily')).not.toBeNull());
    expect(screen.getByTestId('email-scan-daily')).toHaveTextContent(/Google needs reconnecting/);
    expect(screen.getByTestId('email-scan-daily')).not.toHaveTextContent(/Last daily check/);
  });

  it('REV-010: a completed scan says when it started and how many were added', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan({ addedFromEmail: 2 }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/Started /);
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/\b2 added from your own replies/);
  });

  it.each<['ar' | 'en' | 'he', number, string]>([
    ['ar', 1, 'تخطيت إيميل جماعي واحد — نشرات وإعلانات وتنبيهات وظائف.'],
    ['ar', 2, 'تخطيت إيميلين جماعيين — نشرات وإعلانات وتنبيهات وظائف.'],
    ['ar', 3, 'تخطيت 3 إيميلات جماعية — نشرات وإعلانات وتنبيهات وظائف.'],
    ['ar', 11, 'تخطيت 11 إيميل جماعي — نشرات وإعلانات وتنبيهات وظائف.'],
    ['en', 1, 'Skipped 1 bulk email — newsletters, ads and job alerts.'],
    ['en', 2, 'Skipped 2 bulk emails — newsletters, ads and job alerts.'],
    ['he', 1, 'דילגתי על מייל המוני אחד — ניוזלטרים, פרסומות והתראות משרות.'],
    ['he', 2, 'דילגתי על שני מיילים המוניים — ניוזלטרים, פרסומות והתראות משרות.'],
    ['he', 3, 'דילגתי על 3 מיילים המוניים — ניוזלטרים, פרסומות והתראות משרות.'],
  ])('shows the bulk-skip line in %s for %i', async (language, count, expected) => {
    harness = await prepare(language, initialState({ scanManual: completeScan({ messagesSkippedBulk: count }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(exactTextPattern(expected));
  });

  it.each<['ar' | 'en' | 'he', number, string]>([
    ['ar', 1, 'إيميل واحد ما قدرت أفهمه، كمّلت بعده'],
    ['ar', 2, 'إيميلين ما قدرت أفهمهم، كمّلت بعدهم'],
    ['ar', 3, '3 إيميلات ما قدرت أفهمهم، كمّلت بعدهم'],
    ['ar', 11, '11 إيميل ما قدرت أفهمهم، كمّلت بعدهم'],
    ['en', 1, "1 email I couldn't understand — I carried on past it"],
    ['en', 2, "2 emails I couldn't understand — I carried on past them"],
    ['he', 1, 'מייל אחד שלא הצלחתי להבין — המשכתי הלאה'],
    ['he', 2, 'שני מיילים שלא הצלחתי להבין — המשכתי הלאה'],
    ['he', 3, '3 מיילים שלא הצלחתי להבין — המשכתי הלאה'],
  ])('#815 shows the unanalysed line in %s for %i', async (language, count, expected) => {
    harness = await prepare(language, initialState({ scanManual: completeScan({ messagesUnanalysed: count }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(exactTextPattern(expected));
  });

  it('#815 omits the unanalysed line when every email was understood', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan({ messagesUnanalysed: 0 }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status')).not.toHaveTextContent(/couldn't understand/);
  });

  it('omits the bulk-skip line when nothing was skipped', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan({ messagesSkippedBulk: 0 }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status')).not.toHaveTextContent(/bulk email/);
  });

  it('REV-012: each added row shows when the commitment is', async () => {
    harness = await prepare('en', initialState({ added: [addedItem()] }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-when-auto-1')).not.toBeNull());
    expect(screen.getByTestId('added-when-auto-1')).toHaveTextContent(/11:00|Tomorrow/);
  });
});

describe('the backfill offer', () => {
  it('REV-011: is not offered while a scan of the last day exists', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan() }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);
    expect(screen.queryByTestId('backfill-offer')).toBeNull();
  });
});

describe('one press, one scan (M5A-R6-004)', () => {
  it('two presses of the confirmed scan in the same frame send one request', async () => {
    harness = await prepare('en', initialState());
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await waitFor(() => expect(screen.queryByTestId('email-scan-confirm-go')).not.toBeNull());
    const go = screen.getByTestId('email-scan-confirm-go');
    await act(async () => {
      await Promise.all([fireEvent.press(go), fireEvent.press(go)]);
    });
    await waitForRequest(harness, 'POST', /\/gmail\/scan$/);
    await act(async () => { await jest.advanceTimersByTimeAsync(200); });
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(1);
  });

  it('two presses of the backfill offer in the same frame send one request', async () => {
    harness = await prepare('en', initialState());
    await showIntelligence(harness);
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitFor(() => expect(screen.queryByTestId('backfill-yes')).not.toBeNull());
    const yes = screen.getByTestId('backfill-yes');
    await act(async () => {
      await Promise.all([fireEvent.press(yes), fireEvent.press(yes)]);
    });
    await waitForRequest(harness, 'POST', /\/gmail\/scan$/);
    await act(async () => { await jest.advanceTimersByTimeAsync(200); });
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(1);
  });
});

describe('the backfill offer reads a fresh answer (M5A-R7-003)', () => {
  it('is not offered when the scan overview cannot be read', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/intelligence/sources/gmail/scan' && request.method === 'GET') {
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await showIntelligence(harness);
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);
    await act(async () => { await jest.advanceTimersByTimeAsync(500); });
    expect(screen.queryByTestId('backfill-offer')).toBeNull();
  });

  it('is not offered while a recently accepted scan is queued', async () => {
    harness = await prepare('en', initialState({
      scanManual: completeScan({ startedAt: '2030-03-25T08:00:00.000Z' }),
      scanQueued: { scanId: 'q-1', origin: 'manual', from: '2030-03-22T08:00:00.000Z', until: '2030-03-29T08:00:00.000Z', acceptedAt: '2030-03-29T08:30:00.000Z' },
    }));
    await showIntelligence(harness);
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);
    await act(async () => { await jest.advanceTimersByTimeAsync(500); });
    expect(screen.queryByTestId('backfill-offer')).toBeNull();
  });
});

describe('a fresh answer before the tap acts (M5A-R10-001)', () => {
  it('a scan confirmed after the server switched email sources off sends nothing', async () => {
    harness = await prepare('en', initialState());
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await waitFor(() => expect(screen.queryByTestId('email-scan-confirm-go')).not.toBeNull());
    harness.server.state.emailSources = false; // the kill switch lands after the screen rendered
    await press('email-scan-confirm-go');
    await act(async () => { await jest.advanceTimersByTimeAsync(2_000); });
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(0);
  });

  it('R11-001: a background refetch already in flight (from before the kill switch) never answers the tap', async () => {
    let release: (() => void) | undefined;
    let hold = false;
    harness = await prepare('en', initialState(), request => {
      if (hold && request.method === 'GET' && request.path === '/api/mobile/capabilities/m5a') {
        hold = false;
        // Started while email sources were on; answers "on" only after the tap.
        return new Promise(resolve => { release = () => resolve({ status: 200, body: { success: true, calendarChoice: true, emailSources: true } }); });
      }
      return undefined;
    });
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await waitFor(() => expect(screen.queryByTestId('email-scan-confirm-go')).not.toBeNull());
    hold = true;
    await act(async () => { void harness!.client.invalidateQueries({ queryKey: ['user', ACCOUNT_A.uid, 'm5aCapabilities'] }); });
    harness.server.state.emailSources = false; // the kill switch lands while that refetch hangs
    await press('email-scan-confirm-go');
    await act(async () => { release?.(); await jest.advanceTimersByTimeAsync(2_000); });
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(0);
  });

  it('R12-F01: that refetch, landing after the fresh answer, never puts the controls back', async () => {
    const key = ['user', ACCOUNT_A.uid, 'm5aCapabilities'];
    let release: (() => void) | undefined;
    let hold = false;
    harness = await prepare('en', initialState(), request => {
      if (hold && request.method === 'GET' && request.path === '/api/mobile/capabilities/m5a') {
        hold = false;
        // Started while email sources were on; its "on" is released only after
        // the fresh probe has already said "off".
        return new Promise(resolve => { release = () => resolve({ status: 200, body: { success: true, calendarChoice: true, emailSources: true } }); });
      }
      return undefined;
    });
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await waitFor(() => expect(screen.queryByTestId('email-scan-confirm-go')).not.toBeNull());
    hold = true;
    await act(async () => { void harness!.client.invalidateQueries({ queryKey: key }); });
    expect(release).toBeDefined();
    harness.server.state.emailSources = false; // the kill switch lands while that refetch hangs
    await press('email-scan-confirm-go');
    await act(async () => { await jest.advanceTimersByTimeAsync(200); });
    // The fresh probe has answered: off, and the M5a controls are gone.
    expect(harness.client.getQueryData<{ emailSources: boolean }>(key)?.emailSources).toBe(false);
    expect(screen.queryByTestId('email-scan-button')).toBeNull();
    // Now the pre-kill refetch lands.
    await act(async () => { release!(); await jest.advanceTimersByTimeAsync(2_000); });
    expect(harness.client.getQueryData<{ emailSources: boolean }>(key)?.emailSources).toBe(false);
    expect(screen.queryByTestId('email-scan-button')).toBeNull();
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(0);
  });

  it('FU-S-R1-001: a fresh probe that timed out never overwrites a newer answer when it lands late', async () => {
    const key = ['user', ACCOUNT_A.uid, 'm5aCapabilities'];
    let release: (() => void) | undefined;
    let hold = false;
    harness = await prepare('en', initialState(), request => {
      if (hold && request.method === 'GET' && request.path === '/api/mobile/capabilities/m5a') {
        hold = false;
        // The tap's own fresh probe, asked while email sources were on; it
        // answers only after its 1.5 s are long gone.
        return new Promise(resolve => { release = () => resolve({ status: 200, body: { success: true, calendarChoice: true, emailSources: true } }); });
      }
      return undefined;
    });
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await waitFor(() => expect(screen.queryByTestId('email-scan-confirm-go')).not.toBeNull());
    hold = true;
    await press('email-scan-confirm-go');
    expect(release).toBeDefined();
    await act(async () => { await jest.advanceTimersByTimeAsync(1_600); });
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(0);
    // The kill switch lands, and a newer read caches it.
    harness.server.state.emailSources = false;
    await act(async () => { await harness!.client.invalidateQueries({ queryKey: key }); await jest.advanceTimersByTimeAsync(100); });
    expect(harness.client.getQueryData<{ emailSources: boolean }>(key)?.emailSources).toBe(false);
    // Now the timed-out probe lands with its old "on".
    await act(async () => { release!(); await jest.advanceTimersByTimeAsync(2_000); });
    expect(harness.client.getQueryData<{ emailSources: boolean }>(key)?.emailSources).toBe(false);
    expect(screen.queryByTestId('email-scan-button')).toBeNull();
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(0);
  });
});
