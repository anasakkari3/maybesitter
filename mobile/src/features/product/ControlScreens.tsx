import React from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import {
  useConfirmGoalSelections,
  useCreateMemory,
  useCreateHabit,
  useDeleteHabit,
  useGoalExecution,
  useHabits,
  useMemory,
  usePlan,
  usePlanAction,
  useRegenerateGoalExecution,
  useSetHabitStatus,
  useUnlinkGoalNode,
} from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { calendarReadEnabled, calendarWriteEnabled, shareIntakeEnabled } from '../../config/env';
import { LANGUAGE_ENDONYM } from '../../i18n/language';
import { isolate } from '../../i18n/bidi';
import { dayKey, formatTimeRange } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { BrandMark } from '../../ui/brand';
import { Card, Pill, Txt } from '../../ui/primitives';
import { Dialog } from '../../ui/dialog';
import { ProductActions, ProductPage, ProductSection, ProductRow } from '../../ui/product';
import { capabilities as cap } from './capabilities';

export function MyMaybeSitterScreen() {
  const { t, actions, lang } = useApp();
  const { user } = useAuth();
  return <ProductPage id="my" title={t.xMy} subtitle={t.xMyBody}>
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 12 }}><BrandMark size={76} /></View>
    <ProductSection title={t.accountTitle} icon="person">
      <ProductRow title={t.xName} body={user?.displayName ? isolate(user.displayName) : t.xNotSet} icon="person" />
      <ProductRow title={t.accountTitle} body={user?.email ? isolate(user.email) : t.authSignedInPrivateApple} icon="shield" onPress={() => actions.go('account')} />
      <ProductRow title={t.settingsLangAppearance} body={LANGUAGE_ENDONYM[lang]} icon="spark" onPress={() => actions.go('langAppearance')} />
    </ProductSection>
    <ProductSection title={t.settingsGroupReminders} icon="watch">
      <ProductRow title={t.notifTitle} body={t.settingsRemindersSub} icon="watch" onPress={() => actions.go('notificationsSettings')} />
      <ProductRow title={t.settingsRoutine} body={t.settingsRoutineSub} icon="calendar" onPress={() => actions.go('routineSettings')} />
      <ProductRow title={t.xPersonalization} icon="person" onPress={() => actions.go('personalization')} />
    </ProductSection>
    <ProductSection title={t.xPersonality} body={t.xFuturePreference} status={cap.assistantPersonality} icon="spark">
      <ProductRow title={t.xAssistantName} body="MaybeSitter" status={cap.assistantName} />
    </ProductSection>
  </ProductPage>;
}

export function IntegrationsScreen() {
  const { t, actions } = useApp();
  const deviceAvailable = calendarReadEnabled() || calendarWriteEnabled();
  return <ProductPage id="integrations" title={t.xIntegrations} subtitle={t.xIntegrationsBody}>
    <ProductRow id="integration-device" title={t.xDeviceCalendar} body={t.xDeviceBody} icon="calendar" status={deviceAvailable ? 'AVAILABLE' : 'COMING_SOON'} onPress={() => actions.go('calendarSettings')} />
    <ProductRow id="integration-google" title="Google Calendar" body={t.xGoogleBody} icon="calendar" status={cap.googleCalendar} onPress={() => actions.go('googleIntegration')} />
    <ProductRow title="Gmail" body={t.xGmailBody} icon="file" status={cap.gmail} />
    <ProductRow title="WhatsApp" body={t.xWhatsappBody} icon="link" status={cap.whatsappConnection} onPress={() => actions.go('addToMaybeSitter')} />
    <ProductRow title="Google Drive" body={t.xDriveBody} icon="file" status={cap.drive} />
    <ProductRow title={t.xHealth} body={t.xHealthBody} icon="habit" onPress={() => actions.go('readinessSettings')} />
    <ProductRow title={t.xLocation} body={t.xLocationBody} icon="goal" status={cap.location} />
    <ProductRow title={t.settingsSources} body={t.settingsSourcesSub} icon="link" onPress={() => actions.go('sources')} />
  </ProductPage>;
}

