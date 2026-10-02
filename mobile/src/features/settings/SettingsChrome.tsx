import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ProductIcon, type ProductIconName } from '../../ui/product';
import { ChevronIcon } from '../../ui/icons';
import { useLayoutMode } from '../../theme/textScale';

/**
 * Settings' own chrome (Stitch `06-settings`, 2026-10-02).
 *
 *   SettingsHeader   the top bar every settings page shares: a 44 × 44 back
 *                    arrow and the page's title on one line.
 *   SettingsHubRow   a destination on the Settings hub: a round tinted icon,
 *                    a title, one muted line of what is inside, a chevron.
 *   SettingsRow      one tappable row of a grouped list, for the category
 *                    pages and the leaves.
 *
 * `start`/`end` are never `left`/`right` here: rows are flex rows, and the
 * root view's `direction` mirrors them.
 */
export function SettingsHeader({ title, onBack, end, backLabel }: {
  title: string;
  onBack: () => void;
  end?: React.ReactNode;
  backLabel?: string | undefined;
}) {
  const { t, p } = useApp();
  return (
    <View testID="back-header" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52 }}>
      <BackArrowButton label={backLabel ?? t.settingsBack} onPress={onBack} />
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <Txt role="page" size={22} weight={700} color={p.tx}>{title}</Txt>
      </View>
      {end ?? null}
    </View>
  );
}

/** The way back: an arrow pointing to the start edge, 44 × 44, announced in words. */
export function BackArrowButton({ label, onPress, testID = 'header-back' }: { label: string; onPress: () => void; testID?: string }) {
  const { p, rtl } = useApp();
  return (
    <Btn
      label={label}
      onPress={onPress}
      testID={testID}
      scaleTo={0.94}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ transform: [{ scaleX: rtl ? -1 : 1 }] }}>
        <Svg width={24} height={24} viewBox="0 0 24 24">
          <Path d="M19 12H5M11 5l-7 7 7 7" fill="none" stroke={p.tx} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    </Btn>
  );
}

export type SettingsGlyphName = 'calendar' | 'bell' | 'link' | 'shield' | 'sliders';
const glyphs: Record<SettingsGlyphName, string> = {
  calendar: 'M5 5h14v15H5ZM8 2v6M16 2v6M5 10h14',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4ZM10 21h4',
  link: 'M9 8l3-3a5 5 0 0 1 7 7l-3 3M15 16l-3 3a5 5 0 0 1-7-7l3-3M8 16l8-8',
  shield: 'M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6Z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
};

/** A destination on the Settings hub (Stitch): round tinted icon, title, what is inside. */
export function SettingsHubRow({ label, sub, glyph, tint, onPress, testID, subTone, subTestID }: {
  label: string;
  sub?: string | undefined;
  glyph: SettingsGlyphName;
  /** The glyph's colour; the tile stays the quiet raised surface. */
  tint: string;
  onPress: () => void;
  testID: string;
  subTone?: 'default' | 'warn' | undefined;
  subTestID?: string | undefined;
}) {
  const { p, rtl } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return (
    <Btn
      label={label}
      hint={sub}
      onPress={onPress}
      scaleTo={0.985}
      style={{
        minHeight: 72, borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf,
        paddingVertical: 14, paddingHorizontal: 16, gap: 14,
        flexDirection: 'row', alignItems: 'center',
      }}
    >
      {!stacked ? (
        <View accessible={false} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={24} height={24} viewBox="0 0 24 24">
            <Path d={glyphs[glyph]} fill="none" stroke={tint} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
        {/* The testID sits on the label, as on every settings row, so a test reads the word. */}
        <Txt size={16} weight={600} color={p.tx} testID={testID}>{label}</Txt>
        {sub ? <Txt size={13} color={subTone === 'warn' ? p.wm : p.mu} testID={subTestID}>{sub}</Txt> : null}
      </View>
      <ChevronIcon color={p.mu} rtl={rtl} />
    </Btn>
  );
}

/**
 * One tappable settings row (Round 2, Stitch surface): a label, an optional
 * second line that says what is there before it is opened, an optional value
 * at the end, and a chevron.
 */
export function SettingsRow({
  label, sub, value, onPress, testID, tone, first, icon, subTone, subTestID,
}: {
  label: string;
  icon?: ProductIconName;
  sub?: string | undefined;
  value?: string | undefined;
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
  tone?: 'default' | 'warn';
  first?: boolean | undefined;
  /** `warn` when the second line reports something in the way (a blocked permission). */
  subTone?: 'default' | 'warn' | undefined;
  subTestID?: string | undefined;
}) {
  const { p, rtl } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return (
    <Btn
      label={label}
      hint={[sub, value].filter(Boolean).join('. ') || undefined}
      onPress={onPress}
      disabled={!onPress}
      scaleTo={onPress ? 0.98 : 1}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 14,
        minHeight: 60,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: p.ln,
      }}
    >
      {icon && !stacked ? <ProductIcon name={icon} quiet /> : null}
      <View style={{ flex: 1, gap: 3, alignItems: 'flex-start' }}>
        <Txt size={16} weight={600} color={tone === 'warn' ? p.wm : p.tx} {...(testID ? { testID } : {})}>{label}</Txt>
        {sub ? (
          <Txt size={13} color={subTone === 'warn' ? p.wm : p.mu} {...(subTestID ? { testID: subTestID } : {})}>{sub}</Txt>
        ) : null}
        {value && stacked ? <Txt size={13} color={p.mu}>{value}</Txt> : null}
      </View>
      {value && !stacked ? <Txt size={13} color={p.mu} style={{ flexShrink: 1, maxWidth: '45%' }}>{value}</Txt> : null}
      {onPress ? <ChevronIcon color={p.mu} rtl={rtl} /> : null}
    </Btn>
  );
}
