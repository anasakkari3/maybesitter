import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useApp } from '../state/AppContext';
import { Shimmer } from './motion';
import { Btn, Txt } from './primitives';
import { useLayoutMode } from '../theme/textScale';
import { BrandLockup, BrandMark } from './brand';
import { ChevronIcon, TodayIcon } from './icons';
import { ReferenceIcon } from './referenceIcons';
import { useOptionalAuth } from '../auth/AuthProvider';
import { scriptOfText } from '../theme/fonts';

/**
 * The first letter of the person's name, or of their email when the account
 * has no name. Null when there is neither (an Apple private relay with no
 * name still has an email, so this is rare).
 */
export function avatarInitial(user: { displayName: string | null; email: string | null } | null | undefined): string | null {
  const source = (user?.displayName ?? '').trim() || (user?.email ?? '').trim();
  const first = Array.from(source)[0];
  return first ? first.toUpperCase() : null;
}

/**
 * The way into Settings (Stitch redesign, 2026-10-02): a round avatar with the
 * first letter of the person's name, at the end of every tab root's header.
 * Settings is not in the bar any more; this pushes it onto the tab it is
 * pressed on, so back returns there. 44 × 44, announced as "Settings".
 */
export function AvatarButton() {
  const { t, p, script, actions } = useApp();
  const user = useOptionalAuth()?.user ?? null;
  const letter = avatarInitial(user);
  // A letter the UI's face cannot draw (an Arabic initial in the Hebrew UI)
  // falls back to the person glyph rather than to tofu.
  const run = letter ? scriptOfText(letter, script) : null;
  const drawable = letter !== null && (run === script || run === 'latin');
  return (
    <Btn
      testID="open-settings"
      label={t.settingsTitle}
      hint={t.openSettingsHint}
      onPress={() => actions.go('settings')}
      scaleTo={0.94}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: p.acs, borderWidth: 1, borderColor: p.ac }}
    >
      {drawable
        ? <Txt size={17} weight={700} color={p.acd} align="center" lh={1.2} latin={run === 'latin'} testID="open-settings-initial">{letter}</Txt>
        : <ReferenceIcon name="person" size={21} color={p.acd} />}
    </Btn>
  );
}

