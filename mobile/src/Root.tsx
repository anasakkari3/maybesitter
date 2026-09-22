import React, { useEffect, useRef } from 'react';
import { BackHandler, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useApp } from './state/AppContext';
import { useAuth } from './auth/AuthProvider';
import { VerifyEmailBanner } from './auth/VerifyEmailBanner';
import { OfflineBanner } from './api/ui/OfflineBanner';
import { useLinks } from './links';
import { TodayScreen } from './screens/TodayScreen';
import { CalendarScreen } from './screens/CalendarScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { DetailsScreen } from './screens/DetailsScreen';
import { PlanScreen } from './screens/PlanScreen';
import { CaptureFlow } from './features/capture/CaptureFlow';
import { CaptureProvider } from './features/capture/CaptureProvider';
import { ShareProvider } from './features/share/ShareProvider';
import { ShareScreen } from './screens/ShareScreen';
import { SheetHost } from './screens/Sheets';
import { ToastHost } from './ui/toast';
import { TabBar } from './screens/TabBar';
import { CalendarDemoScreen } from './screens/CalendarDemoScreen';
import { DeleteAccountScreen } from './screens/DeleteAccountScreen';
import { TrustScreen } from './features/settings/TrustScreen';
import { KnowsScreen } from './features/settings/KnowsScreen';
import { MemoryScreen } from './features/memory/MemoryScreen';
import { FeedbackHistoryScreen } from './features/settings/FeedbackHistoryScreen';
import { ActivityScreen } from './features/activity/ActivityScreen';
import { RoutineSettingsScreen } from './features/settings/RoutineSettingsScreen';
import { ReadinessSettingsScreen } from './features/settings/ReadinessSettingsScreen';
import { NotificationsSettingsScreen } from './features/settings/NotificationsSettingsScreen';
import { CalendarSettingsScreen } from './features/settings/CalendarSettingsScreen';
import { FootballSettingsScreen } from './features/settings/FootballSettingsScreen';
import { CategorySettingsScreen } from './features/settings/CategorySettingsScreen';
import { DeviceCalendarSyncHost } from './features/calendar/useDeviceCalendarSync';
import { BusyCalendarHost } from './features/calendar/useBusyCalendar';
import { CalendarFeedsScreen } from './features/calendarFeeds/CalendarFeedsScreen';
import { AboutScreen } from './features/settings/AboutScreen';
import { LangAppearanceScreen } from './features/settings/LangAppearanceScreen';
import { AccountScreen } from './features/settings/AccountScreen';
import { SourcesScreen } from './features/settings/SourcesScreen';
import { WidgetSettingsScreen } from './features/widget/WidgetSettingsScreen';
import { WidgetSnapshotHost } from './features/widget/useWidgetSnapshotSync';
import { googleCalendarDemoEnabled, icsFeedsEnabled } from './config/env';
import { RemindersMount } from './features/reminders/RemindersMount';
import { Gallery } from './design/Gallery';

