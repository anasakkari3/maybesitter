import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { useMemory } from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { calendarReadEnabled, calendarWriteEnabled, shareIntakeEnabled } from '../../config/env';
import { LANGUAGE_ENDONYM } from '../../i18n/language';
import { isolate } from '../../i18n/bidi';
import { dayKey } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { Pill, Txt } from '../../ui/primitives';
import { ProductPage, ProductSection, ProductRow, ProductIcon, PreviewNotice, PreviewAction } from '../../ui/product';
import { capabilities as cap } from './capabilities';

export function MyMaybeSitterScreen() {
  const { t, actions, lang } = useApp();
  const { user } = useAuth();
  return <ProductPage id="my" title={t.xMy} subtitle={t.xMyBody}>
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 12 }}><ProductIcon name="person" /></View>
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
      <ProductRow id="add-pdf" title={t.xFiles} icon="file" status={cap.pdf} onPress={() => actions.go('pdfReview')} />
    </ProductSection>
    <ProductRow id="add-capture" title={t.xQuick} body={t.xQuickBody} icon="check" onPress={() => actions.go('capture')} />
    <ProductRow title={t.xPlanner} icon="calendar" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
    <ProductRow title={t.notifTitle} icon="watch" onPress={() => actions.go('notificationsSettings')} />
    <ProductRow title={t.memoryScreenTitle} icon="person" onPress={() => actions.go('knows')} />
    <ProductRow title={t.xCoordination} icon="link" status={cap.assistantPreparation} />
  </ProductPage>;
}

export function GoalExecutionScreen() {
  const { t, actions } = useApp();
  const memory = useMemory();
  const goals = memory.data?.items.filter(item => item.kind === 'goal') ?? [];
  return <ProductPage id="goals" title={t.xGoals} subtitle={t.xGoalBody}>
    <QueryBoundary isPending={memory.isPending} error={memory.error} onRetry={() => void memory.refetch()}>
      <ProductSection title={t.xGoalSaved} body={goals.length === 0 ? t.xNoGoals : undefined} icon="goal">
        {goals.map(goal => <ProductRow key={goal.id} title={isolate(goal.content)} icon="goal" onPress={() => actions.go('memory')} />)}
        <Pill label={t.memoryScreenTitle} kind="outline" onPress={() => actions.go('knows')} />
      </ProductSection>
    </QueryBoundary>
    <PreviewNotice />
    <ProductSection title={t.xRoadmap} body={t.xGoalPreview} icon="goal" status={cap.goals}>
      <ProductRow title={t.xMilestone} status={cap.goals} icon="goal" />
      <ProductRow title={t.xLinkedSteps} status={cap.goals} icon="check" />
      <ProductRow title={t.xLinkedHabits} status={cap.habits} icon="habit" onPress={() => actions.go('habitDetail')} />
      <ProductRow title={t.xCheckpoints} status={cap.goals} icon="calendar" />
    </ProductSection>
    <PreviewAction label={t.xSuggestSteps} />
  </ProductPage>;
}

export function PatchReviewScreen() {
  const { t, p, actions } = useApp();
  const zone = useTimeZone();
  return <ProductPage id="patch" title={t.xPatch} subtitle={t.xPatchBody}>
    <PreviewNotice />
    <ProductSection title={t.xNoPatch} body={t.xPatchFuture} icon="calendar" status={cap.planDiff} />
    <ProductSection title={t.xChanged} icon="calendar">
      <ProductRow title={t.xBefore} body={t.xNotSet} icon="calendar" />
      <ProductRow title={t.xAfter} body={t.suggestionNote} icon="calendar" />
    </ProductSection>
    <ProductSection title={t.xProtected} icon="shield" status={cap.planDiff}><Txt role="supporting" color={p.mu}>{t.xPatchFuture}</Txt></ProductSection>
    <PreviewAction label={t.xAcceptChanges} />
    <Pill label={t.xKeepPlan} kind="outline" onPress={() => actions.back()} />
    <Pill testID="patch-open-plan" label={t.xPlanner} kind="soft" onPress={() => actions.openPlan(dayKey(new Date(), zone))} />
  </ProductPage>;
}

export function PdfReviewScreen() {
  const { t, actions } = useApp();
  return <ProductPage id="pdf" title={t.xPDF} subtitle={t.xPDFBody}>
    <PreviewNotice />
    <ProductSection title={t.xFiles} body={t.xPDFLimits} icon="file" status={cap.pdf} />
    <ProductSection title={t.reviewTitle} body={t.xGroupingFuture} icon="file">
      {[t.xExams, t.xAssignments, t.xDeadlines, t.xLectures].map(title => <ProductRow key={title} title={title} status={cap.pdf} icon="calendar" />)}
    </ProductSection>
    <ProductSection title={t.xPDFProblems} icon="shield">
      {[t.xUnreadable, t.xTooLarge, t.xUnsupported, t.xPartial].map(body => <Txt key={body} role="supporting">{body}</Txt>)}
    </ProductSection>
    <Pill label={t.xQuick} kind="outline" onPress={() => actions.go('capture')} />
  </ProductPage>;
}

export function HabitDetailScreen() {
  const { t, actions } = useApp();
  return <ProductPage id="habit" title={t.xHabits} subtitle={t.xHabitBody}>
    <PreviewNotice />
    <ProductSection title={t.xHabits} body={t.xHabitPreview} icon="habit" status={cap.habits} />
    <ProductSection title={t.settingsRoutine} icon="calendar">
      {[t.xCadence, t.xDuration, t.xWindows, t.xFlexibility, t.xRecovery].map(title => <ProductRow key={title} title={title} status={cap.habits} icon="watch" />)}
    </ProductSection>
    <ProductSection title={t.xOccurrences} body={t.xNoOccurrences} icon="check" status={cap.habits} />
    <Pill label={t.settingsRoutine} kind="outline" onPress={() => actions.go('routineSettings')} />
  </ProductPage>;
}
