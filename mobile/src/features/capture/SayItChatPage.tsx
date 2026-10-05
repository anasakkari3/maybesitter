import React from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextStyle,
} from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { textAlignment } from '../../ui/primitives';
import { Rings } from '../../ui/motion';

/** An independent native presentation. The host owns all messages, proposals,
 * permissions, keyboard avoidance, localization, and every state change.
 *
 * Drawn to the Stitch capture screens (`docs/design/stitch-2026-10-02/html/03*`):
 * a full-screen chat with the MaybeSitter mark in the header, plain coral-dot
 * avatars (no robot, no ribbon), the proposal as one block of cards each with
 * its own «ينحفظ» checkbox, a full-width save that says what it saves, and a
 * composer whose every control is at least 44 points. */
export interface ChatColors {
  bg: string; sf: string; sf2: string; tx: string; mu: string;
  ln: string; lnStrong: string; ac: string; acd: string; acs: string;
  onAccent: string; dis: string; disTx: string; success: string;
  iconBg?: string;
  /** Attention (amber): the proposal block's heading. Falls back to the text colour. */
  wm?: string;
  /** A coral edge that is not the accent itself: the listening panel's border. */
  ul?: string;
}
export type ChatIconName = 'calendar' | 'doctor' | 'briefcase' | 'car' | 'pin' | 'clock'
  | 'plus' | 'back' | 'more' | 'check' | 'checks' | 'microphone' | 'send' | 'globe' | 'copy' | 'paste' | 'edit'
  | 'warning' | 'checkCircle' | 'close' | 'info';
export interface ChatMessage { text: string; time?: string; delivered?: boolean }
/**
 * One line of the conversation, in order: the person's (`user`) or the
 * assistant's. `id` names an assistant line the host wrote itself (a save in
 * the chat): its bubble's test id, in place of the position.
 */
export interface ChatHistoryEntry extends ChatMessage {
  role: 'user' | 'assistant'; id?: string;
  /** A save the chat reports: drawn with the confirmed (green) edge and check. */
  tone?: 'saved';
  /** Controls inside the bubble, under its words (Undo, Done after a save). */
  actions?: React.ReactNode;
  /**
   * The assistant's next line, in a bubble of its own under this one («في إشي
   * تاني؟ احكيلي.»). Part of the same message: read out with it, and its
   * paragraph test ids continue this one's.
   */
  tail?: string;
}
export interface ChatScheduleRow {
  id: string; title: string; subtitle?: string; icon?: ChatIconName;
  accessibilityLabel?: string; disabled?: boolean;
  selected?: boolean; selectionDisabled?: boolean;
  /** The importance tag, at the card's top end. */
  badge?: React.ReactNode;
  extra?: React.ReactNode;
}
export interface ChatScheduleGroup {
  id: string; title: string; subtitle?: string; rows: readonly ChatScheduleRow[];
}
export interface ChatQuickAction { id: string; label: string; icon?: ChatIconName; disabled?: boolean }
export interface SayItChatPageProps {
  colors: ChatColors;
  fonts: {
    regular: string; semibold: string; latin?: string; lineRatio: number;
    /**
     * The face for the person's own words — the draft, their message, a
     * proposal's titles — which may be in another alphabet than the UI's
     * (an English sentence in the Arabic composer). Absent, the UI's face.
     */
    forText?(text: string, weight: 'regular' | 'semibold'): { fontFamily: string; lineRatio: number };
  };
  copy: {
    title: string; subtitle: string; placeholder: string; closeLabel: string;
    moreLabel: string; pasteLabel: string; sendLabel: string; confirmLabel: string;
    /** Names a card's edit control: it opens that card's edit sheet. */
    editLabel: string;
    /** The visible word on each card's checkbox: «ينحفظ». */
    includeLabel: string;
    /** The proposal block's heading, counted: «الالتزامات المقترحة (2)». */
    proposalsTitle?: string;
    /** The listening panel's heading («عم بسمع…») and how it ends. */
    listeningTitle?: string; listeningNote?: string; cancelListeningLabel?: string;
  };
  text: string;
  onChangeText(text: string): void;
  onSend(): void;
  canSend: boolean;
  /** Everything that edits or leaves: the field, paste, ⋯ and back. */
  inputDisabled?: boolean;
  /** Only the field and paste — while a message is on its way, back still works. */
  composerDisabled?: boolean;
  onClose(): void;
  onMore(): void;
  onPaste(): void;
  outgoing?: ChatMessage;
  assistant?: ChatMessage;
  /** A short line under the opening message (the AI disclosure). */
  notice?: React.ReactNode;
  /** The conversation after the opening message, oldest first. */
  history?: readonly ChatHistoryEntry[];
  /**
   * The assistant is answering: shown as its bubble, with the host's own
   * reduced-motion-aware indicator, after the history.
   */
  typing?: React.ReactNode;
  /** What the typing bubble says to a screen reader. */
  typingLabel?: string;
  scheduleGroups?: readonly ChatScheduleGroup[];
  scheduleTime?: string;
  onConfirm?(): void;
  canConfirm?: boolean;
  confirming?: boolean;
  onRowPress?(id: string): void;
  onRowToggle?(id: string): void;
  followup?: ChatMessage;
  quickActions?: readonly ChatQuickAction[];
  onQuickAction?(id: string): void;
  microphone?: React.ReactNode;
  listening?: boolean;
  /** Ends a dictation and throws away what it heard (the listening panel's «إلغاء»). */
  onCancelListening?(): void;
  languageControl?: React.ReactNode;
  voiceNotice?: React.ReactNode;
  headerAccessory?: React.ReactNode;
  bodyOverride?: React.ReactNode;
  /** The one question's quick replies, under the reply that asks it. */
  clarification?: React.ReactNode;
  /** Real proposal disclosure, corrections, and clarification controls. */
  reviewExtras?: React.ReactNode;
  /** Under the save: the review tools, the suggestion note, cancel. */
  reviewFooter?: React.ReactNode;
  /**
   * The field takes focus each time this changes to a new non-zero value —
   * after a save in the chat, so the next commitment can be typed at once.
   */
  composerFocusKey?: number;
  /** A new proposal's identity; reveal its first question or first card. */
  revealConfirmKey?: string | null;
  /** Reduce motion: the reveal jumps instead of scrolling. */
  reduceMotion?: boolean;
  rtl?: boolean;
  safeTop?: number;
  safeBottom?: number;
  keyboardShown?: boolean;
  mode?: 'normal' | 'large' | 'xl';
}