export function Root() {
  const { s, p, rtl, scheme, actions } = useApp();
  const { takePendingLink } = useAuth();
  const latest = useRef(actions);
  latest.current = actions;
  const pending = useRef(takePendingLink);
  pending.current = takePendingLink;
  useLinks(
    {
      jump: name => latest.current.jump(name),
      // A link is an arrival, not a push: the thing it names opens with its
      // natural way back underneath (Today), whatever was open before.
      openCommitment: id => latest.current.arriveAtDetail(id),
      // UC-3.10b (#195). The morning "your plan is ready" notification opens
      // maybesitter://plan/<date>, and the date it carries is the one shown.
      openPlan: date => latest.current.arriveAtPlan(date),
      // The next step lives on Today's card; there is no screen of its own.
      openNextStep: () => latest.current.arriveAt('today'),
      openCapture: (source, input) => latest.current.goCapture(source, input),
      setLang: l => latest.current.setLang(l),
      setThemePref: v => latest.current.setThemePref(v),
    },
    () => pending.current(),
  );
  /**
   * Android's hardware and gesture back walks the same history as every
   * on-screen back button (Round 2, Phase B). At a tab root there is nothing
   * to walk, so the event is left to the platform, which leaves the app — the
   * one place a user should ever exit is the place they came in.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!latest.current.canGoBack()) return false;
      latest.current.back();
      return true;
    });
    return () => sub.remove();
  }, []);
  return (
    /*
     * `CaptureProvider` is mounted here, not in `App.tsx` (UC-2.R2, #172).
     *
     * Root renders only for a signed-in, onboarded user, so the draft's
     * lifetime is that session's: signing out or deleting the account unmounts
     * this tree and the reducer holding the text goes with it. Mounting it
     * above the auth gate would keep one person's half-written commitment
     * alive across a sign-out.
     */
    // `direction` flips every row, start/end offset and border side for the two
    // RTL languages, Arabic and Hebrew. It is set here and nowhere else.
    // This is deliberately NOT I18nManager.forceRTL + a reload (issue #156 step
    // 5): it switches language live, with no restart prompt, and it is the
    // mechanism the round-1 design was verified on. See src/i18n/README.md.
    <CaptureProvider>
      {/* `ShareProvider` is inside `CaptureProvider` and inside `Root`
          (UC-3.0, #183). Inside `CaptureProvider` because a successful analyze
          hands its proposal to the capture flow, so review and confirm are the
          same code for a shared chat as for a typed sentence. Inside `Root`
          because Root renders only for a signed-in user: a share that arrives
          while nobody is signed in stays in the native module until they are,
          and signing out unmounts this and deletes the copies the OS made. */}
      <ShareProvider>
        <View style={{ flex: 1, backgroundColor: p.bg, direction: rtl ? 'rtl' : 'ltr' }}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <OfflineBanner />
          <VerifyEmailBanner />
          {/* Draws nothing (UC-3.1, #185). It keeps the phone's calendar in step
              with the commitments the screens are already showing, for the whole
              session rather than only while the calendar settings screen is
              open — a confirm on Today has to reach the calendar too. */}
          <DeviceCalendarSyncHost />
          {/* Notifications, for the whole signed-in session (UC-3.11 #196,
              UC-3.0b #184): the channels, the push registration, the reminder
              engine and the tap router. It renders nothing, and it is here
              rather than on a screen because a reminder has to be scheduled and
              a tap has to be routed whatever the user is looking at. */}
          <RemindersMount />
          {/* Also draws nothing (UC-3.2, #186). It keeps the busy times this
              phone reads in step with the calendar, for the whole session:
              the conflict chips are on Today and on the review card, and both
              are screens the settings page is not open behind. */}
          <BusyCalendarHost />
          {/* Draws nothing either (UC-3.R1, #203). It writes the home-screen
              widget's snapshot — titles redacted unless this account opted in
              on this phone — and clears it before a sign-out and when this
              signed-in tree unmounts. */}
          <WidgetSnapshotHost />
          {s.screen === 'today' && <TodayScreen key="today" />}
          {s.screen === 'calendar' && <CalendarScreen key="calendar" />}
          {s.screen === 'settings' && <SettingsScreen key="settings" />}
          {s.screen === 'deleteAccount' && (
            <DeleteAccountScreen key="deleteAccount" onBack={() => latest.current.back()} />
          )}
          {/* Settings sub-screens (UC-2.R4 #174). Each one's back is the
              history's back (Round 2, Phase B): a leaf reached from Settings
              returns to Settings, Memory reached through Trust → Knows returns
              through them, and none of them names a destination. */}
          {s.screen === 'trust' && (
            <TrustScreen
              key="trust"
              onBack={() => latest.current.back()}
              onKnows={() => latest.current.go('knows')}
            />
          )}
          {s.screen === 'knows' && (
            <KnowsScreen
              key="knows"
              onBack={() => latest.current.back()}
              onMemory={() => latest.current.go('memory')}
            />
          )}
          {s.screen === 'memory' && <MemoryScreen key="memory" onBack={() => latest.current.back()} />}
          {s.screen === 'feedbackHistory' && (
            <FeedbackHistoryScreen key="feedbackHistory" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'activity' && (
            <ActivityScreen key="activity" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'routineSettings' && (
            <RoutineSettingsScreen key="routineSettings" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'readinessSettings' && (
            <ReadinessSettingsScreen key="readinessSettings" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'notificationsSettings' && (
            <NotificationsSettingsScreen key="notificationsSettings" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'calendarSettings' && (
            <CalendarSettingsScreen
              key="calendarSettings"
              onBack={() => latest.current.back()}
              onFeeds={() => latest.current.go('calendarFeeds')}
            />
          )}
          {/* Behind the build flag here as well as inside the screen, so a
              build without the feature cannot reach it by a stale screen name. */}
          {icsFeedsEnabled() && s.screen === 'calendarFeeds' && (
            <CalendarFeedsScreen key="calendarFeeds" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'footballSettings' && (
            <FootballSettingsScreen key="footballSettings" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'categorySettings' && (
            <CategorySettingsScreen key="categorySettings" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'widgetSettings' && (
            <WidgetSettingsScreen key="widgetSettings" onBack={() => latest.current.back()} />
          )}
          {s.screen === 'about' && <AboutScreen key="about" onBack={() => latest.current.back()} />}
          {s.screen === 'langAppearance' && <LangAppearanceScreen key="langAppearance" onBack={() => latest.current.back()} />}
          {s.screen === 'account' && <AccountScreen key="account" onBack={() => latest.current.back()} />}
          {s.screen === 'sources' && <SourcesScreen key="sources" onBack={() => latest.current.back()} />}
          {s.screen === 'details' && <DetailsScreen key="details" />}
          {/* Today's plan (UC-3.10b, #195). Keyed by its date so a second link
              for another day remounts rather than re-using the first day's
              open editor and picked time. */}
          {s.screen === 'plan' && s.planDate ? (
            <PlanScreen key={`plan-${s.planDate}`} date={s.planDate} onBack={() => latest.current.back()} />
          ) : null}
          {/* One entry, three screens derived from the flow's own status
              (UC-2.R2 #172). `review` and `saved` are no longer app screens: a
              second place to record which one is showing is a second place for it
              to be wrong. */}
          {s.screen === 'capture' && <CaptureFlow key="capture" />}
          {s.screen === 'share' && <ShareScreen key="share" />}
          {__DEV__ && s.screen === 'gallery' && <Gallery key="gallery" />}
          {/* Two independent gates: the flag, and the release guard that refuses
              to configure a staging or production build which sets it (#152). */}
          {googleCalendarDemoEnabled() && s.screen === 'calendarDemo' && (
            <CalendarDemoScreen key="calendarDemo" onBack={() => latest.current.back()} />
          )}
          {s.showTabs && <TabBar />}
          <ToastHost />
          <SheetHost key={s.sheet ?? 'none'} />
        </View>
      </ShareProvider>
    </CaptureProvider>
  );
}