export function GoogleIntegrationScreen() {
  const { t, actions } = useApp();
  return <ProductPage id="google" title={t.xGoogleDetail}>
    <ProductSection title="Google Calendar" body={t.xGoogleBody} icon="calendar" status={cap.googleCalendar}>
      <Pill testID="google-device-settings" label={t.calendarWriteTitle} kind="accent" onPress={() => actions.go('calendarSettings')} />
    </ProductSection>
    <ProductSection title={t.xDirectConnection} icon="link" status={cap.googleCalendar}>
      <ProductRow title={t.xSyncNow} status={cap.googleCalendar} icon="watch" />
      <ProductRow title={t.xWriteBack} status={cap.googleCalendar} icon="calendar" />
    </ProductSection>
    <ProductSection title={t.xPrivacy} body={t.xCalendarPrivacy} icon="shield">
      <Pill label={t.sTrust} kind="outline" onPress={() => actions.go('trust')} />
    </ProductSection>
    <ProductRow title="Gmail" body={t.xGmailBody} icon="file" status={cap.gmail} />
  </ProductPage>;
}

export function ActionModesScreen() {
  const { t, actions } = useApp();
  const zone = useTimeZone();
  return <ProductPage id="modes" title={t.xModes} subtitle={t.xModesBody}>
    <ProductRow id="mode-quick" title={t.xQuick} body={t.xQuickBody} icon="spark" onPress={() => actions.go('capture')} />
    <ProductRow id="mode-plan" title={t.xPlanner} body={t.xPlannerBody} icon="calendar" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
    <ProductSection title={t.xWeekly} body={t.xWeeklyBody} icon="goal" status={cap.weeklyMode} />
  </ProductPage>;
}

export function AddToMaybeSitterScreen() {
  const { t, actions } = useApp();
  const zone = useTimeZone();
  return <ProductPage id="add" title={t.xAdd} subtitle={t.xAddBody}>
    <ProductSection title={t.xShareGuide} body={shareIntakeEnabled() ? t.xShareGuideBody : t.shareUnavailable} icon="link" status={shareIntakeEnabled() ? 'AVAILABLE' : 'COMING_SOON'}>
      <ProductRow title={t.xPhotos} body={t.xShareGuideBody} icon="photo" status={shareIntakeEnabled() ? 'AVAILABLE' : 'COMING_SOON'} />
      <ProductRow title={t.xCamera} icon="photo" status={cap.camera} />
      <ProductRow id="add-pdf" title={t.xFiles} body={shareIntakeEnabled() ? t.xShareGuideBody : t.shareUnavailable} icon="file" status={shareIntakeEnabled() ? 'AVAILABLE' : cap.pdf} onPress={() => actions.go('pdfReview')} />
    </ProductSection>
    <ProductRow id="add-capture" title={t.xQuick} body={t.xQuickBody} icon="check" onPress={() => actions.go('capture')} />
    <ProductRow title={t.xPlanner} icon="calendar" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
    <ProductRow title={t.notifTitle} icon="watch" onPress={() => actions.go('notificationsSettings')} />
    <ProductRow title={t.memoryScreenTitle} icon="person" onPress={() => actions.go('knows')} />
    <ProductRow title={t.xCoordination} icon="link" status={cap.assistantPreparation} />
  </ProductPage>;
}

export function GoalExecutionScreen() {
  const { t, p, rtl, lang, actions } = useApp();
  const memory = useMemory();
  const create = useCreateMemory();
  const [draft, setDraft] = React.useState('');
  const goals = memory.data?.items.filter(item => item.kind === 'goal') ?? [];
  return <ProductPage id="goals" title={t.xGoals} subtitle={t.xGoalBody}>
    <ProductSection title={t.xAddGoal} body={t.xAddGoalBody} icon="goal">
      <TextInput
        testID="goal-add-input"
        accessibilityLabel={t.xAddGoal}
        value={draft}
        onChangeText={setDraft}
        placeholder={t.xGoalPlaceholder}
        placeholderTextColor={p.mu}
        maxLength={200}
        multiline
        style={{ color: p.tx, backgroundColor: p.bg, padding: 14, minHeight: 60, borderRadius: 14, fontSize: 17, textAlign: rtl ? 'right' : 'left' }}
      />
      {create.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(create.error, t)}</Txt> : null}
      <Pill testID="goal-add-save" label={t.memorySave} disabled={create.isPending || !draft.trim()} onPress={() => {
        create.mutate({ kind: 'goal', content: draft.trim(), language: lang }, { onSuccess: () => setDraft('') });
      }} />
    </ProductSection>
    <QueryBoundary isPending={memory.isPending} error={memory.error} onRetry={() => void memory.refetch()}>
      <ProductSection title={t.xGoalSaved} body={goals.length === 0 ? t.xNoGoals : undefined} icon="goal">
        {goals.map(goal => <GoalExecutionCard key={goal.id} goalId={goal.id} title={goal.content} />)}
        <Pill label={t.memoryScreenTitle} kind="outline" onPress={() => actions.go('knows')} />
      </ProductSection>
    </QueryBoundary>
    <Pill label={t.xLinkedHabits} kind="outline" onPress={() => actions.go('habitDetail')} />
  </ProductPage>;
}

