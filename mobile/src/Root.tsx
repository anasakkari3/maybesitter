import React, { useRef } from 'react';
import { View } from 'react-native';
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
import { CaptureFlow } from './features/capture/CaptureFlow';
import { CaptureProvider } from './features/capture/CaptureProvider';
import { ShareProvider } from './features/share/ShareProvider';
import { ShareScreen } from './screens/ShareScreen';
import { CloseoutScreen } from './screens/CloseoutScreen';
import { FirstMoveScreen } from './screens/FirstMoveScreen';
import { SheetHost } from './screens/Sheets';
import { TabBar } from './screens/TabBar';
import { CalendarDemoScreen } from './screens/CalendarDemoScreen';
import { DeleteAccountScreen } from './screens/DeleteAccountScreen';
import { TrustScreen } from './features/settings/TrustScreen';
import { KnowsScreen } from './features/settings/KnowsScreen';
import { MemoryScreen } from './features/memory/MemoryScreen';
import { FeedbackHistoryScreen } from './features/settings/FeedbackHistoryScreen';
import { ActivityScreen } from './features/activity/ActivityScreen';
import { RoutineSettingsScreen } from './features/settings/RoutineSettingsScreen';
import { NotificationsSettingsScreen } from './features/settings/NotificationsSettingsScreen';
import { CalendarSettingsScreen } from './features/settings/CalendarSettingsScreen';
import { FootballSettingsScreen } from './features/settings/FootballSettingsScreen';
import { DeviceCalendarSyncHost } from './features/calendar/useDeviceCalendarSync';
import { AboutScreen } from './features/settings/AboutScreen';
import { googleCalendarDemoEnabled } from './config/env';
import { Gallery } from './design/Gallery';

const tabScreens = ['today', 'calendar', 'settings'];

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
      openCommitment: id => latest.current.openDetail(id),
      // The next step lives on Today's card; there is no screen of its own.
      openNextStep: () => latest.current.go('today'),
      openCapture: (source, input) => latest.current.goCapture(source, input),
      setLang: l => latest.current.setLang(l),
      setThemePref: v => latest.current.setThemePref(v),
    },
    () => pending.current(),
  );
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
          {s.screen === 'today' && <TodayScreen key="today" />}
          {s.screen === 'calendar' && <CalendarScreen key="calendar" />}
          {s.screen === 'settings' && <SettingsScreen key="settings" />}
          {s.screen === 'deleteAccount' && (
            <DeleteAccountScreen key="deleteAccount" onBack={() => latest.current.go('settings')} />
          )}
          {/* Settings sub-screens (UC-2.R4 #174). Each takes the way back rather
              than reading history: `back()` returns to `prev`, which is Settings
              for all of these, and Trust for the one reached from it. */}
          {s.screen === 'trust' && (
            <TrustScreen
              key="trust"
              onBack={() => latest.current.go('settings')}
              onKnows={() => latest.current.go('knows')}
            />
          )}
          {s.screen === 'knows' && (
            <KnowsScreen
              key="knows"
              onBack={() => latest.current.go('trust')}
              onMemory={() => latest.current.go('memory')}
            />
          )}
          {s.screen === 'memory' && <MemoryScreen key="memory" onBack={() => latest.current.go('knows')} />}
          {s.screen === 'feedbackHistory' && (
            <FeedbackHistoryScreen key="feedbackHistory" onBack={() => latest.current.go('settings')} />
          )}
          {s.screen === 'activity' && (
            <ActivityScreen key="activity" onBack={() => latest.current.go('settings')} />
          )}
          {s.screen === 'routineSettings' && (
            <RoutineSettingsScreen key="routineSettings" onBack={() => latest.current.go('settings')} />
          )}
          {s.screen === 'notificationsSettings' && (
            <NotificationsSettingsScreen key="notificationsSettings" onBack={() => latest.current.go('settings')} />
          )}
          {s.screen === 'calendarSettings' && (
            <CalendarSettingsScreen key="calendarSettings" onBack={() => latest.current.go('settings')} />
          )}
          {s.screen === 'footballSettings' && (
            <FootballSettingsScreen key="footballSettings" onBack={() => latest.current.go('settings')} />
          )}
          {s.screen === 'about' && <AboutScreen key="about" onBack={() => latest.current.go('settings')} />}
          {s.screen === 'details' && <DetailsScreen key="details" />}
          {/* One entry, three screens derived from the flow's own status
              (UC-2.R2 #172). `review` and `saved` are no longer app screens: a
              second place to record which one is showing is a second place for it
              to be wrong. */}
          {s.screen === 'capture' && <CaptureFlow key="capture" />}
          {s.screen === 'share' && <ShareScreen key="share" />}
          {s.screen === 'closeout' && <CloseoutScreen key="closeout" />}
          {s.screen === 'firstmove' && <FirstMoveScreen key="firstmove" />}
          {__DEV__ && s.screen === 'gallery' && <Gallery key="gallery" />}
          {/* Two independent gates: the flag, and the release guard that refuses
              to configure a staging or production build which sets it (#152). */}
          {googleCalendarDemoEnabled() && s.screen === 'calendarDemo' && (
            <CalendarDemoScreen key="calendarDemo" onBack={() => latest.current.go('settings')} />
          )}
          {tabScreens.includes(s.screen) && <TabBar />}
          <SheetHost key={s.sheet ?? 'none'} />
        </View>
      </ShareProvider>
    </CaptureProvider>
  );
}
