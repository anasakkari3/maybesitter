import React, { useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { ScreenTopInsetConsumedContext } from '../../ui/screen';

/**
 * "You're offline", from the same `onlineManager` the query layer uses.
 *
 * Reading connectivity from one source rather than a second NetInfo
 * subscription is what keeps the banner and the behaviour in step: if the
 * banner is up, mutations really are disabled, and when it goes the refetch
 * has already been triggered.
 *
 * ── It owns the top of the display while it shows (UAT 2026-09-30, u45) ──
 *
 * It is the first thing under Root, so on an edge-to-edge Android display it
 * was drawn over the status bar — «بدون إنترنت…» across the clock — and the
 * verify-email banner below it cleared the status bar a second time. Like
 * that banner it pads itself by the safe-area top and tells what it wraps
 * that the inset is taken (`ScreenTopInsetConsumedContext`), so the next
 * banner or the screen frame does not add it again. The provider stays
 * mounted either way: the screen, its scroll position and any draft belong
 * to the user.
 */
export function OfflineBanner({ children }: { children?: React.ReactNode }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  const consumedAbove = useContext(ScreenTopInsetConsumedContext);
  const [online, setOnline] = useState(() => onlineManager.isOnline());

  useEffect(() => onlineManager.subscribe(setOnline), []);

  return (
    <>
      {online ? null : (
        <View testID="offline-banner" style={{ backgroundColor: p.sf2, paddingTop: (consumedAbove ? 0 : insets.top) + 10, paddingBottom: 10, paddingHorizontal: 16 }}>
          <Txt size={13} color={p.mu} align="center">{t.offline}</Txt>
        </View>
      )}
      <ScreenTopInsetConsumedContext.Provider value={consumedAbove || !online}>
        {children}
      </ScreenTopInsetConsumedContext.Provider>
    </>
  );
}

/** True while the device has no usable connection. */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(() => onlineManager.isOnline());
  useEffect(() => onlineManager.subscribe(setOnline), []);
  return online;
}
