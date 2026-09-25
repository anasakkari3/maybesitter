/**
 * L6: an in-app `go('calendar')` now opens that tab's root and closes the
 * stack the user left (so a tab never reopens mid-walk). A tap on the tab bar
 * is the other thing — "take me back to that tab" — and must keep each tab's
 * stack exactly where it was left.
 */
import React from 'react';
import { Text } from 'react-native';
import { expect, it } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../../state/AppContext';
import { TabBar } from '../TabBar';

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

/** Today → assistant, then the Calendar tab; the bar is drawn whenever the history says it shows. */
function Harness() {
  const { s, actions } = useApp();
  const walked = React.useRef(false);
  React.useEffect(() => {
    if (!walked.current) { walked.current = true; actions.go('contextualAssistant'); actions.switchTab('calendar'); }
  }, [actions]);
  return <>
    <Text testID="probe-screen">{s.screen}</Text>
    {s.showTabs ? <TabBar /> : null}
  </>;
}

it('the Today tab reopens the assistant the user left there', async () => {
  await render(<SafeAreaProvider initialMetrics={METRICS}><AppProvider><Harness /></AppProvider></SafeAreaProvider>);
  await waitFor(() => expect(screen.getByTestId('probe-screen').props.children).toBe('calendar'));
  await fireEvent.press(screen.getByTestId('tab-today'));
  await waitFor(() => expect(screen.getByTestId('probe-screen').props.children).toBe('contextualAssistant'));
});
