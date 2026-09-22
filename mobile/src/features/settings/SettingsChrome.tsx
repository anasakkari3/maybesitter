import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { BackHeader } from '../../ui/chrome';

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
  label, sub, value, onPress, testID, tone, first,
}: {
  label: string;
  sub?: string | undefined;
  value?: string | undefined;
  onPress?: (() => void) | undefined;
  testID?: string | undefined;
  tone?: 'default' | 'warn';
  first?: boolean | undefined;
}) {
  const { p } = useApp();
  return (
    <Btn
      label={label}
      onPress={onPress}
      disabled={!onPress}
      scaleTo={onPress ? 0.98 : 1}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 13,
        minHeight: 56,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: p.ln,
      }}
    >
      <View style={{ flex: 1, gap: 1 }}>
        <Txt size={15} color={tone === 'warn' ? p.wm : p.tx} {...(testID ? { testID } : {})}>{label}</Txt>
        {sub ? <Txt size={12} color={p.mu}>{sub}</Txt> : null}
      </View>
      {value ? <Txt size={13} color={p.mu}>{value}</Txt> : null}
      {onPress ? <Txt size={16} color={p.mu} latin style={{ transform: [{ scaleX: 1 }] }}>›</Txt> : null}
    </Btn>
  );
}
