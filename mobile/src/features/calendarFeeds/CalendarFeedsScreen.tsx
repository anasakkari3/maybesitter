import React, { useRef, useState } from 'react';
import { ActivityIndicator, Switch, TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader } from '../settings/SettingsChrome';
import { icsFeedsEnabled } from '../../config/env';
import { fill } from '../../i18n/strings';
import { isolate, isolateAuto } from '../../i18n/bidi';
import { formatDate, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import {
  useCreateIcsFeed,
  useDecideIcsDeadline,
  useDeleteIcsFeed,
  useIcsFeeds,
  useRefreshIcsFeed,
  useTrust,
  useTrustAction,
  useUpdateIcsFeed,
} from '../../api/queries';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { IcsDeadline, IcsDeadlineAction, IcsFeed } from '../../api/schemas/icsFeeds';

/**
 * Settings → Calendar → Calendar links (UC-3.4, #188).
 *
 * Paste a university calendar link once; lectures become busy time and
 * deadlines arrive as suggestions. Four parts, top to bottom: a banner when a
 * feed has not been readable for a while, the paste form (or, without calendar
 * consent, the switch that allows it), the feeds, and the deadlines waiting.
 *
 * ── The link is a password, and this screen treats it as one ─────
 *
 * A Moodle export link carries `authtoken=`: whoever holds it reads the
 * student's calendar. So the URL exists on the phone only as the text field's
 * value and the one request body that sends it. On success the field is
 * emptied and the mutation reset, so its `variables` do not linger; the server
 * never sends the URL back; nothing here logs; and the input opts out of
 * autofill and autocorrect so the keyboard does not learn it. A saved feed is
 * shown by its name, never by its link.
 *
 * ── Nothing is decided for the user ──────────────────────────────
 *
 * A deadline is a suggestion, and says so with the app's standing sentence.
 * Auto-accept is off unless they turn it on for that feed, and anything it
 * added carries an Undo. When the calendar moves something they already kept,
 * their commitment waits for them to say "move mine too".
 */
export function CalendarFeedsScreen({ onBack }: { onBack: () => void }) {
  const { t, p, rtl } = useApp();
  const enabled = icsFeedsEnabled();

  return (
    <Screen pinned={<SettingsHeader title={t.icsFeedsTitle} onBack={onBack} />}>
      <ScreenScroll keyboardShouldPersistTaps="handled">
        {enabled ? <FeedsBody rtl={rtl} /> : (
          <Card pad={18}>
            <Txt size={14} color={p.mu} lh={1.5} testID="ics-unavailable">{t.icsFeedsUnavailable}</Txt>
          </Card>
        )}
      </ScreenScroll>
    </Screen>
  );
}

function FeedsBody({ rtl }: { rtl: boolean }) {
  const { t, p } = useApp();
  const feeds = useIcsFeeds();
  const trust = useTrust();
  const consented = trust.data?.trust.calendarConsent === true;
  const list = feeds.data?.feeds ?? [];
  const deadlines = feeds.data?.deadlines ?? [];

  return (
    <>
      {/* Its advice is "refresh", which is not offered without consent. */}
      {consented && list.some(feed => feed.status === 'error') ? (
        <Card pad={18} testID="ics-banner">
          <Txt size={14} lh={1.5}>{t.icsFeedsBanner}</Txt>
        </Card>
      ) : null}

      <Card pad={18} style={{ gap: 10 }}>
        <Txt size={14} color={p.mu} lh={1.5}>{t.icsFeedsIntro}</Txt>
        {trust.data === undefined ? null : consented ? <AddFeed rtl={rtl} /> : <ConsentCard />}
      </Card>

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <View style={{ paddingVertical: 14, paddingHorizontal: 18 }}>
          <Txt size={15}>{t.icsFeedsListTitle}</Txt>
        </View>
        {feeds.data !== undefined && list.length === 0 ? (
          <View style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln }}>
            <Txt size={13} color={p.mu} testID="ics-empty">{t.icsFeedsEmpty}</Txt>
          </View>
        ) : null}
        {list.map(feed => <FeedRow key={feed.feedId} feed={feed} consented={consented} />)}
      </Card>

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <View style={{ paddingVertical: 14, paddingHorizontal: 18, gap: 4 }}>
          <Txt size={15}>{t.icsFeedsDeadlinesTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5} testID="ics-suggestion-note">{t.suggestionNote}</Txt>
        </View>
        {feeds.data !== undefined && deadlines.length === 0 ? (
          <View style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln }}>
            <Txt size={13} color={p.mu} testID="ics-nothing-waiting">{t.icsFeedsNothingWaiting}</Txt>
          </View>
        ) : null}
        {deadlines.map(deadline => <DeadlineRow key={deadline.itemKey} deadline={deadline} consented={consented} />)}
      </Card>
    </>
  );
}

