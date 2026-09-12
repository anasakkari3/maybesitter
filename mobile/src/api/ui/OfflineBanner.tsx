import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { onlineManager } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';

/**
 * "You're offline", from the same `onlineManager` the query layer uses.
 *
 * Reading connectivity from one source rather than a second NetInfo
 * subscription is what keeps the banner and the behaviour in step: if the
 * banner is up, mutations really are disabled, and when it goes the refetch
 * has already been triggered.
 */
export function OfflineBanner() {
  const { t, p } = useApp();
  const [online, setOnline] = useState(() => onlineManager.isOnline());

  useEffect(() => onlineManager.subscribe(setOnline), []);

  if (online) return null;

  return (
    <View style={{ backgroundColor: p.sf2, paddingVertical: 10, paddingHorizontal: 16 }}>
      <Txt size={13} color={p.mu} align="center">{t.offline}</Txt>
    </View>
  );
}

/** True while the device has no usable connection. */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(() => onlineManager.isOnline());
  useEffect(() => onlineManager.subscribe(setOnline), []);
  return online;
}
