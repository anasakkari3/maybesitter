import React from 'react';
import { AccessibilityInfo, TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import {
  useCreateHabit,
  useDeleteHabit,
  useHabits,
  usePlan,
  usePlanAction,
  useSetHabitStatus,
} from '../../api/queries';
import { PlanProposalRefusedError } from '../../api/errors';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { calendarReadEnabled, calendarWriteEnabled } from '../../config/env';
import { LANGUAGE_ENDONYM } from '../../i18n/language';
import { isolate, isolateAuto } from '../../i18n/bidi';
import { dayKey, formatTimeRange } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { BrandMark } from '../../ui/brand';
import { Pill, Txt } from '../../ui/primitives';
import { Dialog } from '../../ui/dialog';
import { ProductActions, ProductPage, ProductSection, ProductRow } from '../../ui/product';
import { capabilities as cap, shareCapability } from './capabilities';
import { ShareGuideSheet, type ShareGuideKind } from './ShareGuideSheet';

export function MyMaybeSitterScreen() {
  const { t, actions, lang } = useApp();
  const { user } = useAuth();
  return <ProductPage id="my" title={t.xMy} subtitle={t.xMyBody}>
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 12 }}><BrandMark size={76} /></View>
    <ProductSection title={t.accountTitle} icon="person">
      <ProductRow title={t.xName} body={user?.displayName ? isolateAuto(user.displayName) : t.xNotSet} icon="person" />
      <ProductRow title={t.accountTitle} body={user?.email ? isolate(user.email) : t.authSignedInPrivateApple} icon="shield" onPress={() => actions.go('account')} />
      <ProductRow title={t.settingsLangAppearance} body={LANGUAGE_ENDONYM[lang]} icon="spark" onPress={() => actions.go('langAppearance')} />
    </ProductSection>
    <ProductSection title={t.settingsGroupReminders} icon="watch">
      <ProductRow title={t.notifTitle} body={t.settingsRemindersSub} icon="watch" onPress={() => actions.go('notificationsSettings')} />
      <ProductRow title={t.settingsRoutine} body={t.settingsRoutineSub} icon="calendar" onPress={() => actions.go('routineSettings')} />
      <ProductRow title={t.xPersonalization} icon="person" onPress={() => actions.go('personalization')} />
    </ProductSection>
    <ProductSection title={t.xPersonality} status={cap.assistantPersonality} icon="spark">
      <ProductRow title={t.xAssistantName} body="MaybeSitter" status={cap.assistantName} />
    </ProductSection>
  </ProductPage>;
}

/** A row's action only when it has one: a Coming-soon row is not a button. */
const when = (status: string, action: () => void) => status === 'COMING_SOON' ? undefined : action;

export function IntegrationsScreen() {
  const { t, actions } = useApp();
  const [guide, setGuide] = React.useState<ShareGuideKind | null>(null);
  const deviceStatus = calendarReadEnabled() || calendarWriteEnabled() ? 'AVAILABLE' as const : 'COMING_SOON' as const;
  const share = shareCapability();
  return <ProductPage id="integrations" title={t.xIntegrations} subtitle={t.xIntegrationsBody}
    overlay={guide ? <ShareGuideSheet kind={guide} onClose={() => setGuide(null)} /> : null}>
    <ProductRow id="integration-device" title={t.xDeviceCalendar} body={t.xDeviceBody} icon="calendar" status={deviceStatus} onPress={when(deviceStatus, () => actions.go('calendarSettings'))} />
    <ProductRow id="integration-whatsapp" title="WhatsApp" body={t.xWhatsappBody} icon="link" status={share} onPress={when(share, () => setGuide('whatsapp'))} />
    {/* Google Calendar works today through the phone's calendar, which the
        page explains; the direct connection is its Coming-soon section. */}
    <ProductRow id="integration-google" title="Google Calendar" body={t.xGoogleBody} icon="calendar" onPress={() => actions.go('googleIntegration')} />
    <ProductRow title={t.xHealth} icon="habit" onPress={() => actions.go('readinessSettings')} />
    <ProductRow title={t.settingsSources} body={t.settingsSourcesSub} icon="link" onPress={() => actions.go('sources')} />
    <ProductRow title="Gmail" icon="file" status={cap.gmail} />
    <ProductRow title="Google Drive" icon="file" status={cap.drive} />
    <ProductRow title={t.xLocation} icon="goal" status={cap.location} />
  </ProductPage>;
}

