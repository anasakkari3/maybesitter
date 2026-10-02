import React, { useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ReferenceIcon } from '../../ui/referenceIcons';
import { useLayoutMode } from '../../theme/textScale';
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
  const stacked = useLayoutMode() !== 'normal';

  useEffect(() => onlineManager.subscribe(setOnline), []);

  return (
    <>
      {online ? null : (
        // Stitch `01c`: an amber card on the page, a cloud with a line through
        // it, the sentence, and «جرّب كمان مرّة» — which asks the network again
        // (`NetInfo.refresh`), the same source the query layer listens to.
        <View testID="offline-banner" style={{ backgroundColor: p.bg, paddingTop: (consumedAbove ? 0 : insets.top) + 10, paddingBottom: 4, paddingHorizontal: 16 }}>
          <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: 10, backgroundColor: p.wms, borderWidth: 1, borderColor: p.prop, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: stacked ? undefined : 1 }}>
              <View accessible={false} style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: p.wms, alignItems: 'center', justifyContent: 'center' }}>
                <ReferenceIcon name="cloud-off" size={20} color={p.wm} />
              </View>
              <Txt size={13} weight={500} color={p.tx} style={{ flex: 1 }} testID="offline-banner-text">{t.offline}</Txt>
            </View>
            <Btn testID="offline-retry" label={t.errorsRetry} onPress={() => { void NetInfo.refresh(); }} scaleTo={0.95}
              style={{ minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: p.prop, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: stacked ? 'flex-start' : undefined }}>
              <ReferenceIcon name="refresh" size={16} color={p.wm} />
              <Txt size={13} weight={600} color={p.wm}>{t.errorsRetry}</Txt>
            </Btn>
          </View>
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
