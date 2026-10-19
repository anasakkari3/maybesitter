import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { Pill, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { fill, ltr } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { formatDate, formatDayKey, formatRelativeDay, formatTime } from '../../i18n/format';
import { deviceTimeZone, useTimeZone } from '../../i18n/timezone';
import { useUid } from '../../api/queries';
import { getEmailScanOverview, postEmailScan } from '../../api/endpoints/m5a';
import type { DailyStatus, EmailScanOverview, QueuedScan, ScanFailure, ScanStatus, ScanWait } from '../../api/schemas/m5a';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { Strings } from '../../i18n/strings';

/**
 * One email scan, said the same way wherever it is started (M5a R2.2/R2.3):
 * did it start, how far did it get, did it finish — with the number. A
 * failure names what failed and offers the one action that helps; a wait
 * says when it carries on by itself. The scan keeps running on the server
 * when the person leaves the screen, so the line is read from the server,
 * never from local state.
 */
export const emailScanKey = (uid: string) => ['user', uid, 'emailScan'] as const;

const POLL_MS = 5_000;

function active(overview: EmailScanOverview | undefined): boolean {
  if (!overview) return false;
  return overview.manual?.status === 'running' || (overview.queuedManual ?? null) !== null || overview.daily?.status === 'running';
}

/** The scan overview; polled only while something is running. */
export function useEmailScanOverview(enabled: boolean) {
  const uid = useUid();
  return useQuery({
    queryKey: emailScanKey(uid),
    queryFn: () => getEmailScanOverview({ asUid: uid }),
    enabled: enabled && uid !== 'signed-out',
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (active(query.state.data) ? POLL_MS : false),
    retry: false,
  });
}

/** «افحص إيميلي (آخر 7 أيام)»: explained first, sent only on «كمّل». */
export function EmailScanEntry({ onStarted }: { onStarted?: () => void }) {
  const { t, p } = useApp();
  const uid = useUid();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const explainRef = useRef<View>(null);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => {
      if (explainRef.current) AccessibilityInfo.sendAccessibilityEvent(explainRef.current, 'focus');
    }, 50);
    return () => clearTimeout(timer);
  }, [confirming]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await postEmailScan({ intent: 'new', timezone: deviceTimeZone() }, { asUid: uid });
      client.setQueryData<EmailScanOverview>(emailScanKey(uid), (previous) => ({
        success: true,
        manual: answer.scan,
        queuedManual: answer.queuedManual ?? null,
        daily: previous?.daily ?? null,
      }));
      setConfirming(false);
      onStarted?.();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: emailScanKey(uid) });
    }
  }, [client, onStarted, uid]);

  return (
    <View style={{ gap: 10, alignItems: 'flex-start' }}>
      <Pill testID="email-scan-button" label={t.m5ScanButton} kind={confirming ? 'accent' : 'outline'} expanded={confirming}
        size={14} pad={12} disabled={busy} onPress={() => setConfirming(true)} />
      {confirming ? (
        <View testID="email-scan-confirm" style={{ alignSelf: 'stretch', gap: 10, backgroundColor: p.sf2, borderRadius: 14, padding: 12 }}>
          <View ref={explainRef} accessible><Txt role="supporting">{t.m5ScanExplain}</Txt></View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Pill testID="email-scan-confirm-go" label={t.xIntelligenceRun} size={14} pad={12} disabled={busy} onPress={() => void start()} />
            <Pill testID="email-scan-confirm-cancel" label={t.cancel} kind="outline" size={14} pad={12} disabled={busy} onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
      {error ? <Txt role="supporting" color={p.wm} testID="email-scan-error">{userFacingMessage(error, t)}</Txt> : null}
    </View>
  );
}

/**
 * The shared status line: the scan, a wait, what is queued after it, the
 * daily check. One live region holds every line, mounted with the first
 * answer, so TalkBack hears each later line arrive (the live-region census);
 * the one action that helps sits below it.
 */
export function EmailScanStatus({ overview, onReconnect }: { overview: EmailScanOverview | undefined; onReconnect: () => void }) {
  // Mounted with the first answer and kept from then on: what is already
  // there when the screen opens is read as the screen, and every later
  // change is heard.
  if (!overview) return null;
  const manual = overview.manual ?? null;
  const queued = overview.queuedManual ?? null;
  const daily = overview.daily ?? null;
  return (
    <View style={{ gap: 8, alignItems: 'flex-start' }}>
      <LiveRegion testID="email-scan-status" style={{ gap: 6, alignSelf: 'stretch' }}>
        {manual ? <ScanText scan={manual} /> : null}
        {manual?.status === 'running' && manual.waiting ? <WaitLine wait={manual.waiting} /> : null}
        {queued ? <QueuedLine queued={queued} /> : null}
        {daily ? <DailyLine daily={daily} /> : null}
      </LiveRegion>
      {manual?.status === 'failed' ? <Recovery scan={manual} onReconnect={onReconnect} /> : null}
    </View>
  );
}

function useDates() {
  const { lang } = useApp();
  const zone = useTimeZone();
  const day = (at: string) => isolateAuto(formatDate(new Date(at), 'short', { locale: lang, timeZone: zone }));
  const when = (at: string) => {
    const date = new Date(at);
    return `${formatRelativeDay(date, { locale: lang, timeZone: zone })} ${ltr(formatTime(date, { locale: lang, timeZone: zone }))}`;
  };
  const dayKey = (key: string) => isolateAuto(formatDayKey(key, { locale: lang, timeZone: zone }));
  const at = (instant: string) => {
    const date = new Date(instant);
    return { date: formatRelativeDay(date, { locale: lang, timeZone: zone }), time: ltr(formatTime(date, { locale: lang, timeZone: zone })) };
  };
  return { day, when, dayKey, at };
}

function failureText(t: Strings, failure: ScanFailure): string {
  if (failure === 'reconnect_needed') return t.m5ScanFailedReconnect;
  if (failure === 'analysis_unavailable') return t.m5ScanFailedAnalysis;
  if (failure === 'monitoring_off') return t.m5ScanFailedOff;
  return t.m5ScanFailedSource;
}

/** One text, one line per fact, so the facts never run into each other. */
function ScanText({ scan }: { scan: ScanStatus }) {
  const { t, tr, p } = useApp();
  const { day, at } = useDates();
  const lines: string[] = [];
  if (scan.status === 'running') {
    lines.push(fill(t.m5ScanRunning, { n: scan.messagesRead }), t.m5ScanRunningAway);
  } else if (scan.status === 'complete') {
    lines.push(tr('m5ScanDone', { n: scan.messagesRead, from: day(scan.from), until: day(scan.until) }));
    lines.push(fill(t.m5ScanStartedAt, at(scan.startedAt)));
    lines.push(tr('m5ScanFound', { n: scan.observationsFound }));
    if (scan.addedFromEmail > 0) lines.push(tr('m5ScanAdded', { n: scan.addedFromEmail }));
  } else {
    lines.push(failureText(t, scan.failure));
    lines.push(fill(t.m5ScanFailedCount, { n: scan.messagesRead }));
  }
  if (scan.messagesUnavailable > 0) lines.push(tr('m5ScanUnavailable', { n: scan.messagesUnavailable }));
  if (scan.messagesTrimmed > 0) lines.push(tr('m5ScanTrimmed', { n: scan.messagesTrimmed }));
  return (
    <Txt role="supporting" color={p.mu} lh={1.6} testID="email-scan-lines">
      {scan.status === 'failed' ? <Txt role="supporting" color={p.wm}>{lines[0]}</Txt> : lines[0]}
      {lines.slice(1).map((line) => `\n${line}`).join('')}
    </Txt>
  );
}

/** A failed scan's one action: reconnect Google, or carry on where it stopped. */
function Recovery({ scan, onReconnect }: { scan: ScanStatus & { status: 'failed' }; onReconnect: () => void }) {
  const { t } = useApp();
  const uid = useUid();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const resume = useCallback(async () => {
    setBusy(true);
    try {
      const answer = await postEmailScan({ intent: 'resume', expectedScanId: scan.scanId }, { asUid: uid });
      client.setQueryData<EmailScanOverview>(emailScanKey(uid), (previous) => ({
        success: true, manual: answer.scan, queuedManual: answer.queuedManual ?? previous?.queuedManual ?? null, daily: previous?.daily ?? null,
      }));
    } catch {
      // The line still shows where it stopped; the button stays.
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: emailScanKey(uid) });
    }
  }, [client, scan.scanId, uid]);
  return scan.failure === 'reconnect_needed'
    ? <Pill testID="email-scan-reconnect" label={t.m5ScanReconnect} kind="accent" size={14} pad={12} onPress={onReconnect} />
    : <Pill testID="email-scan-resume" label={t.m5ScanResume} kind="accent" size={14} pad={12} disabled={busy} onPress={() => void resume()} />;
}

