import React, { useId, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useApp } from '../state/AppContext';
import { referenceGradients, referencePalettes } from '../theme/tokens';
import { useLayoutMode } from '../theme/textScale';
import { Btn, Txt } from './primitives';
import { ReferenceIcon } from './referenceIcons';
import { AvatarButton } from './chrome';

export { ReferenceIcon } from './referenceIcons';
type Tone = 'hero' | 'plan' | 'waiting' | 'surface';

/**
 * The palette Today, Calendar and the cards built for them read. Since the
 * Stitch redesign it is the app palette (plus `focus`, `focusSoft`, `heroEdge`)
 * — one look for every screen.
 */
export function useReferencePalette() {
  const { scheme, reduceTransparency } = useApp();
  return useMemo(() => {
    const p = referencePalettes[scheme];
    return reduceTransparency ? { ...p, sfBar: p.sfBarSolid, glass: p.sf } : p;
  }, [scheme, reduceTransparency]);
}

export function ReferenceBackdrop({ tone = 'surface' }: { tone?: Tone }) {
  const { scheme, reduceTransparency } = useApp();
  const id = `reference${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const stops = referenceGradients[scheme][tone];
  if (reduceTransparency) return null;
  return (
    <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, pointerEvents: 'none' }} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="100%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={stops[0]} />
            <Stop offset="48%" stopColor={stops[1]} />
            <Stop offset="100%" stopColor={stops[2]} />
          </LinearGradient>
        </Defs>
        <Rect width="100" height="100" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

export function ReferenceCard({ children, tone = 'surface', pad = 16, style, testID }: {
  children: React.ReactNode; tone?: Tone; pad?: number;
  style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const p = useReferencePalette();
  return <View testID={testID} style={[{
    backgroundColor: p.sf, borderColor: tone === 'hero' ? p.heroEdge : p.ln,
    borderWidth: 1, borderRadius: 20, padding: pad, gap: 12, overflow: 'hidden',
  }, style]}>
    <ReferenceBackdrop tone={tone} />
    {children}
  </View>;
}

/** Reference chrome wired to existing product routes; never adds a fake inbox. */
export function ReferenceHeader({ eyebrow, title, subtitle, end, eyebrowTestID }: {
  eyebrow?: string; title: string; subtitle?: string; end?: React.ReactNode; eyebrowTestID?: string;
}) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const stacked = useLayoutMode() !== 'normal';
  return <View style={{ gap: 24, paddingHorizontal: 4, paddingBottom: 6 }}>
    <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, flex: stacked ? undefined : 1 }}>
        <ReferenceIcon name="logo" size={34} />
        <Txt latin size={22} weight={700} color={p.tx} style={{ flexShrink: 1 }}>MaybeSitter</Txt>
      </View>
      <View style={{ flexDirection: 'row', gap: 4, alignSelf: stacked ? 'flex-end' : undefined }}>
        <Btn label={t.xSearch} testID="reference-search" onPress={() => actions.go('commitments')} style={[styles.headerAction, { borderWidth: 1, borderColor: p.ln }]}>
          <ReferenceIcon name="search" size={22} color={p.tx} />
        </Btn>
        {/* Settings (and the account, notifications, everything else) is one
            tap away behind the avatar since the Stitch redesign. */}
        <AvatarButton />
      </View>
    </View>
    <View style={{ gap: 5 }}>
      {eyebrow ? <Txt size={14} color={p.mu} testID={eyebrowTestID}>{eyebrow}</Txt> : null}
      <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: 10 }}>
        <Txt role="page" size={30} weight={700} color={p.tx} style={stacked ? undefined : { flex: 1 }}>{title}</Txt>
        {end}
      </View>
      {subtitle ? <Txt role="supporting" color={p.mu}>{subtitle}</Txt> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  headerAction: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