/** The avatar column: a 32-point dot plus the gap to the bubble. */
const AVATAR_COLUMN = 42;

export function SayItChatPage({
  colors: p, fonts, copy, text, onChangeText, onSend, canSend, inputDisabled = false, composerDisabled = false, onClose, onMore, onPaste,
  outgoing, assistant, notice, history = [], typing, typingLabel, scheduleGroups = [], scheduleTime, onConfirm, canConfirm = false,
  confirming = false, onRowPress, onRowToggle, followup, quickActions = [], onQuickAction,
  microphone, listening = false, onCancelListening, languageControl, voiceNotice, headerAccessory, bodyOverride, clarification, reviewExtras, reviewFooter,
  rtl = false, safeTop = 0, safeBottom = 0, keyboardShown = false, mode = 'normal', composerFocusKey = 0,
  revealConfirmKey = null, reduceMotion = false,
}: SayItChatPageProps) {
  const input = React.useRef<TextInput>(null);
  React.useEffect(() => {
    if (composerFocusKey > 0) input.current?.focus();
  }, [composerFocusKey]);
  // Start a new proposal at its first decision. Scrolling to the final save
  // hid clarification and the first cards on long lists. Measurements are
  // keyed so the previous proposal cannot move this one.
  type Measured<T> = { key: string | null; value: T } | null;
  const scroller = React.useRef<ScrollView>(null);
  const keyRef = React.useRef<string | null>(revealConfirmKey);
  // Before any layout event of the new proposal is delivered.
  React.useLayoutEffect(() => { keyRef.current = revealConfirmKey; }, [revealConfirmKey]);
  const [viewport, setViewport] = React.useState(0);
  const [block, setBlock] = React.useState<Measured<number>>(null);
  const [question, setQuestion] = React.useState<Measured<number>>(null);
  const measured = <T,>(setter: React.Dispatch<React.SetStateAction<Measured<T>>>, value: T) =>
    setter({ key: keyRef.current, value });
  const revealed = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!revealConfirmKey || revealed.current === revealConfirmKey || viewport <= 0) return;
    const first = clarification ? question : block;
    if (first?.key !== revealConfirmKey) return;
    revealed.current = revealConfirmKey;
    if (first.value > viewport - 80) scroller.current?.scrollTo({ y: Math.max(0, first.value - 16), animated: !reduceMotion });
  }, [revealConfirmKey, viewport, block, question, clarification, reduceMotion]);
  const expanded = mode !== 'normal';
  const accessibilitySize = mode === 'xl';
  const composing = bodyOverride == null;
  const showSend = !listening && (microphone == null || !!text.trim().length);
  const textStyle = (size: number, weight: 'regular' | 'semibold' = 'regular', muted = false): TextStyle => ({
    fontFamily: fonts[weight], fontSize: size,
    lineHeight: Math.round(size * (fonts.lineRatio > 1.5 ? fonts.lineRatio : 1.4)),
    color: muted ? p.mu : p.tx,
    // The logical start: Fabric mirrors a Text's alignment under the RTL
    // layout on iOS and Android alike (see `textAlignment`).
    textAlign: textAlignment('start', rtl, Platform.OS),
    writingDirection: rtl ? 'rtl' : 'ltr',
  });
  /** `textStyle`, set in the face the words' own alphabet needs. */
  const contentStyle = (value: string, size: number, weight: 'regular' | 'semibold' = 'regular', muted = false): TextStyle => {
    const face = fonts.forText?.(value, weight);
    if (!face) return textStyle(size, weight, muted);
    return { ...textStyle(size, weight, muted), fontFamily: face.fontFamily,
      lineHeight: Math.round(size * (face.lineRatio > 1.5 ? face.lineRatio : 1.4)) };
  };
  const timestampStyle: TextStyle = {
    ...textStyle(12, 'regular', true), fontFamily: fonts.latin ?? fonts.regular,
    lineHeight: 16, writingDirection: 'ltr',
  };
  const header = (
    <View testID="chat-header" style={[styles.header, { paddingTop: safeTop + 6, borderBottomColor: p.ln, backgroundColor: p.bg }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerStart}>
          <IconButton label={copy.closeLabel} onPress={onClose} colors={p} icon="back" rtl={rtl} disabled={inputDisabled}
            testID={scheduleGroups.length ? 'review-back' : 'capture-cancel'} />
          <View style={styles.identity}>
            <BrandTile colors={p} latinFace={fonts.latin ?? fonts.semibold} />
            <View style={styles.titles}>
              {/* No "online" dot: nothing here is live presence. */}
              <Text accessibilityRole="header" style={[textStyle(16, 'semibold'), styles.flexShrink]}>{copy.title}</Text>
              <Text testID="chat-subtitle" style={[textStyle(13, 'regular', true), styles.flexShrink]}>{copy.subtitle}</Text>
            </View>
          </View>
        </View>
        <IconButton label={copy.moreLabel} onPress={onMore} colors={p} icon="more" testID="chat-more" disabled={inputDisabled} />
      </View>
      {headerAccessory}
    </View>
  );

  const avatar = <View style={[styles.avatar, { backgroundColor: p.sf2, borderColor: p.acs }]}
    accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={[styles.avatarDot, { backgroundColor: p.ac }]} />
  </View>;

  // A reply is read out as its own words (UAT 2026-09-30: a finished bubble
  // kept the typing bubble's «بنفهمها…»), and set in the face its alphabet
  // needs, as the person's own message is — an English reply in the Arabic
  // page is not Naskh's Latin.
  const message = (value: ChatMessage & Pick<ChatHistoryEntry, 'tone' | 'actions' | 'tail'>, testID: string, first = false) => {
    const paragraphs = value.text.split(/\n\n+/);
    const saved = value.tone === 'saved';
    return (
      <View testID={testID} accessible={value.actions == null} accessibilityLabel={value.tail ? `${value.text}\n\n${value.tail}` : value.text}
        style={[styles.assistantBlock, !first && styles.followup]}>
        <View style={styles.assistantRow}>
          {avatar}
          <View style={[styles.assistantColumn, expanded && styles.expandedColumn]}>
            <View style={[styles.assistantBubble, { backgroundColor: p.sf, borderColor: saved ? p.success : p.ln }, expanded && styles.expandedBubble]}>
              <View style={saved ? styles.savedRow : null}>
                {saved ? <ChatIcon name="checkCircle" size={22} color={p.success} /> : null}
                <View style={saved ? styles.savedWords : styles.words}>
                  {paragraphs.map((paragraph, index) => (
                    <Text key={index} testID={`${testID}-text-${index}`}
                      style={contentStyle(paragraph, 15, saved && index === 0 ? 'semibold' : 'regular')}>{paragraph}</Text>
                  ))}
                </View>
              </View>
              {value.actions ? <View testID={`${testID}-actions`} style={[styles.bubbleActions, { borderTopColor: p.ln }]}>{value.actions}</View> : null}
            </View>
            {value.tail ? <View style={[styles.assistantBubble, styles.tailBubble, { backgroundColor: p.sf, borderColor: p.ln }]}>
              <Text testID={`${testID}-text-${paragraphs.length}`} style={contentStyle(value.tail, 15)}>{value.tail}</Text>
            </View> : null}
          </View>
        </View>
        {value.time ? <Text style={[timestampStyle, styles.incomingTime]}>{value.time}</Text> : null}
      </View>
    );
  };

  /** The newest turn, when it is the assistant's reply: it is the one announced. */
  const newestReply = !typing && history.length > 0 && history[history.length - 1]!.role === 'assistant' ? history.length - 1 : -1;

  /** The person's own message: a bubble on the end side, with its time and ✓✓. */
  const mine = (value: ChatMessage, testID: string, textTestID: string) => (
    <View testID={testID} style={styles.outgoingBlock}>
      <View style={[styles.outgoingBubble, { backgroundColor: p.acs, borderColor: p.ul ?? p.lnStrong }, expanded && styles.expandedOutgoing]}>
        <Text testID={textTestID} style={contentStyle(value.text, 15)}>{value.text}</Text>
      </View>
      {value.time || value.delivered ? <View style={styles.outgoingTime}>
        {value.time ? <Text style={timestampStyle}>{value.time}</Text> : null}
        {value.delivered ? <ChatIcon name="checks" size={14} color={p.ac} /> : null}
      </View> : null}
    </View>
  );

  return (
    <View testID="say-it-chat-page" style={[styles.page, { backgroundColor: p.bg }]}>
      {!accessibilitySize && header}
      <ScrollView ref={scroller} testID={scheduleGroups.length ? 'review-scroll' : 'capture-scroll'} style={styles.scroller}
        onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        contentContainerStyle={styles.conversation}>
        {accessibilitySize && <View style={styles.scrollHeader}>{header}</View>}
        {composing ? <>
          {outgoing ? mine(outgoing, 'chat-outgoing', 'chat-outgoing-text') : null}
          {assistant && message(assistant, 'chat-assistant', true)}
          {notice ? <View testID="chat-notice" style={styles.notice}>{notice}</View> : null}
          {history.map((entry, index) => index === newestReply ? null : entry.role === 'user'
            ? <View key={index} style={styles.laterTurn}>{mine(entry, `chat-turn-user-${index}`, `chat-turn-text-${index}`)}</View>
            : <React.Fragment key={index}>{message(entry, entry.id ?? `chat-turn-assistant-${index}`)}</React.Fragment>)}
          {/* Always mounted, so TalkBack hears what changes inside it: the
              typing bubble while a message is on its way, then the reply that
              replaces it (review I1; the census in liveRegion.test). */}
          <View testID="chat-live" accessibilityLiveRegion="polite">
            {/* Keyed apart, so the reply is a view of its own and never the
                typing bubble's native view with its label left on it. */}
            {typing ? <View key="typing" testID="chat-typing" style={[styles.assistantBlock, styles.followup]}
              accessible accessibilityLabel={typingLabel}>
              <View style={styles.assistantRow}>
                {avatar}
                <View style={[styles.assistantBubble, styles.typingBubble, { backgroundColor: p.sf, borderColor: p.ln }]}>{typing}</View>
              </View>
            </View> : newestReply >= 0
              ? <React.Fragment key={`reply-${newestReply}`}>{message(history[newestReply]!, history[newestReply]!.id ?? `chat-turn-assistant-${newestReply}`)}</React.Fragment>
              : null}
          </View>
          {clarification ? <View testID="chat-clarification" onLayout={(event) => measured(setQuestion, event.nativeEvent.layout.y)} style={[styles.clarification, expanded && styles.expandedSchedule]}>{clarification}</View> : null}
          {scheduleGroups.length > 0 ? <View testID="chat-schedule" style={[styles.scheduleBlock, expanded && styles.expandedSchedule]}
            onLayout={(event) => measured(setBlock, event.nativeEvent.layout.y)}>
            <View style={[styles.scheduleCard, { backgroundColor: p.sf, borderColor: p.ln }]}
              testID="chat-schedule-card">
              {copy.proposalsTitle ? <View style={[styles.blockTitle, { borderBottomColor: p.ln }]}>
                <ChatIcon name="calendar" size={20} color={p.wm ?? p.tx} />
                <Text testID="review-proposals-title" accessibilityRole="header"
                  style={[textStyle(15, 'semibold'), styles.flexShrink, { color: p.wm ?? p.tx }]}>{copy.proposalsTitle}</Text>
              </View> : null}
              {scheduleGroups.map((group) => <View key={group.id} style={styles.group}>
                {/* The day the cards below are on. With one card it still
                    says the day: the card's own line says only the time. */}
                {group.title ? <Text testID={`review-group-${group.id}`} style={[textStyle(13, 'semibold', true), styles.groupTitle]}>
                  {group.title}{group.subtitle ? <Text style={{ fontFamily: fonts.regular }}> · {group.subtitle}</Text> : null}
                </Text> : null}
                {group.rows.map((row) => {
                  const excluded = row.selected === false;
                  return <View key={row.id} testID={`review-card-${row.id}`} style={[styles.itemCard, { backgroundColor: p.sf2, borderColor: p.ln }]}>
                    <View testID={`chat-schedule-row-${row.id}`} style={styles.itemTop}>
                      <View style={[styles.rowIcon, { backgroundColor: excluded ? p.sf : (p.iconBg ?? p.acs) }]}>
                        <ChatIcon name={row.icon ?? 'calendar'} size={22} color={excluded ? p.mu : p.ac} />
                      </View>
                      <View style={styles.rowWords}>
                        <Text testID={`review-title-${row.id}`} style={contentStyle(row.title, 15, 'semibold', excluded)}>{row.title}</Text>
                        {row.subtitle ? <View style={styles.whenRow}>
                          <ChatIcon name="clock" size={15} color={p.mu} />
                          <Text testID={`review-when-${row.id}`} style={[textStyle(13, 'regular', true), styles.flexShrink]}>{row.subtitle}</Text>
                        </View> : null}
                      </View>
                      {row.badge ? <View style={styles.badge}>{row.badge}</View> : null}
                    </View>
                    {row.extra ? <View style={styles.rowExtra}>{row.extra}</View> : null}
                    {onRowPress || (onRowToggle && typeof row.selected === 'boolean') ? <View style={[styles.itemActions, { borderTopColor: p.ln }]}>
                      {onRowPress ? <Pressable testID={`review-edit-${row.id}`} accessibilityRole="button"
                        accessibilityLabel={`${copy.editLabel}: ${row.title}`}
                        accessibilityState={{ disabled: !!row.disabled }} disabled={row.disabled}
                        onPress={() => onRowPress(row.id)}
                        style={({ pressed }) => [styles.itemAction, pressed && { backgroundColor: p.sf }]}>
                        <ChatIcon name="edit" size={18} color={row.disabled ? p.mu : p.tx} />
                        <Text style={[textStyle(13, 'semibold'), row.disabled && { color: p.mu }]}>{copy.editLabel}</Text>
                      </Pressable> : <View />}
                      {/* «ينحفظ»: a positive checkbox. Selection is never colour
                          alone — the box carries a check when the card will be
                          saved and is empty when it will not. */}
                      {onRowToggle && typeof row.selected === 'boolean' ? <Pressable testID={`review-item-${row.id}`}
                        accessibilityRole="checkbox" accessibilityLabel={row.accessibilityLabel ?? row.title}
                        accessibilityState={{ checked: row.selected, disabled: !!row.selectionDisabled }}
                        disabled={row.selectionDisabled} onPress={() => onRowToggle(row.id)}
                        style={({ pressed }) => [styles.itemAction, styles.checkboxAction, pressed && { backgroundColor: p.sf }]}>
                        <View testID={`review-check-${row.id}`} style={[styles.checkBox, row.selected
                          ? { backgroundColor: row.selectionDisabled ? p.mu : p.ac, borderColor: row.selectionDisabled ? p.mu : p.ac }
                          : { backgroundColor: 'transparent', borderColor: row.selectionDisabled ? p.mu : p.lnStrong }]}>
                          {row.selected ? <ChatIcon name="check" size={14} color={p.onAccent} /> : null}
                        </View>
                        <Text style={[textStyle(13, 'semibold'), row.selectionDisabled && { color: p.mu }]}>{copy.includeLabel}</Text>
                      </Pressable> : null}
                    </View> : null}
                  </View>;
                })}
              </View>)}
              {reviewExtras ? <View testID="chat-review-extras" style={styles.reviewExtras}>{reviewExtras}</View> : null}
              {onConfirm ? <View testID="chat-add-schedule"><Pressable testID="review-confirm" accessibilityRole="button" accessibilityLabel={copy.confirmLabel}
                accessibilityState={{ disabled: !canConfirm || confirming, busy: confirming }}
                disabled={!canConfirm || confirming} onPress={onConfirm}
                style={({ pressed }) => [styles.confirm, {
                  backgroundColor: !canConfirm || confirming ? p.dis : pressed ? p.acd : p.ac,
                }]}>
                {confirming ? <ActivityIndicator color={p.disTx} /> : <ChatIcon name="checkCircle" size={20} color={canConfirm ? p.onAccent : p.disTx} />}
                <Text style={[textStyle(16, 'semibold'), styles.flexShrink, styles.center,
                  { color: !canConfirm || confirming ? p.disTx : p.onAccent }]}>{copy.confirmLabel}</Text>
              </Pressable></View> : null}
              {reviewFooter ? <View testID="chat-review-footer" style={styles.reviewFooter}>{reviewFooter}</View> : null}
            </View>
            {scheduleTime ? <Text style={[timestampStyle, styles.scheduleTime]}>{scheduleTime}</Text> : null}
          </View> : reviewExtras || reviewFooter ? <View style={[styles.reviewExtras, styles.looseExtras]}>{reviewExtras}{reviewFooter}</View> : null}
          {followup && message(followup, 'chat-followup')}
          {accessibilitySize && languageControl ? <View style={[styles.languageRow, styles.scrollLanguage]}>{languageControl}</View> : null}
        </> : bodyOverride}
      </ScrollView>
      {composing && <View testID="chat-composer" style={[styles.composer, {
        backgroundColor: p.bg, borderTopColor: p.ln, paddingBottom: keyboardShown ? 8 : Math.max(safeBottom, 12),
      }]}>
        {quickActions.length > 0 ? <ScrollView horizontal testID="chat-quick-actions" showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled" contentContainerStyle={styles.quickActions} style={styles.quickScroller}>
          {quickActions.map(action => <Pressable key={action.id} testID={`chat-quick-${action.id}`}
            accessibilityRole="button" accessibilityLabel={action.label} accessibilityState={{ disabled: !!action.disabled }}
            disabled={action.disabled || !onQuickAction} onPress={() => onQuickAction?.(action.id)}
            style={({ pressed }) => [styles.quickAction, { borderColor: p.lnStrong, backgroundColor: pressed ? p.sf : p.sf2 }]}>
            {action.icon ? <ChatIcon name={action.icon} size={18} color={action.disabled ? p.mu : (p.wm ?? p.ac)} /> : null}
            <Text style={[textStyle(13), action.disabled && { color: p.mu }]}>{action.label}</Text>
          </Pressable>)}
        </ScrollView> : null}
        {listening && copy.listeningTitle ? <View testID="voice-listening-panel"
          style={[styles.listeningPanel, { backgroundColor: p.sf, borderColor: p.ul ?? p.lnStrong }]}>
          <View style={styles.listeningWords}>
            <Text testID="voice-listening-title" style={textStyle(15, 'semibold')}>{copy.listeningTitle}</Text>
            {copy.listeningNote ? <Text testID="voice-listening-note" style={textStyle(13, 'regular', true)}>{copy.listeningNote}</Text> : null}
          </View>
          {onCancelListening && copy.cancelListeningLabel ? <Pressable testID="voice-cancel" accessibilityRole="button"
            accessibilityLabel={copy.cancelListeningLabel} onPress={onCancelListening}
            style={({ pressed }) => [styles.listeningCancel, { backgroundColor: pressed ? p.sf : p.sf2 }]}>
            <ChatIcon name="close" size={18} color={p.tx} />
            <Text style={textStyle(13, 'semibold')}>{copy.cancelListeningLabel}</Text>
          </Pressable> : null}
        </View> : null}
        {voiceNotice}
        <View testID="chat-composer-row" style={styles.composerRow}>
          {/* A clipboard, not "+": the control pastes, and «الصق» says so (u27). */}
          <IconButton label={copy.pasteLabel} onPress={onPaste} colors={p} icon="paste" testID="capture-paste" disabled={inputDisabled || composerDisabled} />
          <TextInput ref={input} testID="capture-input" value={text} onChangeText={onChangeText} multiline scrollEnabled
            editable={!inputDisabled && !composerDisabled} accessibilityState={{ disabled: inputDisabled || composerDisabled }}
            accessibilityLabel={copy.placeholder} placeholder={copy.placeholder} placeholderTextColor={p.mu}
            style={[styles.input, contentStyle(text, 15, 'regular', true), {
              color: p.tx, backgroundColor: p.sf, borderColor: p.lnStrong, textAlign: rtl ? 'right' : 'left',
              maxHeight: accessibilitySize ? 160 : 120,
            }]} />
          {showSend ? <Pressable testID="capture-analyze" accessibilityRole="button"
            accessibilityLabel={copy.sendLabel} accessibilityState={{ disabled: !canSend }} disabled={!canSend}
            onPress={onSend} style={({ pressed }) => [styles.send, {
              backgroundColor: !canSend ? p.dis : pressed ? p.sf : p.sf2,
            }]}>
            <ChatIcon name="send" size={20} color={canSend ? p.ac : p.disTx} rtl={rtl} />
          </Pressable> : null}
          {/* Dictation remains available after typing. Keep its controller
              mounted as partial transcripts change the draft and Send appears:
              it is always the row's last child, so nothing before it shifts
              its place. */}
          {microphone != null && <View>{microphone}</View>}
        </View>
        {!accessibilitySize && languageControl ? <View style={styles.languageRow}>{languageControl}</View> : null}
      </View>}
    </View>
  );
}

