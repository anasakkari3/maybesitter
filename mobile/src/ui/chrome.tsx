import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useApp } from '../state/AppContext';
import { Shimmer } from './motion';
import { Btn, Txt } from './primitives';

/**
 * The screen grammar (Round 2, Phase A/C).
 *
 * Round 1 grew eight header shapes, four back affordances and seven
 * hand-rolled empty states. These are the few forms every screen now
 * composes from, so a reader learns each once:
 *
 *   ScreenHeader  a tab root: an eyebrow (the date), the title, an end slot
 *   BackHeader    a pushed screen: the way back, then the title
 *   SectionLabel  the small muted label over a list
 *   Tag           a state word — proposal · saved · started · fixed · estimated
 *   TextLink      an in-sentence link, underlined in the accent's own tint
 *   EmptyState    the calm "nothing here", never a grey apology
 *   Skeleton      the shape of what is loading, so the page does not jump
 *   Notice        one line of context with, at most, one action
 */

export function ScreenHeader({ eyebrow, title, end, eyebrowTestID }: {
  eyebrow?: string | undefined;
  title: string;
  end?: React.ReactNode;
  eyebrowTestID?: string | undefined;
}) {
  const { p } = useApp();
  return (
    // `flex-start` rather than `flex-end`: at the accessibility text sizes the
    // title block is taller than the screen's own header, and an end slot
    // aligned to its bottom slid down into the tab bar (found on device, AX5).
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingHorizontal: 4 }}>
      <View style={{ gap: 2, flexShrink: 1 }}>
        {/* One line, always. The eyebrow is a date or a range — secondary by
            definition — and at the accessibility text sizes a wrapping one
            pushed the screen's own title off the top of the display. The title
            below it wraps freely: it is the content, and it may take the room
            the reader asked for. Found on device at AX5, Round 2 Phase M. */}
        {eyebrow ? <Txt size={13} color={p.mu} lines={1} testID={eyebrowTestID}>{eyebrow}</Txt> : null}
        <Txt size={28} weight={600} lh={1.2}>{title}</Txt>
      </View>
      {end ?? null}
    </View>
  );
}

/**
 * The way back is a word, not a chevron: «رجوع» reads in every language and
 * announces itself. It sits at the start edge, above the title, so the title
 * can be as long as it needs to be.
 *
 * It does **not** clear the Dynamic Island. It used to — `paddingTop:
 * insets.top + 8` — from inside the scroller it was usually rendered in,
 * which moved the first thing down and let everything after it scroll up
 * under the island (F2). `Screen` owns the inset now, and pins this header
 * outside the scroller so it cannot leave (F1). See `ui/screen.tsx`.
 */
export function BackHeader({ title, onBack, end, backLabel }: {
  title: string;
  onBack: () => void;
  end?: React.ReactNode;
  backLabel?: string | undefined;
}) {
  const { t, p } = useApp();
  const label = backLabel ?? t.back;
  return (
    <View testID="back-header" style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Btn label={label} onPress={onBack} scaleTo={0.97} testID="header-back" style={{ alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 2, minHeight: 44, justifyContent: 'center' }}>
          <Txt size={14} weight={600} color={p.acd}>{label}</Txt>
        </Btn>
        {end ?? null}
      </View>
      <Txt size={26} weight={600} lh={1.3}>{title}</Txt>
    </View>
  );
}

export function SectionLabel({ children, testID }: { children: string; testID?: string | undefined }) {
  const { p } = useApp();
  return <Txt size={13} weight={600} color={p.mu} testID={testID} style={{ paddingHorizontal: 4 }}>{children}</Txt>;
}

export type TagKind = 'proposal' | 'saved' | 'started' | 'fixed' | 'estimated' | 'must' | 'should' | 'muted';

/**
 * A state, in a word. A proposal's tag is dashed in the proposal colour: it
 * is the one visual promise this product makes that nothing has been written.
 */