/**
 * A quota or rate wait, said distinctly, with when it carries on by itself
 * (M5A-R30-004). Not a live region of its own: it is drawn inside one.
 */
export function WaitLine({ wait }: { wait: ScanWait }) {
  const { t, p } = useApp();
  const { when } = useDates();
  return (
    <View testID="email-scan-wait">
      <Txt role="supporting" color={p.mu} testID={`email-scan-wait-${wait.reason}`}>
        {wait.reason === 'daily_ai_limit' ? fill(t.m5ScanQuotaWait, { when: when(wait.resumesAt) }) : t.m5ScanRateWait}
      </Txt>
    </View>
  );
}

function QueuedLine({ queued }: { queued: QueuedScan }) {
  const { t, p } = useApp();
  const { day } = useDates();
  return <Txt role="supporting" color={p.mu} testID="email-scan-queued">{fill(t.m5ScanQueued, { from: day(queued.from), until: day(queued.until) })}</Txt>;
}

function DailyLine({ daily }: { daily: DailyStatus }) {
  const { t, tr, p } = useApp();
  const { dayKey } = useDates();
  // A failed sweep says what failed, never a summary that reads like success.
  const text = daily.status === 'held' ? t.m5ScanDailyNoTimezone
    : daily.status === 'failed' ? failureText(t, daily.failure)
      : tr('m5ScanDaily', { n: daily.messagesRead, date: dayKey(daily.day) });
  return (
    <View testID="email-scan-daily" style={{ gap: 4 }}>
      <Txt role="supporting" color={daily.status === 'held' || daily.status === 'failed' ? p.wm : p.mu}>{text}</Txt>
      {daily.status === 'running' && daily.waiting ? <WaitLine wait={daily.waiting} /> : null}
    </View>
  );
}