/** Equal actions at ordinary sizes; full-width answers when text needs room. */
export function ActionRow({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const stacked = useLayoutMode() !== 'normal';
  return <View testID={testID} style={{ flexDirection: stacked ? 'column' : 'row', gap: 10 }}>
    {React.Children.toArray(children).map((child, i) => <View key={i} style={stacked ? undefined : { flex: 1 }}>{child}</View>)}
  </View>;
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { p, rtl } = useApp();
  return <Btn label={label} onPress={onPress} testID="header-back" scaleTo={0.97}
    style={{ alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.glass, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <ChevronIcon color={p.mu} rtl={rtl} back />
    <Txt role="action" color={p.tx} style={{ flexShrink: 1 }}>{label}</Txt>
  </Btn>;
}

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

export function ScreenHeader({ eyebrow, title, end, eyebrowTestID, brand = true }: {
  eyebrow?: string | undefined;
  title: string;
  end?: React.ReactNode;
  eyebrowTestID?: string | undefined;
  /** The wordmark above the title. The Stitch tab roots go without it. */
  brand?: boolean;
}) {
  const { p } = useApp();
  const compact = useLayoutMode() !== 'normal';
  return (
    <View style={{ gap: 16 }}>
      {!compact && brand ? <BrandLockup /> : null}
    {/* `flex-start` rather than `flex-end`: at the accessibility text sizes the
    title block stays start-aligned at accessibility sizes. */}
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingHorizontal: 4 }}>
      <View style={{ gap: 2, flexShrink: 1 }}>
        {/* One line, always. The eyebrow is a date or a range — secondary by
            definition — and at the accessibility text sizes a wrapping one
            pushed the screen's own title off the top of the display. The title
            below it wraps freely: it is the content, and it may take the room
            the reader asked for. Found on device at AX5, Round 2 Phase M. */}
        {eyebrow ? <Txt size={13} color={p.mu} lines={1} testID={eyebrowTestID}>{eyebrow}</Txt> : null}
        <Txt role="page" weight={700}>{title}</Txt>
      </View>
      {end ?? null}
    </View>
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
  const { t } = useApp();
  const label = backLabel ?? t.back;
  return (
    <View testID="back-header" style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <BackButton label={label} onPress={onBack} />
        {end ?? <BrandMark size={28} />}
      </View>
      <View style={{ alignItems: 'flex-start' }}><Txt role="page">{title}</Txt></View>
    </View>
  );
}

export function SectionLabel({ children, testID }: { children: string; testID?: string | undefined }) {
  const { p } = useApp();
  return <Txt role="label" color={p.mu} testID={testID} style={{ paddingHorizontal: 4, paddingTop: 6, paddingBottom: 2 }}>{children}</Txt>;
}

export type TagKind = 'proposal' | 'saved' | 'started' | 'fixed' | 'estimated' | 'must' | 'should' | 'muted' | 'important' | 'nice';

/**
 * The chip for an importance (Stitch): «لازم» coral, «مهم» amber, «حلو» green.
 * Every chip is a tint with solid text on it, the contrast-tested pairs.
 */
export function priorityTagKind(importance: 'must' | 'should' | 'nice' | null | undefined): TagKind {
  return importance === 'must' ? 'must' : importance === 'should' ? 'important' : importance === 'nice' ? 'nice' : 'muted';
}

/**
 * A state, in a word. A proposal's tag is dashed in the proposal colour: it
 * is the one visual promise this product makes that nothing has been written.
 */
export function Tag({ kind, label, testID }: { kind: TagKind; label: string; testID?: string | undefined }) {
  const { p } = useApp();
  const look: Record<TagKind, { bg?: string; fg: string; border?: string; dashed?: boolean; weight: 400 | 600 }> = {
    proposal: { fg: p.mu, border: p.prop, dashed: true, weight: 400 },
    saved: { bg: p.successSoft, fg: p.success, weight: 600 },
    started: { bg: p.acs, fg: p.acd, weight: 600 },
    fixed: { bg: p.sf2, fg: p.mu, weight: 400 },
    estimated: { bg: p.sf2, fg: p.mu, weight: 400 },
    must: { bg: p.acs, fg: p.acd, weight: 600 },
    should: { fg: p.mu, border: p.ln, weight: 400 },
    muted: { bg: p.sf2, fg: p.mu, weight: 400 },
    important: { bg: p.wms, fg: p.wm, weight: 600 },
    nice: { bg: p.successSoft, fg: p.success, weight: 600 },
  };
  const l = look[kind];
  return (
    <View
      style={{
        alignSelf: 'flex-start', borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10,
        backgroundColor: l.bg ?? 'transparent',
        borderWidth: l.border ? 1 : 0, borderColor: l.border, borderStyle: l.dashed ? 'dashed' : 'solid',
      }}
    >
      {/* The testID sits on the text, so a test reads the word, not a box. */}
      <Txt size={13} weight={l.weight} color={l.fg} testID={testID}>{label}</Txt>
    </View>
  );
}

/** The accent, underlined in its own lighter tint — Round 2's one link treatment. */
export function TextLink({ label, onPress, testID, size = 14 }: { label: string; onPress: () => void; testID?: string | undefined; size?: number }) {
  const { p } = useApp();
  return (
    <Btn label={label} onPress={onPress} scaleTo={0.97} testID={testID} accessibilityRole="link" style={{ alignSelf: 'flex-start', paddingVertical: 6, minHeight: 44, justifyContent: 'center', flexShrink: 1 }}>
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
      <View accessible={false} style={{ width: 56, height: 56, borderRadius: 20, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}><TodayIcon color={p.mu} /></View>
      <Txt role="section" align="center">{title}</Txt>
      {body ? <Txt role="supporting" color={p.mu} align="center" style={{ maxWidth: 320 }}>{body}</Txt> : null}
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
  const stacked = useLayoutMode() !== 'normal';
  return (
    <View testID={testID} style={[{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: 10, backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 }, style]}>
      <Txt role="supporting" color={p.mu} style={stacked ? undefined : { flex: 1 }}>{text}</Txt>
      {action && onAction ? <TextLink label={action} onPress={onAction} size={13} testID={actionTestID} /> : null}
    </View>
  );
}
