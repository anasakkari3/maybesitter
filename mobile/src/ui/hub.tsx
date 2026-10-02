import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useLayoutMode } from '../theme/textScale';
import { ChevronIcon } from './icons';
import { Btn, Txt } from './primitives';
import { ReferenceIcon } from './referenceIcons';

/**
 * The two Stitch hubs' grammar (2026-10-02): «أشيائي» and «يتابع لك».
 *
 *   HubRow       a large entry: a tinted icon tile, a title, one muted line,
 *                an optional count and the chevron. Opens an existing screen.
 *   HubHeading   a section's small heading, with an optional count beside it
 *                and an optional action at the end.
 */

export type HubTone = 'accent' | 'attention' | 'success' | 'neutral';

function toneColors(tone: HubTone, p: ReturnType<typeof useApp>['p']) {
  switch (tone) {
    case 'accent': return { bg: p.acs, fg: p.acd };
    case 'attention': return { bg: p.wms, fg: p.wm };
    case 'success': return { bg: p.successSoft, fg: p.success };
    default: return { bg: p.sf2, fg: p.tx };
  }
}

/** A count in a quiet pill: digits are Latin in every language. */
export function CountChip({ count, testID }: { count: number; testID?: string | undefined }) {
  const { p } = useApp();
  return (
    <View style={{ minWidth: 28, minHeight: 24, paddingHorizontal: 8, borderRadius: 999, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
      <Txt latin size={13} weight={600} color={p.tx} align="center" testID={testID}>{String(count)}</Txt>
    </View>
  );
}

export function HubRow({ testID, icon, tone = 'neutral', title, sub, count, badge, onPress }: {
  testID: string;
  icon: string;
  tone?: HubTone;
  title: string;
  sub?: string | undefined;
  /** Shown only once it is known; a row whose data is loading has none. */
  count?: number | undefined;
  /** A state chip under the line (a watch's «شغّال» / «موقّف»), in words. */
  badge?: React.ReactNode;
  onPress: () => void;
}) {
  const { p, rtl } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  const c = toneColors(tone, p);
  return (
    <Btn
      testID={testID}
      label={[title, sub, count === undefined ? undefined : String(count)].filter(Boolean).join('. ')}
      onPress={onPress}
      scaleTo={0.985}
      style={{
        minHeight: 72, borderRadius: 20, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf,
        paddingVertical: 14, paddingHorizontal: 16, gap: 14,
        flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center',
      }}
    >
      <View accessible={false} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ReferenceIcon name={icon} size={22} color={c.fg} />
      </View>
      <View style={{ flex: stacked ? undefined : 1, gap: 2, alignItems: 'flex-start' }}>
        <Txt size={17} weight={700}>{title}</Txt>
        {sub ? <Txt size={13} color={p.mu}>{sub}</Txt> : null}
        {badge ?? null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {count === undefined ? null : <CountChip count={count} testID={`${testID}-count`} />}
        {stacked ? null : <ChevronIcon color={p.mu} rtl={rtl} />}
      </View>
    </Btn>
  );
}

export function HubHeading({ title, icon, count, end, testID }: {
  title: string;
  icon?: string | undefined;
  count?: number | undefined;
  end?: React.ReactNode;
  testID?: string | undefined;
}) {
  const { p } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return (
    <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 4, paddingTop: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        {icon ? <ReferenceIcon name={icon} size={18} color={p.mu} /> : null}
        <Txt role="section" size={17} weight={700} testID={testID} style={{ flexShrink: 1 }}>{title}</Txt>
        {count === undefined ? null : <CountChip count={count} />}
      </View>
      {end ?? null}
    </View>
  );
}