export function Tag({ kind, label, testID }: { kind: TagKind; label: string; testID?: string | undefined }) {
  const { p } = useApp();
  const look: Record<TagKind, { bg?: string; fg: string; border?: string; dashed?: boolean; weight: 400 | 600 }> = {
    proposal: { fg: p.mu, border: p.prop, dashed: true, weight: 400 },
    saved: { bg: p.acs, fg: p.acd, weight: 600 },
    started: { bg: p.acs, fg: p.acd, weight: 600 },
    fixed: { bg: p.sf2, fg: p.mu, weight: 400 },
    estimated: { bg: p.sf2, fg: p.mu, weight: 400 },
    must: { bg: p.wms, fg: p.wm, weight: 600 },
    should: { fg: p.mu, border: p.ln, weight: 400 },
    muted: { bg: p.sf2, fg: p.mu, weight: 400 },
  };
  const l = look[kind];
  return (
    <View
      style={{
        alignSelf: 'flex-start', borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10,
        backgroundColor: l.bg ?? 'transparent',
        borderWidth: l.border ? 1 : 0, borderColor: l.border, borderStyle: l.dashed ? 'dashed' : 'solid',
      }}
    >
      {/* The testID sits on the text, so a test reads the word, not a box. */}
      <Txt size={12} weight={l.weight} color={l.fg} testID={testID}>{label}</Txt>
    </View>
  );
}

/** The accent, underlined in its own lighter tint — Round 2's one link treatment. */
export function TextLink({ label, onPress, testID, size = 14 }: { label: string; onPress: () => void; testID?: string | undefined; size?: number }) {
  const { p } = useApp();
  return (
    <Btn label={label} onPress={onPress} scaleTo={0.97} testID={testID} accessibilityRole="link" style={{ alignSelf: 'flex-start', paddingVertical: 4, minHeight: 32, justifyContent: 'center' }}>
      <Txt size={size} weight={600} color={p.acd} style={{ textDecorationLine: 'underline', textDecorationColor: p.ul }}>{label}</Txt>
    </Btn>
  );
}

export function EmptyState({ title, body, testID, action, top = 70 }: {
  title: string;
  body?: string | undefined;
  testID?: string | undefined;
  action?: React.ReactNode;
  top?: number;
}) {
  const { p } = useApp();
  return (
    <View testID={testID} style={{ marginTop: top, alignItems: 'center', gap: 12, paddingHorizontal: 24 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: p.acs }} />
      <Txt size={20} weight={600} align="center">{title}</Txt>
      {body ? <Txt size={14} color={p.mu} align="center" lh={1.6} style={{ maxWidth: 320 }}>{body}</Txt> : null}
      {action ?? null}
    </View>
  );
}

/** The shape of what is coming, so the page does not jump when it arrives. */
export function Skeleton({ heights, label, testID }: { heights: readonly number[]; label: string; testID?: string | undefined }) {
  const { p } = useApp();
  return (
    <View accessibilityLabel={label} accessibilityRole="progressbar" testID={testID} style={{ gap: 12 }}>
      {heights.map((h, i) => (
        <Shimmer key={i} style={{ height: h, borderRadius: h > 100 ? 24 : 20, backgroundColor: p.sf2 }} />
      ))}
    </View>
  );
}

export function Notice({ text, action, onAction, testID, actionTestID, style }: {
  text: string;
  action?: string | undefined;
  onAction?: (() => void) | undefined;
  testID?: string | undefined;
  actionTestID?: string | undefined;
  style?: StyleProp<ViewStyle>;
}) {
  const { p } = useApp();
  return (
    <View testID={testID} style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 }, style]}>
      <Txt size={13} color={p.mu} lh={1.45} style={{ flex: 1 }}>{text}</Txt>
      {action && onAction ? <TextLink label={action} onPress={onAction} size={13} testID={actionTestID} /> : null}
    </View>
  );
}
