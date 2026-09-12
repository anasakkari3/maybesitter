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
import { CaptureScreen } from './screens/CaptureScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SavedScreen } from './screens/SavedScreen';
import { CloseoutScreen } from './screens/CloseoutScreen';
import { FirstMoveScreen } from './screens/FirstMoveScreen';
import { SheetHost } from './screens/Sheets';
import { TabBar } from './screens/TabBar';
import { CalendarDemoScreen } from './screens/CalendarDemoScreen';
import { googleCalendarDemoEnabled } from './config/env';
import { Gallery } from './design/Gallery';

const tabScreens = ['today', 'calendar', 'settings'];

export function Root() {
  const { s, p, ar, scheme, actions } = useApp();
  const { takePendingLink } = useAuth();
  const latest = useRef(actions);
  latest.current = actions;
  const pending = useRef(takePendingLink);
  pending.current = takePendingLink;
  useLinks(
    {
      jump: name => latest.current.jump(name),
      setLang: l => latest.current.setLang(l),
      setThemePref: v => latest.current.setThemePref(v),
    },
    () => pending.current(),
  );
  return (
    // `direction` flips every row, start/end offset and border side for Arabic.
    // This is deliberately NOT I18nManager.forceRTL + a reload (issue #156 step
    // 5): it switches language live, with no restart prompt, and it is the
    // mechanism the round-1 design was verified on. See src/i18n/README.md.
    <View style={{ flex: 1, backgroundColor: p.bg, direction: ar ? 'rtl' : 'ltr' }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <OfflineBanner />
      <VerifyEmailBanner />
      {s.screen === 'today' && <TodayScreen key="today" />}
      {s.screen === 'calendar' && <CalendarScreen key="calendar" />}
      {s.screen === 'settings' && <SettingsScreen key="settings" />}
      {s.screen === 'details' && <DetailsScreen key="details" />}
      {s.screen === 'capture' && <CaptureScreen key="capture" />}
      {s.screen === 'review' && <ReviewScreen key="review" />}
      {s.screen === 'saved' && <SavedScreen key="saved" />}
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
  );
}
