import React from 'react';
import { Animated, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useLayoutMode } from '../theme/textScale';
import { Btn, Txt } from './primitives';
import { ReferenceIcon } from './referenceIcons';
import { useSheetMotion } from './motion';

/**
 * The Stitch sheet (2026-10-02): a grabber, a header with a tinted icon, the
 * title and a round close, then the body. One look for the app-wide
 * `SheetHost` (details' postpone, edit, drop, delete) and for the sheets a
 * screen opens about something on itself (Today's «مش هلّق» and conflict line).
 */
export type SheetTone = 'accent' | 'attention' | 'neutral';

function toneColors(tone: SheetTone, p: ReturnType<typeof useApp>['p']) {
  switch (tone) {
    case 'accent': return { bg: p.acs, fg: p.acd };
    case 'attention': return { bg: p.wms, fg: p.wm };
    default: return { bg: p.sf2, fg: p.tx };
  }
}

export function SheetGrabber() {
  const { p } = useApp();
  return <View accessible={false} style={{ width: 48, height: 5, borderRadius: 3, backgroundColor: p.lnStrong, alignSelf: 'center', marginBottom: 6 }} />;
}

/**
 * The header row. The close is 44 × 44 and announced as «إغلاق»; the title is
 * a heading, and wraps rather than truncating at the large text sizes.
 */
export function SheetHeader({ title, icon, tone = 'accent', onClose, closeTestID = 'sheet-close', titleTestID }: {
  title: string;
  icon?: string | undefined;
  tone?: SheetTone;
  onClose?: (() => void) | undefined;
  closeTestID?: string | undefined;
  titleTestID?: string | undefined;
}) {
  const { t, p } = useApp();
  const c = toneColors(tone, p);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {icon ? (
        <View accessible={false} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
          <ReferenceIcon name={icon} size={20} color={c.fg} />
        </View>
      ) : null}
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <Txt role="section" size={18} weight={700} testID={titleTestID}>{title}</Txt>
      </View>
      {onClose ? (
        <Btn label={t.close} onPress={onClose} testID={closeTestID} scaleTo={0.94}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: p.sf2 }}>
          <ReferenceIcon name="close" size={20} color={p.mu} />
        </Btn>
      ) : null}
    </View>
  );
}

/**
 * A choice in a sheet's grid: a label, and under it the instant it means.
 * Two to a row at ordinary sizes, one per row when the text needs the room.
 */
export function SheetChoice({ label, sub, onPress, disabled, testID, subTestID }: {
  label: string;
  sub?: string | undefined;
  onPress: () => void;
  disabled?: boolean | undefined;
  testID: string;
  subTestID?: string | undefined;
}) {
  const { p } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  return (
    <Btn
      testID={testID}
      label={sub ? `${label}, ${sub}` : label}
      disabled={disabled}
      onPress={onPress}
      scaleTo={0.97}
      style={{
        width: stacked ? '100%' : '48%', flexGrow: 1, minHeight: 64, borderRadius: 16,
        paddingVertical: 12, paddingHorizontal: 14, gap: 2, alignItems: 'flex-start', justifyContent: 'center',
        backgroundColor: disabled ? p.dis : p.sf2, borderWidth: 1, borderColor: p.ln,
      }}
    >
      <Txt size={15} weight={600} color={disabled ? p.disTx : p.tx}>{label}</Txt>
      {sub ? <Txt size={13} color={disabled ? p.disTx : p.mu} testID={subTestID}>{sub}</Txt> : null}
    </Btn>
  );
}

/** The note every proposal-bearing sheet ends on: a hairline, then the line, centred. */
export function SheetFootnote({ text, testID }: { text: string; testID?: string | undefined }) {
  const { p } = useApp();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 10 }}>
      <Txt size={13} color={p.mu} align="center" testID={testID}>{text}</Txt>
    </View>
  );
}

/**
 * A sheet a screen owns, over everything (the bar and the «احكيها» pill too).
 *
 * A `Modal` rather than the app's `SheetHost`, because what it is about lives
 * on the screen that opens it — a proposal, a line on Today — not in the
 * navigation history `SheetHost` reads its subject from. Nothing in these
 * sheets takes the keyboard, so `AvoidKeyboard` has nothing to do here.
 * Hardware back closes it (`onRequestClose`); so does the scrim.
 */
export function BottomSheet({ visible, onClose, testID, children }: {
  visible: boolean;
  onClose: () => void;
  testID?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      {visible ? <SheetBody onClose={onClose} testID={testID}>{children}</SheetBody> : null}
    </Modal>
  );
}

function SheetBody({ onClose, testID, children }: { onClose: () => void; testID?: string | undefined; children: React.ReactNode }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  // Mounted with the sheet, so the motion starts from closed every time.
  const m = useSheetMotion();
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Animated.View style={[{ position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, backgroundColor: p.scrim }, m.scrim]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel={t.close} />
      </Animated.View>
      <Animated.View
        testID={testID}
        accessibilityViewIsModal
        style={[{
          maxHeight: '88%', backgroundColor: p.sf, borderTopLeftRadius: 28, borderTopRightRadius: 28,
          borderTopWidth: 1, borderColor: p.ln, paddingTop: 12,
          shadowColor: '#000000', shadowOpacity: 0.3, shadowRadius: 24, shadowOffset: { width: 0, height: -8 }, elevation: 16,
        }, m.panel]}
      >
        <SheetGrabber />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: insets.bottom + 20, gap: 14 }}>
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}