/** The MaybeSitter mark in the header: a coral tile with its initial. Decorative. */
function BrandTile({ colors: p, latinFace }: { colors: ChatColors; latinFace: string }) {
  return <View style={[styles.brandTile, { backgroundColor: p.ac }]}
    accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Text style={{ color: p.onAccent, fontFamily: latinFace, fontSize: 16, lineHeight: 20, fontWeight: '700', textAlign: 'center' }}>M</Text>
  </View>;
}

function IconButton({ colors: p, label, onPress, icon, rtl = false, testID, disabled = false }: {
  colors: ChatColors; label: string; onPress(): void; icon: ChatIconName; rtl?: boolean; testID?: string; disabled?: boolean;
}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    disabled={disabled} accessibilityState={{ disabled }}
    style={({ pressed }) => [styles.circle, { backgroundColor: pressed ? p.sf2 : p.sf }]}>
    <ChatIcon name={icon} color={disabled ? p.mu : p.tx} size={22} rtl={rtl} />
  </Pressable>;
}

export function ChatMicrophone({ colors: p, label, onPress, listening = false, busy = false }: {
  colors: ChatColors; label: string; onPress(): void; listening?: boolean; busy?: boolean;
}) {
  return <View style={styles.micWrap}>
    {/* The pulse says the microphone is open; it stops under reduce-motion. */}
    {listening ? <Rings color={p.ac} size={48} /> : null}
    <Pressable testID="voice-button" accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ busy }} onPress={onPress}
      style={({ pressed }) => [styles.mic, { backgroundColor: pressed ? p.acd : p.ac }]}>
      {listening ? <View testID="voice-stop-glyph" style={[styles.stopGlyph, { backgroundColor: p.onAccent }]} /> : <ChatIcon name="microphone" size={24} color={p.onAccent} />}
    </Pressable>
  </View>;
}

