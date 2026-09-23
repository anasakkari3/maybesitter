import React, { createContext, useContext } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useApp } from '../state/AppContext';
import { Btn, Card, Pill, Txt } from './primitives';
import { Screen, ScreenScroll } from './screen';
import { BrandLockup } from './brand';
import { BackButton } from './chrome';
import { useLayoutMode } from '../theme/textScale';
import { ChevronIcon } from './icons';
import { availabilityKey, type Availability } from '../features/product/capabilities';

const GroupedRows = createContext(false);

export type ProductIconName = 'spark' | 'calendar' | 'person' | 'link' | 'file' | 'goal' | 'habit' | 'watch' | 'shield' | 'check' | 'photo';
const paths: Record<ProductIconName, string> = {
  spark: 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z',
  calendar: 'M5 5h14v15H5ZM8 2v6M16 2v6M5 10h14M8 14h2M14 14h2',
  person: 'M8 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4 21v-2a8 8 0 0 1 16 0v2Z',
  link: 'M9 8l3-3a5 5 0 0 1 7 7l-3 3M15 16l-3 3a5 5 0 0 1-7-7l3-3M8 16l8-8',
  file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
  goal: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 7a5 5 0 1 0 0 10 5 5 0 1 0 0-10',
  habit: 'M4 6h7l1 2 1-2h7v15h-7l-1 1-1-1H4ZM12 8v14',
  watch: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 7v5l4 2',
  shield: 'M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6ZM8 12l3 3 5-6',
  check: 'M5 12l5 5L20 6',
  photo: 'M3 4h18v16H3ZM3 16l6-6 5 5 3-3 4 4M15 8h1',
};
export function ProductIcon({ name = 'spark', quiet = false }: { name?: ProductIconName; quiet?: boolean }) {
  const { p } = useApp();
  return <View accessible={false} style={{ width: 46, height: 46, borderRadius: 16, backgroundColor: quiet ? p.sf2 : p.acs, alignItems: 'center', justifyContent: 'center' }}>
    <Svg width={25} height={25} viewBox="0 0 24 24"><Path d={paths[name]} fill="none" stroke={quiet ? p.mu : p.ac} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" /></Svg>
  </View>;
}
export function AvailabilityBadge({ status }: { status: Availability }) {
  const { t, p } = useApp();
  const future = status === 'COMING_SOON';
  const available = status === 'LIVE' || status === 'AVAILABLE';
  return <View style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: future ? p.sf2 : available ? p.successSoft : p.wms }}>
    <Txt role="metadata" color={future ? p.mu : available ? p.success : p.wm}>{t[availabilityKey[status]]}</Txt>
  </View>;
}
export function ProductPage({ title, subtitle, children, id, overlay }: { title: string; subtitle?: string; children: React.ReactNode; id: string; overlay?: React.ReactNode }) {
  const { actions, p, t } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return <Screen overlay={overlay} testID={`product-${id}`} pinned={<View style={{ gap: 12, paddingBottom: 6 }}>
    {!stacked ? <BrandLockup compact /> : null}
    <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 12, alignItems: stacked ? 'flex-start' : 'center' }}>
      <BackButton label={t.back} onPress={() => actions.back()} />
      {!stacked ? <View style={{ flexShrink: 1 }}><Txt role="section">{title}</Txt></View> : null}
    </View>
  </View>}>
    <ScreenScroll testID={`product-scroll-${id}`} gap={16} keyboardShouldPersistTaps="handled">
      {stacked ? <Txt role="section">{title}</Txt> : null}
      {subtitle ? <Txt role="supporting" color={p.mu}>{subtitle}</Txt> : null}
      {children}
    </ScreenScroll>
  </Screen>;
}
export function ProductSection({ title, body, icon, status, children }: { title: string; body?: string | undefined; icon?: ProductIconName; status?: Availability; children?: React.ReactNode }) {
  const { p } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return <Card style={{ gap: 16 }}>
    <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 14, alignItems: 'flex-start' }}>
      {icon ? <ProductIcon name={icon} /> : null}
      <View style={{ flex: stacked ? undefined : 1, gap: 6 }}>
        <Txt role="section">{title}</Txt>
        {body ? <Txt role="supporting" color={p.mu}>{body}</Txt> : null}
        {status ? <AvailabilityBadge status={status} /> : null}
      </View>
    </View>
    <GroupedRows.Provider value={true}>{children}</GroupedRows.Provider>
  </Card>;
}
export function ProductRow({ title, body, icon = 'spark', onPress, status, id }: { title: string; body?: string | undefined; icon?: ProductIconName; onPress?: () => void; status?: Availability; id?: string }) {
  const { p, rtl } = useApp();
  const grouped = useContext(GroupedRows);
  const stacked = useLayoutMode() !== 'normal';
  const content = <>
    <ProductIcon name={icon} quiet={!onPress} />
    <View style={{ flex: stacked ? undefined : 1, gap: 5, alignItems: 'flex-start' }}>
      <Txt role="card">{title}</Txt>
      {body ? <Txt role="supporting" color={p.mu}>{body}</Txt> : null}
      {status ? <AvailabilityBadge status={status} /> : null}
    </View>
    {onPress && !stacked ? <ChevronIcon color={p.mu} rtl={rtl} /> : null}
  </>;
  const style = { padding: grouped ? 4 : 16, paddingVertical: grouped ? 12 : 16, gap: 12, borderRadius: grouped ? 0 : 22, borderWidth: grouped ? 0 : 1, borderBottomWidth: 1, borderColor: p.ln, backgroundColor: grouped ? 'transparent' : p.glass, flexDirection: stacked ? 'column' as const : 'row' as const, alignItems: 'flex-start' as const, minHeight: 72 };
  return onPress ? <Btn testID={id} label={[title, body].filter(Boolean).join('. ')} onPress={onPress} style={style}>{content}</Btn> : <View testID={id} style={style}>{content}</View>;
}
export function PreviewNotice() {
  const { t, p } = useApp();
  return <View testID="product-preview-notice" style={{ padding: 16, borderRadius: 18, borderWidth: 1, borderStyle: 'dashed', borderColor: p.prop, gap: 6 }}>
    <Txt role="label" color={p.ac}>{t.xPreview}</Txt><Txt role="supporting" color={p.mu}>{t.xPreviewBody}</Txt>
  </View>;
}
export function ProductActions({ children }: { children: React.ReactNode }) {
  const stacked = useLayoutMode() !== 'normal';
  return <View style={{ flexDirection: stacked ? 'column' : 'row', flexWrap: 'wrap', gap: 10 }}>{children}</View>;
}
export function PreviewAction({ label }: { label: string }) {
  const { t } = useApp();
  return <Pill label={`${label} · ${t.xSoon}`} disabled kind="outline" />;
}