function ConsentCard() {
  const { t, p } = useApp();
  const action = useTrustAction();
  return (
    <View style={{ gap: 10 }} testID="ics-consent">
      <Txt size={15}>{t.icsFeedsConsentTitle}</Txt>
      <Txt size={13} color={p.mu} lh={1.5}>{t.icsFeedsConsentBody}</Txt>
      <ActionButton
        label={t.icsFeedsConsentAction}
        testID="ics-consent-allow"
        busy={action.isPending}
        onPress={() => action.mutate({ type: 'set_calendar_consent', granted: true })}
      />
      {action.isError ? (
        <Txt size={13} color={p.mu} lh={1.5} testID="ics-consent-error">{userFacingMessage(action.error, t)}</Txt>
      ) : null}
    </View>
  );
}

function AddFeed({ rtl }: { rtl: boolean }) {
  const { t, p } = useApp();
  const create = useCreateIcsFeed();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [autoAccept, setAutoAccept] = useState(false);
  const [preview, setPreview] = useState<{ deadlines: number; busyBlocks: number; skipped: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const submit = () => {
    const pasted = url.trim();
    if (pasted === '') return;
    setError(null);
    setPreview(null);
    create.mutate(
      { url: pasted, label: name.trim() === '' ? null : name.trim(), autoAcceptDeadlines: autoAccept },
      {
        onSuccess: result => {
          // Gone from the phone the moment it is saved: the field, and the
          // mutation's own copy of what it sent.
          setUrl('');
          setName('');
          setAutoAccept(false);
          setPreview(result.preview);
          create.reset();
        },
        onError: failure => {
          // Kept in the field so a typo can be fixed; not kept anywhere else.
          setError(failure);
          create.reset();
        },
      },
    );
  };

  const inputStyle = {
    color: p.tx, fontSize: 15, minHeight: 44, borderWidth: 1, borderColor: p.ln, borderRadius: 12,
    paddingHorizontal: 12, textAlign: rtl ? 'right' as const : 'left' as const,
  };

  return (
    <View style={{ gap: 10 }}>
      <Txt size={13} color={p.mu} lh={1.5} testID="ics-help">{t.icsFeedsHelp}</Txt>
      <TextInput
        testID="ics-url-input"
        accessibilityLabel={t.icsFeedsUrlLabel}
        placeholder={t.icsFeedsUrlLabel}
        placeholderTextColor={p.mu}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        spellCheck={false}
        keyboardType="url"
        // A link reads left to right in any language, so this one field keeps
        // the physical left on purpose.
        // eslint-disable-next-line no-restricted-syntax
        style={{ ...inputStyle, textAlign: 'left', writingDirection: 'ltr' }}
      />
      <TextInput
        testID="ics-name-input"
        accessibilityLabel={t.icsFeedsNameLabel}
        placeholder={t.icsFeedsNameLabel}
        placeholderTextColor={p.mu}
        value={name}
        onChangeText={setName}
        maxLength={60}
        style={inputStyle}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 4, alignItems: 'flex-start' }}>
          <Txt size={15}>{t.icsFeedsAutoAccept}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.icsFeedsAutoAcceptBody}</Txt>
        </View>
        <Switch
          testID="ics-auto-accept-new"
          accessibilityLabel={t.icsFeedsAutoAccept}
          value={autoAccept}
          onValueChange={setAutoAccept}
          trackColor={{ false: p.ln, true: p.ac }}
        />
      </View>
      <Txt size={13} color={p.mu} lh={1.5}>{t.icsFeedsPrivacy}</Txt>
      <ActionButton
        label={t.icsFeedsSubscribe}
        testID="ics-subscribe"
        busy={create.isPending}
        disabled={url.trim() === ''}
        onPress={submit}
      />
      {error ? <Txt size={13} color={p.mu} lh={1.5} testID="ics-subscribe-error">{userFacingMessage(error, t)}</Txt> : null}
      {preview ? (
        <View style={{ gap: 4 }} testID="ics-preview">
          <Txt size={15}>{t.icsFeedsPreviewTitle}</Txt>
          <Txt size={13} color={p.mu} testID="ics-preview-deadlines">{fill(t.icsFeedsPreviewDeadlines, { n: preview.deadlines })}</Txt>
          <Txt size={13} color={p.mu} testID="ics-preview-busy">{fill(t.icsFeedsPreviewBusy, { n: preview.busyBlocks })}</Txt>
          {preview.skipped > 0 ? (
            <Txt size={13} color={p.mu}>{fill(t.icsFeedsPreviewSkipped, { n: preview.skipped })}</Txt>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function useWhen() {
  const { lang } = useApp();
  const timeZone = useTimeZone();
  return (iso: string, allDay: boolean): string => {
    const date = new Date(iso);
    const day = formatDate(date, 'weekday', { locale: lang, timeZone });
    // The day is words, so its own first letter decides; only the time is
    // held left-to-right.
    return isolateAuto(allDay ? day : `${day} ${isolate(formatTime(date, { locale: lang, timeZone }))}`);
  };
}

/**
 * One feed. Without calendar consent it is shown paused whatever the server
 * last said, and offers nothing that would read the calendar again — no
 * refresh, no auto-accept — only Remove, which must always be possible.
 */
function FeedRow({ feed, consented }: { feed: IcsFeed; consented: boolean }) {
  const { t, p } = useApp();
  const when = useWhen();
  const update = useUpdateIcsFeed();
  const refresh = useRefreshIcsFeed();
  const remove = useDeleteIcsFeed();
  const [confirming, setConfirming] = useState(false);
  const failure = refresh.error ?? update.error ?? remove.error;

  return (
    <View
      testID={`ics-feed-${feed.feedId}`}
      style={{ paddingVertical: 14, paddingHorizontal: 18, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}
    >
      <Txt size={15}>{feed.label ? isolate(feed.label, 'rtl') : t.icsFeedsUrlLabel}</Txt>
      {!consented || feed.status === 'paused' ? (
        <Txt size={13} color={p.mu} testID={`ics-feed-paused-${feed.feedId}`}>{t.icsFeedsStatusPaused}</Txt>
      ) : feed.status === 'error' ? (
        <Txt size={13} color={p.wm} testID={`ics-feed-error-${feed.feedId}`}>{t.icsFeedsStatusError}</Txt>
      ) : null}
      {feed.lastFetchedAt ? (
        <Txt size={13} color={p.mu}>{fill(t.icsFeedsUpdated, { when: when(feed.lastFetchedAt, false) })}</Txt>
      ) : null}
      {consented ? (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Txt size={13} style={{ flex: 1 }}>{t.icsFeedsAutoAccept}</Txt>
        <Switch
          testID={`ics-auto-accept-${feed.feedId}`}
          accessibilityLabel={t.icsFeedsAutoAccept}
          value={feed.autoAcceptDeadlines}
          disabled={update.isPending}
          onValueChange={next => update.mutate({ feedId: feed.feedId, autoAcceptDeadlines: next })}
          trackColor={{ false: p.ln, true: p.ac }}
        />
      </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        {consented ? (
          <SmallButton
            label={t.icsFeedsRefresh}
            testID={`ics-refresh-${feed.feedId}`}
            busy={refresh.isPending}
            onPress={() => refresh.mutate(feed.feedId)}
          />
        ) : null}
        {confirming ? null : (
          <SmallButton label={t.icsFeedsRemove} testID={`ics-remove-${feed.feedId}`} onPress={() => setConfirming(true)} />
        )}
      </View>
      {confirming ? (
        <View style={{ gap: 8 }}>
          <Txt size={13} color={p.mu} lh={1.5}>{t.icsFeedsRemoveConfirm}</Txt>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <SmallButton
              label={t.icsFeedsRemoveYes}
              testID={`ics-remove-confirm-${feed.feedId}`}
              busy={remove.isPending}
              onPress={() => remove.mutate(feed.feedId, { onSettled: () => setConfirming(false) })}
            />
            <SmallButton label={t.icsFeedsKeep} testID={`ics-remove-cancel-${feed.feedId}`} onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
      {failure ? <Txt size={13} color={p.mu} lh={1.5} testID={`ics-feed-failure-${feed.feedId}`}>{userFacingMessage(failure, t)}</Txt> : null}
    </View>
  );
}

/**
 * One deadline. Every action is disabled while a decision on this row is on its
 * way, so Add followed by Skip before the first answer cannot send both.
 * Without calendar consent nothing that acts on the calendar's data is offered
 * — no Add, no "move mine too" — while Skip, Undo and acknowledging stay, so a
 * person can always take back what the feed did.
 */
function DeadlineRow({ deadline, consented }: { deadline: IcsDeadline; consented: boolean }) {
  const { t, p } = useApp();
  const when = useWhen();
  const decide = useDecideIcsDeadline();
  // A ref as well as `isPending`: the mutation reports pending only after a
  // render, and two taps inside that frame would both be sent.
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const act = (action: IcsDeadlineAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    decide.mutate(
      { feedId: deadline.feedId, itemKey: deadline.itemKey, action },
      { onSettled: () => { inFlight.current = false; setSending(false); } },
    );
  };
  const id = deadline.itemKey;
  const busy = sending || decide.isPending;

  let status: React.ReactNode = null;
  let actions: React.ReactNode = null;
  if (deadline.state === 'pending') {
    actions = (
      <>
        {consented ? (
          <SmallButton label={t.icsFeedsAccept} testID={`ics-accept-${id}`} busy={busy} onPress={() => act('accept')} />
        ) : null}
        <SmallButton label={t.icsFeedsSkip} testID={`ics-skip-${id}`} busy={busy} onPress={() => act('dismiss')} />
      </>
    );
  } else if (deadline.notice === 'moved' && deadline.proposedDueAt) {
    status = (
      <Txt size={13} color={p.mu} lh={1.5} testID={`ics-moved-${id}`}>
        {fill(t.icsFeedsMoved, { when: when(deadline.proposedDueAt, deadline.allDay) })}
      </Txt>
    );
    actions = (
      <>
        {consented ? (
          <SmallButton label={t.icsFeedsApplyMove} testID={`ics-apply-move-${id}`} busy={busy} onPress={() => act('apply_move')} />
        ) : null}
        <SmallButton label={t.icsFeedsKeepTime} testID={`ics-keep-time-${id}`} busy={busy} onPress={() => act('acknowledge')} />
      </>
    );
  } else if (deadline.notice === 'removed') {
    status = <Txt size={13} color={p.mu} lh={1.5} testID={`ics-removed-${id}`}>{t.icsFeedsRemovedFromSource}</Txt>;
    actions = <SmallButton label={t.icsFeedsGotIt} testID={`ics-got-it-${id}`} busy={busy} onPress={() => act('acknowledge')} />;
  } else if (deadline.state === 'accepted' && deadline.autoAccepted) {
    status = <Txt size={13} color={p.mu} testID={`ics-auto-added-${id}`}>{t.icsFeedsAutoAdded}</Txt>;
    actions = <SmallButton label={t.icsFeedsUndo} testID={`ics-undo-${id}`} busy={busy} onPress={() => act('undo')} />;
  }

  return (
    <View testID={`ics-deadline-${id}`} style={{ paddingVertical: 14, paddingHorizontal: 18, gap: 8, borderTopWidth: 1, borderTopColor: p.ln }}>
      <Txt size={15}>{isolate(deadline.title, 'rtl')}</Txt>
      <Txt size={13} color={p.mu}>{fill(t.icsFeedsDue, { when: when(deadline.dueAt, deadline.allDay) })}</Txt>
      {status}
      {actions ? <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{actions}</View> : null}
      {decide.isError ? (
        <Txt size={13} color={p.mu} lh={1.5} testID={`ics-deadline-failure-${id}`}>{userFacingMessage(decide.error, t)}</Txt>
      ) : null}
    </View>
  );
}

function ActionButton({ label, testID, onPress, busy = false, disabled = false }: {
  label: string; testID: string; onPress: () => void; busy?: boolean; disabled?: boolean;
}) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy}
      style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln }}
    >
      {busy ? <ActivityIndicator color={p.ac} /> : <Txt size={15} color={p.ac}>{label}</Txt>}
    </Btn>
  );
}

function SmallButton({ label, testID, onPress, busy = false }: {
  label: string; testID: string; onPress: () => void; busy?: boolean;
}) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      testID={testID}
      onPress={onPress}
      disabled={busy}
      hitSlop={8}
      style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: p.ln }}
    >
      <Txt size={14} color={p.ac}>{label}</Txt>
    </Btn>
  );
}
