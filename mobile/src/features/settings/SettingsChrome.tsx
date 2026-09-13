import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';

/** A settings sub-screen's title and its way back. */
export function SettingsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t, p } = useApp();
  return (
    <View style={{ gap: 10 }}>
      <Btn
        label={t.settingsBack}
        onPress={onBack}
        scaleTo={0.97}
        style={{ alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 2, minHeight: 32 }}
      >
        <Txt size={14} color={p.ac}>{t.settingsBack}</Txt>
      </Btn>
      <Txt size={26} weight={600} lh={1.3}>{title}</Txt>
    </View>
  );
}

/**
 * One tappable settings row.
 *
 * `start`/`end` are never used here and neither are `left`/`right`: the row is
 * a flex row, and the root view's `direction` mirrors it for Arabic and Hebrew
 * without this component knowing which way it is being read.
 */
export function SettingsRow({
  label, value, onPress, testID, tone,
}: {
  label: string;
  value?: string | undefined;
  onPress?: (() => void) | undefined;
  testID?: string;
  tone?: 'default' | 'warn';
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
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 18,
        minHeight: 52,
        borderTopWidth: 1,
        borderTopColor: p.ln,
      }}
    >
      <Txt
        size={15}
        // Spread rather than `prop={x ?? undefined}`: the app compiles with
        // exactOptionalPropertyTypes, so an explicit undefined is an error.
        {...(testID ? { testID } : {})}
        {...(tone === 'warn' ? { color: p.wm } : {})}
      >
        {label}
      </Txt>
      {value ? <Txt size={13} color={p.mu}>{value}</Txt> : null}
    </Btn>
  );
}
