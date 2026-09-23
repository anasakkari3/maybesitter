import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useApp } from '../state/AppContext';
import { Txt } from './primitives';

/** Folded ribbon mark derived from the supplied reference identity.
 * Decorative, direction-independent, and static under every motion preference. */
export function BrandMark({ size = 34 }: { size?: number }) {
  const { p } = useApp();
  const id = `brand${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={p.acd} /><Stop offset="1" stopColor={p.ac} /></LinearGradient></Defs>
      <Path d="M5 12C10 0 23 13 32 22C43 11 55 6 59 19C64 35 59 60 49 60C40 60 29 43 23 38C14 48 5 55 3 43C1 34 1 22 5 12Z" fill={`url(#${id})`} />
      <Path d="M24 38C35 27 46 24 60 29C61 45 56 60 49 60C40 60 30 44 24 38Z" fill={p.ink} opacity={0.22} />
    </Svg>
  </View>;
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <BrandMark size={compact ? 28 : 36} />
    <Txt latin size={compact ? 18 : 22} weight={600} style={{ flexShrink: 1 }}>MaybeSitter</Txt>
  </View>;
}
