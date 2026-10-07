import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useApp } from '../state/AppContext';
import { Btn, Txt } from './primitives';
import { ReferenceIcon } from './referenceIcons';

/**
 * An explanation the person opens only if they want it (owner audit
 * 2026-10-06, images 5–9).
 *
 * Settings and goal cards carried a paragraph under every title. The owner
 * asked for the paragraph to go behind a small arrow next to the control it
 * explains, so the screen shows the decision and the reason is one tap away.
 *
 * The body is not rendered at all while closed — not hidden, absent — so it
 * takes no room, a screen reader does not read it, and a test can say
 * "the explanation is not on screen" by its testID alone.
 *
 * `children` is the row the arrow sits beside (usually the title). Without
 * children the arrow stands on its own at the row's end.
 */
export function Disclosure({ id, body, children, label, style }: {
  /** Prefix for `${id}-why` (the control) and `${id}-why-body` (the text). */
  id: string;
  body: string;
  children?: React.ReactNode;
  /** What the control is about, for a screen reader: «ليش؟ — <label>». Defaults to the bare «ليش؟». */
  label?: string | undefined;
  style?: StyleProp<ViewStyle>;
}) {
  const { t, p } = useApp();
  const [open, setOpen] = React.useState(false);
  const a11yLabel = label ? `${t.memoryWhy} ${label}` : t.memoryWhy;

  return (
    <View testID={`${id}-disclosure`} style={[{ gap: 6, alignSelf: 'stretch' }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {children ? <View style={{ flex: 1, minWidth: 0 }}>{children}</View> : <View style={{ flex: 1 }} />}
        <Btn
          testID={`${id}-why`}
          label={a11yLabel}
          hint={open ? t.memoryWhyHide : undefined}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(v => !v)}
          scaleTo={0.9}
          style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 }}
        >
          <ReferenceIcon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={p.mu} />
        </Btn>
      </View>
      {open ? (
        <Txt role="supporting" color={p.mu} lh={1.5} testID={`${id}-why-body`}>{body}</Txt>
      ) : null}
    </View>
  );
}