function GoalExecutionCard({ goalId, title }: { goalId: string; title: string }) {
  const { t, p } = useApp();
  const [generation, setGeneration] = React.useState(1);
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const [target, setTarget] = React.useState<'commitment'|'habit'>('commitment');
  const [habitCount, setHabitCount] = React.useState(3);
  const [habitDuration, setHabitDuration] = React.useState(30);
  const query = useGoalExecution(goalId, generation);
  const confirm = useConfirmGoalSelections(goalId);
  const regenerate = useRegenerateGoalExecution(goalId);
  const unlink = useUnlinkGoalNode(goalId);
  const graph = query.data?.graph;
  const proposals = graph?.nodes.filter(node => node.kind === 'milestone_proposal' || node.kind === 'decomposition_step_proposal') ?? [];
  const linked = graph?.nodes.filter(node => node.kind === 'linked_commitment' || node.kind === 'linked_habit') ?? [];
  const checkpoints = graph?.nodes.filter(node => node.kind === 'checkpoint') ?? [];
  const toggle = (nodeId: string) => setSelected(current => current.includes(nodeId) ? current.filter(id => id !== nodeId) : [...current, nodeId]);
  return <Card style={{ gap: 12 }}>
    <Txt role="card">{isolate(title)}</Txt>
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {query.data ? <>
        <Txt role="supporting" color={p.mu}>{`${query.data.progress.completedCount}/${query.data.progress.confirmedCount} · ${t.xRoadmap}`}</Txt>
        {proposals.map(node => <ProductRow
          key={node.nodeId}
          title={isolate(node.title)}
          body={node.statedTiming ? isolate(node.statedTiming) : undefined}
          icon={node.kind === 'milestone_proposal' ? 'goal' : 'check'}
          {...(selected.includes(node.nodeId) ? { status: 'AVAILABLE' as const } : {})}
          onPress={() => toggle(node.nodeId)}
        />)}
        {linked.map(node => <View key={node.nodeId} style={{ gap: 8 }}>
          <ProductRow title={node.kind === 'linked_commitment' ? t.xLinkedSteps : t.xLinkedHabits} body={node.kind === 'linked_commitment' ? node.commitmentId : node.habitId} icon={node.kind === 'linked_commitment' ? 'check' : 'habit'} status="LIVE" />
          <Pill label={t.memoryDelete} kind="outline" disabled={unlink.isPending} onPress={() => unlink.mutate(node.nodeId)} />
        </View>)}
        {checkpoints.length > 0 ? <ProductSection title={t.xCheckpoints} icon="goal">
          {checkpoints.map(node => <ProductRow
            key={node.nodeId}
            title={isolate(node.title)}
            body={node.statedTiming ? isolate(node.statedTiming) : undefined}
            icon="goal"
            status={node.status === 'confirmed' ? 'LIVE' : 'AVAILABLE'}
          />)}
        </ProductSection> : null}
        {confirm.error || regenerate.error || unlink.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(confirm.error ?? regenerate.error ?? unlink.error, t)}</Txt> : null}
        {selected.length > 0 ? <Card style={{ gap: 10 }}>
          <Txt role="label">{t.xTurnSelectedInto}</Txt>
          <ProductActions><Pill label={t.xCommitments} kind={target === 'commitment' ? 'accent' : 'outline'} onPress={() => setTarget('commitment')} /><Pill label={t.xHabits} kind={target === 'habit' ? 'accent' : 'outline'} onPress={() => setTarget('habit')} /></ProductActions>
          {target === 'habit' ? <>
            <Txt role="supporting" color={p.mu}>{t.xHabitConfirmationBody}</Txt>
            <ProductActions>{[1, 3, 5].map(value => <Pill key={value} label={t.xTimesPerWeek.replace('{count}', String(value))} kind={habitCount === value ? 'accent' : 'outline'} onPress={() => setHabitCount(value)} />)}</ProductActions>
            <ProductActions>{[15, 30, 45, 60].map(value => <Pill key={value} label={t.xMinutes.replace('{count}', String(value))} kind={habitDuration === value ? 'accent' : 'outline'} onPress={() => setHabitDuration(value)} />)}</ProductActions>
          </> : null}
        </Card> : null}
        <ProductActions>
          {selected.length > 0 ? <Pill testID={`goal-confirm-${goalId}`} label={t.xAcceptChanges} disabled={confirm.isPending} onPress={() => confirm.mutate({ generation, selections: selected.map(nodeId => target === 'commitment'
            ? { nodeId, as: 'commitment' as const }
            : { nodeId, as: 'habit' as const, habit: { cadence: { kind: 'weekly_count' as const, count: habitCount }, durationMinutes: habitDuration, preferredWindows: [], minimumOccurrences: habitCount, maximumOccurrences: habitCount, flexibility: 'flexible' as const, recoveryPolicy: 'skip' as const } }) }, { onSuccess: () => setSelected([]) })} /> : null}
          <Pill label={t.xSuggestSteps} kind="outline" disabled={regenerate.isPending} onPress={() => regenerate.mutate(generation, { onSuccess: () => { setGeneration(value => value + 1); setSelected([]); } })} />
        </ProductActions>
      </> : null}
    </QueryBoundary>
  </Card>;
}