export function GoogleIntegrationScreen() {
  const { t, actions } = useApp();
  return <ProductPage id="google" title={t.xGoogleDetail}>
    <ProductSection title="Google Calendar" body={t.xGoogleBody} icon="calendar">
      <Pill testID="google-device-settings" label={t.calendarWriteTitle} kind="accent" onPress={() => actions.go('calendarSettings')} />
    </ProductSection>
    <ProductSection title={t.xDirectConnection} icon="link" status={cap.googleCalendar} />
    <ProductSection title={t.xPrivacy} body={t.xCalendarPrivacy} icon="shield">
      <Pill label={t.sTrust} kind="outline" onPress={() => actions.go('trust')} />
    </ProductSection>
    <ProductRow title="Gmail" icon="file" status={cap.gmail} />
  </ProductPage>;
}

export function ActionModesScreen() {
  const { t, actions } = useApp();
  const zone = useTimeZone();
  return <ProductPage id="modes" title={t.xModes} subtitle={t.xModesBody}>
    <ProductRow id="mode-quick" title={t.xQuick} body={t.xQuickBody} icon="spark" onPress={() => actions.go('capture')} />
    <ProductRow id="mode-plan" title={t.xPlanner} body={t.xPlannerBody} icon="calendar" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
    <ProductSection title={t.xWeekly} icon="goal" status={cap.weeklyMode} />
  </ProductPage>;
}

export function AddToMaybeSitterScreen() {
  const { t, actions } = useApp();
  const zone = useTimeZone();
  const [guide, setGuide] = React.useState<ShareGuideKind | null>(null);
  const share = shareCapability();
  return <ProductPage id="add" title={t.xAdd} subtitle={t.xAddBody}
    overlay={guide ? <ShareGuideSheet kind={guide} onClose={() => setGuide(null)} /> : null}>
    <ProductSection title={t.xShareGuide} body={share === 'COMING_SOON' ? undefined : t.xShareGuideBody} icon="link">
      <ProductRow id="add-whatsapp" title="WhatsApp" icon="link" status={share} onPress={when(share, () => setGuide('whatsapp'))} />
      <ProductRow id="add-pdf" title={t.xFiles} icon="file" status={share} onPress={when(share, () => setGuide('files'))} />
      <ProductRow id="add-photos" title={t.xPhotos} icon="photo" status={share} onPress={when(share, () => setGuide('files'))} />
      <ProductRow title={t.xCamera} icon="photo" status={cap.camera} />
    </ProductSection>
    <ProductRow id="add-capture" title={t.xQuick} body={t.xQuickBody} icon="check" onPress={() => actions.go('capture')} />
    <ProductRow title={t.xPlanner} icon="calendar" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
    <ProductRow title={t.notifTitle} icon="watch" onPress={() => actions.go('notificationsSettings')} />
    <ProductRow title={t.memoryScreenTitle} icon="person" onPress={() => actions.go('knows')} />
    <ProductRow title={t.xCoordination} icon="link" status={cap.assistantPreparation} />
  </ProductPage>;
}

export { GoalExecutionScreen } from '../goals/GoalExecutionScreen';

/**
 * The sentence a proposal's `reason` is shown as — never the code itself.
 *
 * `reason` is the server's internal policy vocabulary (`REPLAN_POLICY_REASONS`),
 * shipped as a bare string. These are the four the policy can attach to a
 * `propose_for_review` decision; anything else, including a reason added on the
 * server later, reads as the generic sentence rather than as
 * `churn_exceeded_threshold` in the middle of an Arabic screen. The schema keeps
 * `reason` a plain string on purpose, so a new server value is not a parse
 * failure that blanks the whole plan.
 */
