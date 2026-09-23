import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { ProductIcon, type ProductIconName } from '../../ui/product';
import { BackHeader } from '../../ui/chrome';
import { ChevronIcon } from '../../ui/icons';
import { useLayoutMode } from '../../theme/textScale';

/**
 * A settings sub-screen's title and its way back — Round 2's one header
 * (`BackHeader`), so the fourteen leaves that use this share it with every
 * other pushed screen.
 */
export function SettingsHeader({ title, onBack, end }: { title: string; onBack: () => void; end?: React.ReactNode }) {
  const { t } = useApp();
  return <BackHeader title={title} onBack={onBack} backLabel={t.settingsBack} end={end} />;
}

/**
 * One tappable settings row (Round 2): a label, an optional second line that
 * says what is there before it is opened, an optional value at the end, and
 * a chevron. `start`/`end` are never used here and neither are `left`/`right`:
 * the row is a flex row, and the root view's `direction` mirrors it.
 */
export function SettingsRow({
  label, sub, value, onPress, testID, tone, first, icon,
}: {
  label: string;
  icon?: ProductIconName;
  sub?: string | undefined;
  value?: string | undefined;
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
  tone?: 'default' | 'warn';
  first?: boolean | undefined;
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
        gap: 12,
        paddingVertical: 16,
        minHeight: 56,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: p.ln,
      }}
    >
      {icon && !stacked ? <ProductIcon name={icon} quiet /> : null}
      <View style={{ flex: 1, gap: 4 }}>
        <Txt role="action" color={tone === 'warn' ? p.wm : p.tx} {...(testID ? { testID } : {})}>{label}</Txt>
        {sub ? <Txt role="supporting" color={p.mu}>{sub}</Txt> : null}
        {value && stacked ? <Txt role="supporting" color={p.mu}>{value}</Txt> : null}
      </View>
      {value && !stacked ? <Txt role="label" weight={400} color={p.mu} style={{ flexShrink: 1, maxWidth: '45%' }}>{value}</Txt> : null}
      {onPress ? <ChevronIcon color={p.mu} rtl={rtl} /> : null}
    </Btn>
  );
}
