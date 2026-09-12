import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useSingleFlight } from '../auth/useSingleFlight';
import { requestAdditionalScopes, revokeGoogleAccess } from '../auth/googleSignIn';
import { CALENDAR_SCOPES } from '../features/calendarDemo/scopes';
import { fetchBusy, insertDemoEvent, listCalendars, type CalendarSummary } from '../features/calendarDemo/calendarApi';
import { findOverlaps, mergeBusy, type BusyInterval } from '../features/calendarDemo/overlap';
import { Card, FlowHeader, Pill, Txt } from '../ui/primitives';

/**
 * The Google OAuth verification demo (UC-1.8 #152). Development only.
 *
 * This screen exists to be filmed for a Google reviewer, showing that the two
 * requested scopes are used for exactly what the justification says: read when
 * the user is busy (start and end only), list calendar *names* so they can
 * choose which count, and — only on an explicit tap — write one event.
 *
 * It is unreachable unless `googleCalendarDemoEnabled()` is true, which needs a
 * development bundle, `APP_ENV=development`, and the variable set in a
 * developer's own `.env.local`. `releaseConfigProblems` refuses to configure a
 * staging or production build that sets it at all.
 *
 * Nothing here reaches MaybeSitter's backend, and nothing is stored: the
 * access token is in component state and dies with the screen. The copy is
 * English only — it is a demo for a reviewer, not product UI, and adding it to
 * the locale files would put reviewer-facing strings in front of translators.
 */
export function CalendarDemoScreen({ onBack }: { onBack: () => void }) {
  const { p } = useApp();
  const { busy: working, run } = useSingleFlight();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busyTimes, setBusyTimes] = useState<BusyInterval[]>([]);
  const [candidate, setCandidate] = useState<BusyInterval | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Not connected.');

  const merged = useMemo(() => mergeBusy(busyTimes), [busyTimes]);
  const conflicts = useMemo(() => (candidate ? findOverlaps(merged, candidate) : []), [merged, candidate]);

  const connect = useCallback(
    () =>
      run(async () => {
        setStatus('Asking for calendar access…');
        try {
          const token = await requestAdditionalScopes(CALENDAR_SCOPES);
          if (!token) {
            setStatus('Access declined. Nothing was read.');
            return;
          }
          setAccessToken(token);
          const list = await listCalendars(token);
          setCalendars(list);
          setStatus(`${list.length} calendar(s). Names only — no events were read yet.`);
        } catch {
          setStatus('Could not connect.');
        }
      }),
    [run],
  );

  const loadBusy = useCallback(
    () =>
      run(async () => {
        if (!accessToken || selected.length === 0) return;
        setStatus('Reading busy times (start and end only)…');
        try {
          const from = new Date();
          const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
          const ranges = await fetchBusy(accessToken, selected, from, to);
          setBusyTimes(ranges);
          setStatus(`${ranges.length} busy range(s) over the next 7 days. No titles were requested.`);
        } catch {
          setStatus('Could not read busy times.');
        }
      }),
    [run, accessToken, selected],
  );

  const checkNextFreeHour = useCallback(() => {
    // A fixed candidate rather than a picker: the video script checks one
    // specific time, and a date picker is a dependency this demo does not need.
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    setCandidate({ start: start.toISOString(), end: end.toISOString() });
  }, []);

  const addEvent = useCallback(
    () =>
      run(async () => {
        if (!accessToken || !candidate) return;
        setStatus('Adding one event you confirmed…');
        try {
          const result = await insertDemoEvent(accessToken, {
            summary: 'MaybeSitter demo commitment',
            start: new Date(candidate.start),
            end: new Date(candidate.end),
            commitmentId: `demo-${Date.now()}`,
          });
          setWritten(result.htmlLink);
          setStatus('Event added. Only commitments you confirm are written.');
        } catch {
          setStatus('Could not add the event.');
        }
      }),
    [run, accessToken, candidate],
  );

  const disconnect = useCallback(
    () =>
      run(async () => {
        try {
          await revokeGoogleAccess();
        } finally {
          setAccessToken(null);
          setCalendars([]);
          setSelected([]);
          setBusyTimes([]);
          setCandidate(null);
          setWritten(null);
          setStatus('Disconnected. Access revoked.');
        }
      }),
    [run],
  );

  const toggle = (id: string) =>
    setSelected(current => (current.includes(id) ? current.filter(other => other !== id) : [...current, id]));

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <FlowHeader pill="Back" onPill={onBack} title="Calendar demo (dev only)" />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Txt size={20} weight={600}>Google Calendar verification demo</Txt>
        <Card pad={14} style={{ gap: 6 }}>
          <Txt size={12} color={p.mu}>Scopes requested</Txt>
          {CALENDAR_SCOPES.map(scope => (
            <Txt key={scope} size={12} latin>{scope}</Txt>
          ))}
        </Card>

        <View testID="calendar-demo-status">
          <Txt size={13} color={p.mu}>{status}</Txt>
        </View>

        {accessToken === null ? (
          <Pill label="Connect Google Calendar" kind="accent" disabled={working} onPress={() => void connect()} />
        ) : (
          <>
            <Card pad={14} style={{ gap: 10 }}>
              <Txt size={13} color={p.mu}>Your calendars — names only</Txt>
              {calendars.map(calendar => (
                <Pill
                  key={calendar.id}
                  label={`${selected.includes(calendar.id) ? '✓ ' : ''}${calendar.summary}`}
                  kind={selected.includes(calendar.id) ? 'soft' : 'outline'}
                  size={14}
                  pad={10}
                  onPress={() => toggle(calendar.id)}
                />
              ))}
            </Card>

            <Pill
              label="Show busy times (next 7 days)"
              kind="outline"
              disabled={working || selected.length === 0}
              onPress={() => void loadBusy()}
            />

            {merged.length > 0 ? (
              <Card pad={14} style={{ gap: 4 }}>
                <Txt size={13} color={p.mu}>Busy — start and end only</Txt>
                {merged.map(interval => (
                  <Txt key={`${interval.start}-${interval.end}`} size={12} latin>
                    {`${interval.start} → ${interval.end}`}
                  </Txt>
                ))}
              </Card>
            ) : null}

            <Pill label="Check the next full hour" kind="outline" onPress={checkNextFreeHour} />

            {candidate ? (
              <Card pad={14} style={{ gap: 6 }}>
                <Txt size={12} latin>{`${candidate.start} → ${candidate.end}`}</Txt>
                <Txt size={13} color={conflicts.length > 0 ? p.wm : p.ac}>
                  {conflicts.length > 0
                    ? `Overlaps ${conflicts.length} busy block(s).`
                    : 'Free — nothing else then.'}
                </Txt>
              </Card>
            ) : null}

            <Pill
              label="Add to calendar"
              kind="accent"
              disabled={working || candidate === null}
              onPress={() => void addEvent()}
            />
            {written ? <Txt size={12} latin>{written}</Txt> : null}

            <Pill label="Disconnect" kind="ghost" disabled={working} onPress={() => void disconnect()} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
