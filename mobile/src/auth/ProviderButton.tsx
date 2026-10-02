import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Btn, Txt } from '../ui/primitives';

/**
 * The shape the three sign-in buttons share (Stitch `08-sign-in`): 52 tall,
 * radius 16, the mark at the start of a centred label.
 *
 * ── Whose colours ────────────────────────────────────────────────
 *
 * Email is the app's own button and takes the app's surface. Google's and
 * Apple's are not: their marks may only sit on the surfaces their owners
 * publish, so those two take literal colours rather than theme tokens —
 *
 *   Google   light: white fill, #747775 stroke, #1F1F1F label
 *            dark:  #131314 fill, #8E918F stroke, #E3E3E3 label
 *   Apple    light: black fill, white mark and label
 *            dark:  white fill, black mark and label (HIG: never black on dark)
 *
 * Every pair is well above 4.5:1.
 */
export type ProviderLook = 'app' | 'google' | 'apple';

export function providerColors(look: ProviderLook, scheme: 'light' | 'dark', p: ReturnType<typeof useApp>['p']) {
  if (look === 'google') {
    return scheme === 'dark'
      ? { bg: '#131314', border: '#8E918F', fg: '#E3E3E3' }
      : { bg: '#FFFFFF', border: '#747775', fg: '#1F1F1F' };
  }
  if (look === 'apple') {
    return scheme === 'dark'
      ? { bg: '#FFFFFF', border: '#FFFFFF', fg: '#000000' }
      : { bg: '#000000', border: '#000000', fg: '#FFFFFF' };
  }
  return { bg: p.sf, border: p.lnStrong, fg: p.tx };
}

export function ProviderButton({ look, label, mark, onPress, busy = false, testID }: {
  look: ProviderLook;
  label: string;
  /** The provider's mark, drawn in `fg` by the caller. */
  mark: (fg: string) => React.ReactNode;
  onPress: () => void;
  busy?: boolean;
  testID?: string | undefined;
}) {
  const { p, scheme } = useApp();
  const c = providerColors(look, scheme, p);
  return (
    <Btn
      label={label}
      disabled={busy}
      onPress={onPress}
      testID={testID}
      scaleTo={0.98}
      style={{
        backgroundColor: c.bg,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 16,
        minHeight: 52,
        paddingVertical: 12,
        paddingHorizontal: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <View accessible={false}>{mark(c.fg)}</View>
      <Txt size={15} weight={600} color={c.fg} style={{ flexShrink: 1 }}>{label}</Txt>
    </Btn>
  );
}