const PATCH_REASON_KEYS = {
  user_requires_confirmation: 'xPatchWhyConfirm',
  contains_removals: 'xPatchWhyRemovals',
  contains_additions: 'xPatchWhyAdditions',
  churn_exceeded_threshold: 'xPatchWhyChurn',
} as const;

export function patchReasonKey(reason: string): (typeof PATCH_REASON_KEYS)[keyof typeof PATCH_REASON_KEYS] | 'xPatchWhyOther' {
  return Object.prototype.hasOwnProperty.call(PATCH_REASON_KEYS, reason)
    ? PATCH_REASON_KEYS[reason as keyof typeof PATCH_REASON_KEYS]
    : 'xPatchWhyOther';
}

export function PatchReviewScreen() {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const date = dayKey(new Date(), zone);
  const query = usePlan(date);
  const action = usePlanAction(date);
  const proposal = query.data?.proposal ?? null;
  // The offer on screen was not the one the server held (#611): the day moved
  // on, a newer offer replaced it, or nothing is pending any more. That is
  // not the person's mistake, so it gets its own sentence rather than the
  // generic "check it and try again", and it sits above the plan rather than
  // beside the buttons: the plan query is re-read (`usePlanAction`), and when
  // nothing is pending the offer and its buttons are no longer drawn at all.
  const refused = action.error instanceof PlanProposalRefusedError ? action.error : null;
  // An offer refused as stale can come back unchanged from the re-read: the
  // server leaves it on the table until the next replan tick replaces it, so
  // for a few minutes the same id is still pending. Accepting it again could
  // only be refused again, so that one offer's Accept is held; declining it
  // is still honest and still allowed.
  const [staleOfferId, setStaleOfferId] = React.useState<string | null>(null);
  const decide = (decision: 'accept_proposal' | 'reject_proposal') => {
    // The offer being answered is named, so an accept cannot install a newer
    // offer the person has not seen.
    const proposalId = proposal?.proposalId;
    action.mutate(proposalId ? { action: decision, proposalId } : { action: decision }, {
      onError: error => {
        if (!(error instanceof PlanProposalRefusedError)) return;
        if (error.reason === 'stale_proposal' && proposalId) setStaleOfferId(proposalId);
        // Said aloud as well as shown: the sentence appears away from the
        // button that was pressed, where a screen reader's focus is not.
        AccessibilityInfo.announceForAccessibility(userFacingMessage(error, t));
      },
    });
  };
  // Until the re-read lands, the offer on screen is the one just refused;
  // pressing it again could only be refused again.
  const busy = action.isPending || (refused !== null && query.isFetching === true);
  const range = (interval: { startsAt: string; endsAt: string } | null) => interval
    ? formatTimeRange(new Date(interval.startsAt), new Date(interval.endsAt), { locale: lang, timeZone: query.data?.timezone ?? zone })
    : t.xNotSet;
  // A protection the patch overrides is not something that "stays protected",
  // so it is never listed under that heading. It gets its own section, said in
  // words, above the buttons: consenting blind to an override is the one
  // outcome the `protections` field exists to prevent (#523, #588). A block the
  // patch leaves unplaced is the strongest override, and says so rather than
  // showing an empty time.
  const overridden = proposal?.protections.filter(protection => protection.overridden) ?? [];
  const kept = proposal?.protections.filter(protection => !protection.overridden) ?? [];
  const protectionRow = (protection: NonNullable<typeof proposal>['protections'][number]) => <ProductRow
    key={protection.blockId}
    id={`patch-protection-${protection.blockId}`}
    title={protection.title ? isolateAuto(protection.title) : protection.itemId}
    body={protection.overridden
      // What the user would give up, next to what they would get: the time
      // they protected, then the proposed one.
      ? `${t.xProtectedTime}: ${range(protection.preferredInterval)} · ${t.xAfter}: ${protection.proposedInterval ? range(protection.proposedInterval) : t.xUnplaced}`
      : protection.proposedInterval ? range(protection.proposedInterval) : t.xUnplaced}
    icon="shield"
  />;
  return <ProductPage id="patch" title={t.xPatch} subtitle={t.xPatchBody}>
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {refused ? <Txt role="supporting" color={p.wm} testID="patch-refused">{userFacingMessage(refused, t)}</Txt> : null}
      {proposal ? <>
        <ProductSection title={t.xChanged} body={t[patchReasonKey(proposal.reason)]} icon="calendar" status="AVAILABLE">
          {proposal.changes.filter(change => change.kind !== 'unchanged').map(change => <ProductRow
            key={`${change.kind}-${change.itemId}`}
            title={change.title ? isolateAuto(change.title) : change.itemId}
            body={`${t.xBefore}: ${range(change.from)} · ${t.xAfter}: ${change.kind === 'removed' && change.to === null ? t.xUnplaced : range(change.to)}`}
            icon="calendar"
          />)}
        </ProductSection>
        {overridden.length > 0 ? <View testID="patch-overridden">
          <ProductSection title={t.xOverridden} body={t.xOverriddenBody} icon="shield">
            {overridden.map(protectionRow)}
          </ProductSection>
        </View> : null}
        {kept.length > 0 || overridden.length === 0 ? <View testID="patch-kept">
          <ProductSection title={t.xProtected} icon="shield">
            {kept.length === 0 ? <Txt role="supporting" color={p.mu}>{t.xNoResults}</Txt> : kept.map(protectionRow)}
          </ProductSection>
        </View> : null}
        {action.error && !refused ? <Txt role="supporting" color={p.wm}>{userFacingMessage(action.error, t)}</Txt> : null}
        <Pill testID="patch-accept" label={t.xAcceptChanges} disabled={busy || proposal.proposalId === staleOfferId} onPress={() => decide('accept_proposal')} />
        <Pill testID="patch-reject" label={t.xKeepPlan} kind="outline" disabled={busy} onPress={() => decide('reject_proposal')} />
      </> : <ProductSection title={t.xNoPatch} body={t.xPatchFuture} icon="calendar" />}
    </QueryBoundary>
    <Pill testID="patch-open-plan" label={t.xPlanner} kind="soft" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
  </ProductPage>;
}

