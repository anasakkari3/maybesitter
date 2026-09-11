import React, { useRef } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useApp } from './state/AppContext';
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

const tabScreens = ['today', 'calendar', 'settings'];

export function Root() {
  const { s, p, ar, scheme, actions } = useApp();
  const latest = useRef(actions);
  latest.current = actions;
  useLinks({
    jump: name => latest.current.jump(name),
    setLang: l => latest.current.setLang(l),
    setThemePref: v => latest.current.setThemePref(v),
  });
  return (
    // `direction` flips every row, start/end offset and border side for Arabic.
    <View style={{ flex: 1, backgroundColor: p.bg, direction: ar ? 'rtl' : 'ltr' }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {s.screen === 'today' && <TodayScreen key="today" />}
      {s.screen === 'calendar' && <CalendarScreen key="calendar" />}
      {s.screen === 'settings' && <SettingsScreen key="settings" />}
      {s.screen === 'details' && <DetailsScreen key="details" />}
      {s.screen === 'capture' && <CaptureScreen key="capture" />}
      {s.screen === 'review' && <ReviewScreen key="review" />}
      {s.screen === 'saved' && <SavedScreen key="saved" />}
      {s.screen === 'closeout' && <CloseoutScreen key="closeout" />}
      {s.screen === 'firstmove' && <FirstMoveScreen key="firstmove" />}
      {tabScreens.includes(s.screen) && <TabBar />}
      <SheetHost key={s.sheet ?? 'none'} />
    </View>
  );
}