export function ChatLanguage({ colors: p, label, accessibilityLabel, fontFamily, onPress }: {
  colors: ChatColors; label: string; accessibilityLabel: string; fontFamily: string; onPress(): void;
}) {
  return <Pressable testID="voice-language" accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.language, { backgroundColor: pressed ? p.sf2 : p.sf, borderColor: p.ln }]}>
    <ChatIcon name="globe" size={16} color={p.tx} />
    <Text style={{ color: p.tx, fontFamily, fontSize: 13, lineHeight: 20, textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}

export function ChatIcon({ name, color, size = 20, rtl = false }: {
  name: ChatIconName; color: string; size?: number; rtl?: boolean;
}) {
  const stroke = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  let glyph: React.ReactNode;
  switch (name) {
    // An arrow that points the way back: right in a right-to-left page.
    case 'back': glyph = <Path d={rtl ? 'M4 12h16M14 6l6 6-6 6' : 'M20 12H4M10 6l-6 6 6 6'} {...stroke} />; break;
    case 'more': glyph = <><Circle cx={12} cy={5} r={1.7} fill={color} /><Circle cx={12} cy={12} r={1.7} fill={color} /><Circle cx={12} cy={19} r={1.7} fill={color} /></>; break;
    case 'plus': glyph = <Path d="M12 5v14M5 12h14" {...stroke} />; break;
    case 'check': glyph = <Path d="M5 12l4 4L19 6" {...stroke} strokeWidth={2.4} />; break;
    case 'checks': glyph = <><Path d="M2 13l4 4L16 6M10 17L21 6" {...stroke} /></>; break;
    case 'checkCircle': glyph = <><Circle cx={12} cy={12} r={9} {...stroke} /><Path d="M8 12.5l2.8 2.8L16.5 9.5" {...stroke} /></>; break;
    case 'microphone': glyph = <><Rect x={8} y={2} width={8} height={13} rx={4} fill={color} /><Path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6" {...stroke} /></>; break;
    case 'send': glyph = <Path d={rtl ? 'M21 3L2 12l19 9-5-9 5-9ZM16 12H2' : 'M3 3l19 9-19 9 5-9-5-9ZM8 12h14'} {...stroke} />; break;
    case 'calendar': glyph = <><Rect x={3} y={5} width={18} height={17} rx={2} {...stroke} /><Path d="M7 2v5M17 2v5M3 10h18" {...stroke} /><Rect x={7} y={13} width={3} height={3} rx={0.5} fill={color} /><Circle cx={15} cy={14.5} r={1} fill={color} /></>; break;
    case 'doctor': glyph = <><Path d="M5 3H3v5a6 6 0 0 0 12 0V3h-2M9 14v2a5 5 0 0 0 10 0v-2" {...stroke} /><Circle cx={19} cy={11} r={2.3} {...stroke} /><Path d="M5 2v3M13 2v3" {...stroke} /></>; break;
    case 'briefcase': glyph = <><Rect x={3} y={7} width={18} height={14} rx={2} {...stroke} /><Path d="M8 7V4h8v3M3 12c5 3 13 3 18 0M10 12h4v4h-4z" {...stroke} /></>; break;
    case 'car': glyph = <><Path d="M4 10l2-6h12l2 6M3 11h18v8H3zM5 19v2M19 19v2" {...stroke} /><Circle cx={6.5} cy={14.5} r={1.4} fill={color} /><Circle cx={17.5} cy={14.5} r={1.4} fill={color} /></>; break;
    case 'pin': glyph = <><Path d="M15 2l7 7-3 1-4 4 1 3-3 3-9-9 3-3 3 1 4-4 1-3Z" fill={color} /><Path d="M8 16l-6 6" {...stroke} /></>; break;
    case 'clock': glyph = <><Circle cx={12} cy={12} r={9} {...stroke} /><Path d="M12 7v5l3 2" {...stroke} /></>; break;
    case 'globe': glyph = <><Circle cx={12} cy={12} r={10} {...stroke} /><Path d="M2 12h20M4 6h16M4 18h16M12 2c-6 5-6 15 0 20 6-5 6-15 0-20Z" {...stroke} /></>; break;
    case 'copy': glyph = <><Rect x={8} y={8} width={13} height={13} rx={2} {...stroke} /><Path d="M16 8V3H3v13h5" {...stroke} /></>; break;
    case 'paste': glyph = <><Rect x={5} y={4} width={14} height={18} rx={2} {...stroke} /><Rect x={9} y={2} width={6} height={4} rx={1} {...stroke} /><Path d="M9 11h6M9 15h4" {...stroke} /></>; break;
    case 'edit': glyph = <Path d="M4 16l-1 5 5-1L21 7l-4-4L4 16ZM14 6l4 4" {...stroke} />; break;
    case 'warning': glyph = <><Path d="M12 3L2 20h20L12 3Z" {...stroke} /><Path d="M12 10v4" {...stroke} /><Circle cx={12} cy={17} r={1.1} fill={color} /></>; break;
    case 'close': glyph = <Path d="M6 6l12 12M18 6L6 18" {...stroke} />; break;
    case 'info': glyph = <><Circle cx={12} cy={12} r={9} {...stroke} /><Path d="M12 11v6" {...stroke} /><Circle cx={12} cy={7.6} r={1.1} fill={color} /></>; break;
  }
  return <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>{glyph}</Svg>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, gap: 12 },
  headerStart: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  brandTile: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  titles: { alignItems: 'flex-start', flexShrink: 1 },
  scroller: { flex: 1 },
  conversation: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16 },
  scrollHeader: { marginHorizontal: -16, marginTop: -16, marginBottom: 12 },
  outgoingBlock: { alignItems: 'flex-end' },
  outgoingBubble: { maxWidth: '85%', borderRadius: 16, borderTopEndRadius: 4, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12 },
  expandedOutgoing: { maxWidth: '100%' },
  outgoingTime: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingEnd: 4 },
  assistantBlock: { marginTop: 0 },
  assistantRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  avatar: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  avatarDot: { width: 10, height: 10, borderRadius: 5 },
  assistantColumn: { flexShrink: 1, maxWidth: '88%', alignItems: 'flex-start', gap: 8 },
  expandedColumn: { flex: 1, maxWidth: '100%' },
  assistantBubble: { flexShrink: 1, borderRadius: 16, borderTopStartRadius: 4, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
  tailBubble: { alignSelf: 'flex-start' },
  expandedBubble: { alignSelf: 'stretch' },
  words: { gap: 6 },
  savedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  savedWords: { flexShrink: 1, gap: 6 },
  bubbleActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  incomingTime: { marginStart: AVATAR_COLUMN, marginTop: 4 },
  clarification: { marginStart: AVATAR_COLUMN, marginTop: 12 },
  scheduleBlock: { marginTop: 12 },
  expandedSchedule: { marginStart: 0 },
  scheduleCard: { borderWidth: 1, borderRadius: 20, padding: 16, gap: 12 },
  blockTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  group: { gap: 10 },
  groupTitle: { paddingHorizontal: 2 },
  itemCard: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 4, gap: 10 },
  itemTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowWords: { flex: 1, alignItems: 'flex-start', gap: 2 },
  whenRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  badge: { alignItems: 'flex-end', gap: 4, flexShrink: 0, maxWidth: '40%' },
  rowExtra: { gap: 6, alignItems: 'stretch' },
  itemActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 2, borderTopWidth: StyleSheet.hairlineWidth },
  itemAction: { minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 12 },
  checkboxAction: { gap: 10 },
  checkBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  reviewExtras: { gap: 8 },
  looseExtras: { marginTop: 12 },
  reviewFooter: { gap: 4, alignItems: 'stretch' },
  confirm: { minHeight: 52, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  scheduleTime: { marginTop: 4, paddingStart: 2 },
  followup: { marginTop: 16 },
  laterTurn: { marginTop: 16 },
  notice: { marginTop: 4, marginStart: AVATAR_COLUMN },
  typingBubble: { minHeight: 44, justifyContent: 'center' },
  quickScroller: { marginHorizontal: -16, flexGrow: 0, flexShrink: 0 },
  quickActions: { paddingHorizontal: 16, paddingVertical: 2, gap: 8, alignItems: 'center' },
  quickAction: { minHeight: 44, paddingVertical: 8, paddingHorizontal: 16, borderWidth: 1, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 6 },
  listeningPanel: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 16, padding: 12 },
  listeningWords: { flex: 1, alignItems: 'flex-start', gap: 2 },
  listeningCancel: { minHeight: 44, minWidth: 44, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingHorizontal: 16, gap: 10 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 24, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  micWrap: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  mic: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  languageRow: { alignItems: 'flex-start' },
  scrollLanguage: { marginTop: 12 },
  language: { minHeight: 32, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  stopGlyph: { width: 16, height: 16, borderRadius: 3 },
  flexShrink: { flexShrink: 1 },
  center: { textAlign: 'center' },
});