export function PatchReviewScreen() {
  const { t, p, lang, actions } = useApp();
  const zone = useTimeZone();
  const date = dayKey(new Date(), zone);
  const query = usePlan(date);
  const action = usePlanAction(date);
  const proposal = query.data?.proposal ?? null;
  const range = (interval: { startsAt: string; endsAt: string } | null) => interval
    ? formatTimeRange(new Date(interval.startsAt), new Date(interval.endsAt), { locale: lang, timeZone: query.data?.timezone ?? zone })
    : t.xNotSet;
  return <ProductPage id="patch" title={t.xPatch} subtitle={t.xPatchBody}>
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {proposal ? <>
        <ProductSection title={t.xChanged} body={proposal.reason} icon="calendar" status="AVAILABLE">
          {proposal.changes.filter(change => change.kind !== 'unchanged').map(change => <ProductRow
            key={`${change.kind}-${change.itemId}`}
            title={change.title ? isolate(change.title) : change.itemId}
            body={`${t.xBefore}: ${range(change.from)} · ${t.xAfter}: ${range(change.to)}`}
            icon="calendar"
          />)}
        </ProductSection>
        <ProductSection title={t.xProtected} icon="shield">
          {proposal.protections.length === 0 ? <Txt role="supporting" color={p.mu}>{t.xNoResults}</Txt> : proposal.protections.map(protection => <ProductRow
            key={protection.blockId}
            title={protection.title ? isolate(protection.title) : protection.itemId}
            body={range(protection.proposedInterval)}
            icon="shield"
            status={protection.overridden ? 'BLOCKED' : 'AVAILABLE'}
          />)}
        </ProductSection>
        {action.error ? <Txt role="supporting" color={p.wm}>{userFacingMessage(action.error, t)}</Txt> : null}
        <Pill testID="patch-accept" label={t.xAcceptChanges} disabled={action.isPending} onPress={() => action.mutate('accept_proposal')} />
        <Pill testID="patch-reject" label={t.xKeepPlan} kind="outline" disabled={action.isPending} onPress={() => action.mutate('reject_proposal')} />
      </> : <ProductSection title={t.xNoPatch} body={t.xPatchFuture} icon="calendar" />}
    </QueryBoundary>
    <Pill testID="patch-open-plan" label={t.xPlanner} kind="soft" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
  </ProductPage>;
}

export function PdfReviewScreen() {
  const { t, actions } = useApp();
  const intake = shareIntakeEnabled();
  return <ProductPage id="pdf" title={t.xPDF} subtitle={t.xPDFBody}>
    <ProductSection title={t.xFiles} body={intake ? t.xShareGuideBody : t.xPDFLimits} icon="file" status={intake ? 'AVAILABLE' : cap.pdf} />
    <ProductSection title={t.reviewTitle} body={t.xGroupingFuture} icon="file">
      {[t.xExams, t.xAssignments, t.xDeadlines, t.xLectures].map(title => <ProductRow key={title} title={title} status="COMING_SOON" icon="calendar" />)}
    </ProductSection>
    <ProductSection title={t.xPDFProblems} icon="shield">
      {[t.xUnreadable, t.xTooLarge, t.xUnsupported, t.xPartial].map(body => <Txt key={body} role="supporting">{body}</Txt>)}
    </ProductSection>
    <Pill label={t.xQuick} kind="outline" onPress={() => actions.go('capture')} />
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
      {items.map(habit => <ProductSection key={habit.habitId} title={isolate(habit.title)} icon="habit" status={habit.status === 'active' ? 'LIVE' : 'BLOCKED'}>
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
    <ProductSection title={t.xOccurrences} body={t.xHabitOccurrencesUnavailable} icon="check" status="COMING_SOON" />
    <Pill label={t.settingsRoutine} kind="outline" onPress={() => actions.go('routineSettings')} />
  </ProductPage>;
}