export function HabitDetailScreen() {
  const { t, p, rtl, actions } = useApp();
  const query = useHabits();
  const create = useCreateHabit();
  const status = useSetHabitStatus();
  const remove = useDeleteHabit();
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [count, setCount] = React.useState(3);
  const [duration, setDuration] = React.useState(30);
  const [flexibility, setFlexibility] = React.useState<'flexible'|'protected_flexible'>('flexible');
  const [recovery, setRecovery] = React.useState<'skip'|'retry_same_day'|'recover_within_period'>('skip');
  const items = query.data ?? [];
  const save = () => create.mutate({
    title: title.trim(),
    cadence: { kind: 'weekly_count', count },
    durationMinutes: duration,
    preferredWindows: [],
    minimumOccurrences: count,
    maximumOccurrences: recovery === 'recover_within_period' ? Math.min(7, count + 1) : count,
    flexibility,
    recoveryPolicy: recovery,
    source: 'user_created',
    confirmation: { confirmedByUserAt: new Date().toISOString(), sourceRef: null, acceptedSuggestedValues: true },
  }, { onSuccess: () => { setAdding(false); setTitle(''); } });
  return <ProductPage id="habit" title={t.xHabits} subtitle={t.xHabitBody} overlay={deleting ? <Dialog
    title={t.confirmDeleteTitle}
    body={t.xDeleteHabitBody}
    confirmLabel={t.memoryDelete}
    cancelLabel={t.confirmKeep}
    onCancel={() => setDeleting(null)}
    onConfirm={() => { remove.mutate(deleting); setDeleting(null); }}
  /> : null}>
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {items.length === 0 ? <ProductSection title={t.xHabits} body={t.xNoOccurrences} icon="habit" /> : null}
      {items.map(habit => <ProductSection key={habit.habitId} title={isolateAuto(habit.title)} icon="habit" status={habit.status === 'active' ? 'LIVE' : 'BLOCKED'}>
        <ProductRow title={t.xCadence} body={habit.cadence.kind === 'weekly_count' ? String(habit.cadence.count) : habit.cadence.weekdays.join(' · ')} icon="calendar" />
        <ProductRow title={t.xDuration} body={`${habit.durationMinutes} min`} icon="watch" />
        <ProductRow title={t.xWindows} body={habit.preferredWindows.length > 0 ? habit.preferredWindows.map(window => `${window.start}–${window.end}`).join(' · ') : t.xNotSet} icon="watch" />
        <ProductRow title={t.xFlexibility} body={habit.flexibility} icon="shield" />
        <ProductRow title={t.xRecovery} body={habit.recoveryPolicy} icon="check" />
        {status.error || remove.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(status.error ?? remove.error, t)}</Txt> : null}
        <ProductActions>
          <Pill testID={`habit-toggle-${habit.habitId}`} label={habit.status === 'paused' ? t.xResume : t.xPause} kind="outline" disabled={status.isPending || habit.status === 'archived'} onPress={() => status.mutate({ id: habit.habitId, status: habit.status === 'paused' ? 'active' : 'paused' })} />
          <Pill testID={`habit-delete-${habit.habitId}`} label={t.memoryDelete} kind="outline" disabled={remove.isPending} onPress={() => setDeleting(habit.habitId)} />
        </ProductActions>
      </ProductSection>)}
    </QueryBoundary>
    {adding ? <ProductSection title={t.xCreateHabit} body={t.xHabitConfirmationBody} icon="habit">
      <TextInput testID="habit-title-input" accessibilityLabel={t.xHabitTitle} value={title} onChangeText={setTitle} maxLength={120}
        placeholder={t.xHabitTitlePlaceholder} placeholderTextColor={p.mu}
        style={{ minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: p.lnStrong, backgroundColor: p.bg, color: p.tx, fontSize: 17, paddingHorizontal: 14, textAlign: rtl ? 'right' : 'left' }} />
      <Txt role="label">{t.xCadence}</Txt>
      <ProductActions>{[1, 3, 5].map(value => <Pill key={value} label={t.xTimesPerWeek.replace('{count}', String(value))} kind={count === value ? 'accent' : 'outline'} onPress={() => setCount(value)} />)}</ProductActions>
      <Txt role="label">{t.xDuration}</Txt>
      <ProductActions>{[15, 30, 45, 60].map(value => <Pill key={value} label={t.xMinutes.replace('{count}', String(value))} kind={duration === value ? 'accent' : 'outline'} onPress={() => setDuration(value)} />)}</ProductActions>
      <Txt role="label">{t.xFlexibility}</Txt>
      <ProductActions><Pill label={t.xFlexible} kind={flexibility === 'flexible' ? 'accent' : 'outline'} onPress={() => setFlexibility('flexible')} /><Pill label={t.xProtectedFlexible} kind={flexibility === 'protected_flexible' ? 'accent' : 'outline'} onPress={() => setFlexibility('protected_flexible')} /></ProductActions>
      <Txt role="label">{t.xRecovery}</Txt>
      <ProductActions><Pill label={t.xLetItGo} kind={recovery === 'skip' ? 'accent' : 'outline'} onPress={() => setRecovery('skip')} /><Pill label={t.xRetrySameDay} kind={recovery === 'retry_same_day' ? 'accent' : 'outline'} onPress={() => setRecovery('retry_same_day')} /><Pill label={t.xRecoverThisWeek} kind={recovery === 'recover_within_period' ? 'accent' : 'outline'} onPress={() => setRecovery('recover_within_period')} /></ProductActions>
      {create.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(create.error, t)}</Txt> : null}
      <ProductActions><Pill testID="habit-create-confirm" label={t.xCreateHabit} disabled={!title.trim() || create.isPending} onPress={save} /><Pill label={t.cancel} kind="outline" disabled={create.isPending} onPress={() => setAdding(false)} /></ProductActions>
    </ProductSection> : <Pill testID="habit-create" label={t.xCreateHabit} onPress={() => setAdding(true)} />}
    <ProductSection title={t.xOccurrences} icon="check" status="COMING_SOON" />
    <Pill label={t.settingsRoutine} kind="outline" onPress={() => actions.go('routineSettings')} />
  </ProductPage>;
}
