import React from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextStyle,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { textAlignment } from '../../ui/primitives';

/** An independent native presentation. The host owns all messages, proposals,
 * permissions, keyboard avoidance, localization, and every state change. */
export interface ChatColors {
  bg: string; sf: string; sf2: string; tx: string; mu: string;
  ln: string; lnStrong: string; ac: string; acd: string; acs: string;
  onAccent: string; dis: string; disTx: string; success: string;
  iconBg?: string;
}
export type ChatIconName = 'calendar' | 'doctor' | 'briefcase' | 'car' | 'pin' | 'clock'
  | 'plus' | 'back' | 'more' | 'check' | 'checks' | 'microphone' | 'send' | 'globe' | 'copy' | 'paste' | 'edit';
export interface ChatMessage { text: string; time?: string; delivered?: boolean }
/** One line of the conversation, in order: the person's (`user`) or the assistant's. */
export interface ChatHistoryEntry extends ChatMessage { role: 'user' | 'assistant' }
export interface ChatScheduleRow {
  id: string; title: string; subtitle?: string; icon?: ChatIconName;
  accessibilityLabel?: string; disabled?: boolean;
  selected?: boolean; selectionDisabled?: boolean; extra?: React.ReactNode;
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
    /** Names a row's "…" control: it opens that row's edit sheet. */
    editLabel: string;
    /** The text tag on a row the person has taken out of the proposal. */
    notIncludedLabel: string;
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
  languageControl?: React.ReactNode;
  voiceNotice?: React.ReactNode;
  headerAccessory?: React.ReactNode;
  bodyOverride?: React.ReactNode;
  /** Real proposal disclosure, corrections, and clarification controls. */
  reviewExtras?: React.ReactNode;
  rtl?: boolean;
  safeTop?: number;
  safeBottom?: number;
  keyboardShown?: boolean;
  mode?: 'normal' | 'large' | 'xl';
}

export function SayItChatPage({
  colors: p, fonts, copy, text, onChangeText, onSend, canSend, inputDisabled = false, composerDisabled = false, onClose, onMore, onPaste,
  outgoing, assistant, notice, history = [], typing, typingLabel, scheduleGroups = [], scheduleTime, onConfirm, canConfirm = false,
  confirming = false, onRowPress, onRowToggle, followup, quickActions = [], onQuickAction,
  microphone, listening = false, languageControl, voiceNotice, headerAccessory, bodyOverride, reviewExtras,
  rtl = false, safeTop = 0, safeBottom = 0, keyboardShown = false, mode = 'normal',
}: SayItChatPageProps) {
  const expanded = mode !== 'normal';
  const accessibilitySize = mode === 'xl';
  const composing = bodyOverride == null;
  const showSend = !listening && (microphone == null || !!text.trim().length);
  const textStyle = (size: number, weight: 'regular' | 'semibold' = 'regular', muted = false): TextStyle => ({
    fontFamily: fonts[weight], fontSize: size,
    lineHeight: Math.round(size * (fonts.lineRatio > 1.5 ? fonts.lineRatio : 1.3)),
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
      lineHeight: Math.round(size * (face.lineRatio > 1.5 ? face.lineRatio : 1.3)) };
  };
  const timestampStyle: TextStyle = {
    ...textStyle(9.5, 'regular', true), fontFamily: fonts.latin ?? fonts.regular,
    lineHeight: 14, writingDirection: 'ltr',
  };
  const header = (
    <View testID="chat-header" style={[styles.header, { paddingTop: safeTop + 4, borderBottomColor: p.ln }]}>
      <View style={styles.headerRow}>
        <IconButton label={copy.closeLabel} onPress={onClose} colors={p} icon="back" rtl={rtl} disabled={inputDisabled}
          testID={scheduleGroups.length ? 'review-back' : 'capture-cancel'} />
        <View style={styles.identity}>
          <View style={styles.titleRow}>
            <ChatRibbon colors={p} size={24} />
            <Text accessibilityRole="header" style={[textStyle(16, 'semibold', true), styles.flexShrink]}>{copy.title}</Text>
          </View>
          {/* No "online" dot: nothing here is live presence. */}
          <View style={styles.subtitleRow}>
            <Text testID="chat-subtitle" style={[textStyle(10.5, 'regular', true), styles.flexShrink]}>{copy.subtitle}</Text>
          </View>
        </View>
        <IconButton label={copy.moreLabel} onPress={onMore} colors={p} icon="more" testID="chat-more" disabled={inputDisabled} />
      </View>
      {headerAccessory}
    </View>
  );

  const message = (value: ChatMessage, testID: string, first = false) => (
    <View testID={testID} style={[styles.assistantBlock, !first && styles.followup]}>
      <View style={styles.assistantRow}>
        <View style={[styles.avatar, { borderColor: p.lnStrong }]}><ChatRibbon colors={p} size={20} /></View>
        <View style={[styles.assistantBubble, first && styles.firstAssistantBubble, { backgroundColor: p.sf }, expanded && styles.expandedBubble]}>
          {value.text.split(/\n\n+/).map((paragraph, index) => (
            <Text key={index} style={textStyle(13.5)}>{paragraph}</Text>
          ))}
        </View>
      </View>
      {value.time ? <Text style={[timestampStyle, styles.incomingTime]}>{value.time}</Text> : null}
    </View>
  );

  /** The newest turn, when it is the assistant's reply: it is the one announced. */
  const newestReply = !typing && history.length > 0 && history[history.length - 1]!.role === 'assistant' ? history.length - 1 : -1;

  /** The person's own message: a bubble on the end side, with its time and ✓✓. */
  const mine = (value: ChatMessage, testID: string, textTestID: string) => (
    <View testID={testID} style={styles.outgoingBlock}>
      <View style={[styles.outgoingBubble, { backgroundColor: p.acs, borderColor: p.ac }, expanded && styles.expandedOutgoing]}>
        <Text testID={textTestID} style={contentStyle(value.text, 13.3)}>{value.text}</Text>
      </View>
      {value.time || value.delivered ? <View style={styles.outgoingTime}>
        {value.time ? <Text style={timestampStyle}>{value.time}</Text> : null}
        {value.delivered ? <ChatIcon name="checks" size={13} color={p.ac} /> : null}
      </View> : null}
    </View>
  );

  return (
    <View testID="say-it-chat-page" style={[styles.page, { backgroundColor: p.bg }]}>
      {!accessibilitySize && header}
      <ScrollView testID={scheduleGroups.length ? 'review-scroll' : 'capture-scroll'} style={styles.scroller}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        contentContainerStyle={styles.conversation}>
        {accessibilitySize && <View style={styles.scrollHeader}>{header}</View>}
        {composing ? <>
          {outgoing ? mine(outgoing, 'chat-outgoing', 'chat-outgoing-text') : null}
          {assistant && message(assistant, 'chat-assistant', true)}
          {notice ? <View testID="chat-notice" style={styles.notice}>{notice}</View> : null}
          {history.map((entry, index) => index === newestReply ? null : entry.role === 'user'
            ? <View key={index} style={styles.laterTurn}>{mine(entry, `chat-turn-user-${index}`, `chat-turn-text-${index}`)}</View>
            : <React.Fragment key={index}>{message(entry, `chat-turn-assistant-${index}`)}</React.Fragment>)}
          {/* Always mounted, so TalkBack hears what changes inside it: the
              typing bubble while a message is on its way, then the reply that
              replaces it (review I1; the census in liveRegion.test). */}
          <View testID="chat-live" accessibilityLiveRegion="polite">
            {typing ? <View testID="chat-typing" style={[styles.assistantBlock, styles.followup]}
              accessible accessibilityLabel={typingLabel}>
              <View style={styles.assistantRow}>
                <View style={[styles.avatar, { borderColor: p.lnStrong }]}><ChatRibbon colors={p} size={20} /></View>
                <View style={[styles.assistantBubble, styles.typingBubble, { backgroundColor: p.sf }]}>{typing}</View>
              </View>
            </View> : newestReply >= 0 ? message(history[newestReply]!, `chat-turn-assistant-${newestReply}`) : null}
          </View>
          {scheduleGroups.length > 0 ? <View testID="chat-schedule" style={[styles.scheduleBlock, expanded && styles.expandedSchedule]}>
            <View style={[styles.scheduleCard, { backgroundColor: p.bg, borderColor: p.lnStrong }]}>
              {scheduleGroups.map((group, groupIndex) => <View key={group.id} style={groupIndex > 0 && styles.nextGroup}>
                <View style={styles.dateRow}>
                  <ChatIcon name="calendar" size={20} color={p.ac} />
                  <Text style={[textStyle(13, 'semibold'), styles.flexShrink]}>
                    {group.title}{group.subtitle ? <Text style={{ fontFamily: fonts.regular }}> · {group.subtitle}</Text> : null}
                  </Text>
                </View>
                <View style={[styles.scheduleRows, { backgroundColor: p.sf, borderColor: p.ln }]}>
                  {group.rows.map((row, index) => {
                    const rowContent = <>
                      <View style={[styles.rowIcon, { backgroundColor: row.selected === false ? p.sf2 : (p.iconBg ?? p.acs) }]}>
                        <ChatIcon name={row.icon ?? 'calendar'} size={20} color={row.selected === false ? p.mu : p.ac} />
                        {/* Selection is never colour alone: a check when in, an
                            empty ring plus a text tag when out. */}
                        {typeof row.selected === 'boolean' ? <View testID={`review-check-${row.id}`} style={[styles.checkMark, row.selected
                          ? { backgroundColor: p.ac, borderColor: p.bg }
                          : { backgroundColor: p.bg, borderColor: p.mu }]}>
                          {row.selected ? <ChatIcon name="check" size={9} color={p.onAccent} /> : null}
                        </View> : null}
                      </View>
                      <View style={styles.rowWords}>
                        <Text testID={`review-title-${row.id}`} style={contentStyle(row.title, 13, 'regular', row.selected === false)}>{row.title}</Text>
                        {row.subtitle ? <Text testID={`review-when-${row.id}`} style={textStyle(11, 'regular', true)}>{row.subtitle}</Text> : null}
                        {row.selected === false ? <Text testID={`review-not-included-${row.id}`}
                          style={[textStyle(10.5, 'semibold', true), styles.notIncluded, { borderColor: p.lnStrong }]}>{copy.notIncludedLabel}</Text> : null}
                      </View>
                    </>;
                    return <View key={row.id} testID={`review-card-${row.id}`}>
                    {index > 0 && <View style={[styles.rowDivider, { backgroundColor: p.ln }]} />}
                    <View testID={`chat-schedule-row-${row.id}`} style={styles.scheduleRow}>
                      {onRowToggle && typeof row.selected === 'boolean' ? <Pressable testID={`review-item-${row.id}`}
                        accessibilityRole="checkbox" accessibilityLabel={row.accessibilityLabel ?? row.title}
                        accessibilityState={{ checked: row.selected, disabled: !!row.selectionDisabled }}
                        disabled={row.selectionDisabled} onPress={() => onRowToggle(row.id)} hitSlop={5} style={styles.rowMain}>
                        {rowContent}
                      </Pressable> : <View style={styles.rowMain}>{rowContent}</View>}
                      {onRowPress ? <Pressable testID={`review-edit-${row.id}`} accessibilityRole="button"
                        accessibilityLabel={`${copy.editLabel}: ${row.title}`}
                        accessibilityState={{ disabled: !!row.disabled }} disabled={row.disabled}
                        onPress={() => onRowPress(row.id)} hitSlop={10} style={styles.rowMore}>
                        <ChatIcon name="more" size={14} color={p.mu} />
                      </Pressable> : null}
                    </View>
                    {row.extra ? <View style={styles.rowExtra}>{row.extra}</View> : null}
                  </View>;
                  })}
                </View>
              </View>)}
              {reviewExtras ? <View testID="chat-review-extras" style={styles.reviewExtras}>{reviewExtras}</View> : null}
              {onConfirm ? <View testID="chat-add-schedule"><Pressable testID="review-confirm" accessibilityRole="button" accessibilityLabel={copy.confirmLabel}
                accessibilityState={{ disabled: !canConfirm || confirming, busy: confirming }}
                disabled={!canConfirm || confirming} onPress={onConfirm} hitSlop={6}
                style={({ pressed }) => [styles.confirm, {
                  backgroundColor: !canConfirm || confirming ? p.dis : pressed ? p.acd : p.ac,
                }]}>
                {confirming ? <ActivityIndicator color={p.disTx} /> : <View style={[styles.confirmGlyph, { backgroundColor: canConfirm ? p.onAccent : p.disTx }]}>
                  <ChatIcon name="plus" size={12} color={canConfirm ? p.ac : p.dis} />
                </View>}
                <Text style={[textStyle(12.5, 'semibold'), styles.flexShrink, styles.center,
                  { color: !canConfirm || confirming ? p.disTx : p.onAccent }]}>{copy.confirmLabel}</Text>
              </Pressable></View> : null}
            </View>
            {scheduleTime ? <Text style={[timestampStyle, styles.scheduleTime]}>{scheduleTime}</Text> : null}
          </View> : reviewExtras ? <View style={styles.reviewExtras}>{reviewExtras}</View> : null}
          {followup && message(followup, 'chat-followup')}
          {quickActions.length > 0 ? <ScrollView horizontal testID="chat-quick-actions" showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled" contentContainerStyle={styles.quickActions} style={styles.quickScroller}>
            {quickActions.map(action => <Pressable key={action.id} testID={`chat-quick-${action.id}`}
              accessibilityRole="button" accessibilityLabel={action.label} accessibilityState={{ disabled: !!action.disabled }}
              disabled={action.disabled || !onQuickAction} onPress={() => onQuickAction?.(action.id)} hitSlop={5}
              style={({ pressed }) => [styles.quickAction, { borderColor: p.lnStrong, backgroundColor: pressed ? p.sf2 : p.sf }]}>
              {action.icon ? <ChatIcon name={action.icon} size={16} color={action.disabled ? p.mu : p.ac} /> : null}
              <Text style={[textStyle(11), action.disabled && { color: p.mu }]}>{action.label}</Text>
            </Pressable>)}
          </ScrollView> : null}
          {accessibilitySize && languageControl ? <View style={[styles.languageRow, styles.scrollLanguage]}>{languageControl}</View> : null}
        </> : bodyOverride}
      </ScrollView>
      {composing && <View testID="chat-composer" style={[styles.composer, {
        backgroundColor: p.bg, borderTopColor: p.ln, paddingBottom: keyboardShown ? 8 : Math.max(safeBottom, 12),
      }]}>
        {voiceNotice}
        <View testID="chat-composer-row" style={styles.composerRow}>
          {/* A clipboard, not "+": the control pastes, and «الصق» says so (u27). */}
          <IconButton label={copy.pasteLabel} onPress={onPaste} colors={p} icon="paste" testID="capture-paste" disabled={inputDisabled || composerDisabled} />
          <TextInput testID="capture-input" value={text} onChangeText={onChangeText} multiline scrollEnabled
            editable={!inputDisabled && !composerDisabled} accessibilityState={{ disabled: inputDisabled || composerDisabled }}
            accessibilityLabel={copy.placeholder} placeholder={copy.placeholder} placeholderTextColor={p.mu}
            style={[styles.input, contentStyle(text, 14, 'regular', true), {
              color: p.tx, backgroundColor: p.sf, borderColor: p.lnStrong, textAlign: rtl ? 'right' : 'left',
              maxHeight: accessibilitySize ? 160 : 116,
            }]} />
          {/* Dictation remains available after typing. Keep its controller
              mounted as partial transcripts change the draft and Send appears. */}
          {microphone != null && <View>{microphone}</View>}
          {showSend ? <Pressable testID="capture-analyze" accessibilityRole="button"
            accessibilityLabel={copy.sendLabel} accessibilityState={{ disabled: !canSend }} disabled={!canSend}
            onPress={onSend} hitSlop={3} style={({ pressed }) => [styles.composerAction, {
              backgroundColor: !canSend ? p.dis : pressed ? p.acd : p.ac,
            }]}>
            <ChatIcon name="send" size={19} color={canSend ? p.onAccent : p.disTx} rtl={rtl} />
          </Pressable> : null}
        </View>
        {!accessibilitySize && languageControl ? <View style={styles.languageRow}>{languageControl}</View> : null}
      </View>}
    </View>
  );
}

function IconButton({ colors: p, label, onPress, icon, rtl = false, testID, disabled = false }: {
  colors: ChatColors; label: string; onPress(): void; icon: ChatIconName; rtl?: boolean; testID?: string; disabled?: boolean;
}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    disabled={disabled} accessibilityState={{ disabled }}
    hitSlop={6} style={({ pressed }) => [styles.circle, { backgroundColor: pressed ? p.sf2 : p.sf, borderColor: p.ln }]}>
    <ChatIcon name={icon} color={disabled ? p.mu : p.tx} size={19} rtl={rtl} />
  </Pressable>;
}

export function ChatMicrophone({ colors: p, label, onPress, listening = false, busy = false }: {
  colors: ChatColors; label: string; onPress(): void; listening?: boolean; busy?: boolean;
}) {
  return <Pressable testID="voice-button" accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ busy }} onPress={onPress} hitSlop={3}
    style={({ pressed }) => [styles.composerAction, { backgroundColor: pressed ? p.acd : p.ac }]}>
    {listening ? <View testID="voice-stop-glyph" style={[styles.stopGlyph, { backgroundColor: p.onAccent }]} /> : <ChatIcon name="microphone" size={21} color={p.onAccent} />}
  </Pressable>;
}

export function ChatLanguage({ colors: p, label, accessibilityLabel, fontFamily, onPress }: {
  colors: ChatColors; label: string; accessibilityLabel: string; fontFamily: string; onPress(): void;
}) {
  return <Pressable testID="voice-language" accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={onPress} hitSlop={10} style={({ pressed }) => [styles.language, { backgroundColor: pressed ? p.sf2 : p.sf, borderColor: p.ln }]}>
    <ChatIcon name="globe" size={14} color={p.tx} />
    <Text style={{ color: p.tx, fontFamily, fontSize: 11.5, lineHeight: 18, textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}

export function ChatRibbon({ colors: p, size = 24 }: { colors: Pick<ChatColors, 'ac' | 'acd'>; size?: number }) {
  const id = `chatRibbon${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={p.acd} /><Stop offset="1" stopColor={p.ac} /></LinearGradient></Defs>
      <Path d="M5 12C10 0 23 13 32 22C43 11 55 6 59 19C64 35 59 60 49 60C40 60 29 43 23 38C14 48 5 55 3 43C1 34 1 22 5 12Z" fill={`url(#${id})`} />
      <Path d="M24 38C35 27 46 24 60 29C61 45 56 60 49 60C40 60 30 44 24 38Z" fill={p.acd} opacity={0.5} />
    </Svg>
  </View>;
}

export function ChatIcon({ name, color, size = 20, rtl = false }: {
  name: ChatIconName; color: string; size?: number; rtl?: boolean;
}) {
  const stroke = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  let glyph: React.ReactNode;
  switch (name) {
    case 'back': glyph = <Path d={rtl ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'} {...stroke} />; break;
    case 'more': glyph = <><Circle cx={5} cy={12} r={1.7} fill={color} /><Circle cx={12} cy={12} r={1.7} fill={color} /><Circle cx={19} cy={12} r={1.7} fill={color} /></>; break;
    case 'plus': glyph = <Path d="M12 5v14M5 12h14" {...stroke} />; break;
    case 'check': glyph = <Path d="M5 12l4 4L19 6" {...stroke} />; break;
    case 'checks': glyph = <><Path d="M2 13l4 4L16 6M10 17L21 6" {...stroke} /></>; break;
    case 'microphone': glyph = <><Rect x={8} y={2} width={8} height={13} rx={4} fill={color} /><Path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6" {...stroke} /></>; break;
    case 'send': glyph = <Path d={rtl ? 'M21 3L2 12l19 9-5-9 5-9ZM16 12H2' : 'M3 3l19 9-19 9 5-9-5-9ZM8 12h14'} {...stroke} />; break;
    case 'calendar': glyph = <><Rect x={3} y={5} width={18} height={17} rx={2} {...stroke} /><Path d="M7 2v5M17 2v5M3 10h18" {...stroke} /><Rect x={7} y={13} width={3} height={3} rx={0.5} fill={color} /><Circle cx={15} cy={14.5} r={1} fill={color} /></>; break;
    case 'doctor': glyph = <><Path d="M5 3H3v5a6 6 0 0 0 12 0V3h-2M9 14v2a5 5 0 0 0 10 0v-2" {...stroke} /><Circle cx={19} cy={11} r={2.3} {...stroke} /><Path d="M5 2v3M13 2v3" {...stroke} /></>; break;
    case 'briefcase': glyph = <><Rect x={3} y={7} width={18} height={14} rx={2} {...stroke} /><Path d="M8 7V4h8v3M3 12c5 3 13 3 18 0M10 12h4v4h-4z" {...stroke} /></>; break;
    case 'car': glyph = <><Path d="M4 10l2-6h12l2 6M3 11h18v8H3zM5 19v2M19 19v2" {...stroke} /><Circle cx={6.5} cy={14.5} r={1.4} fill={color} /><Circle cx={17.5} cy={14.5} r={1.4} fill={color} /></>; break;
    case 'pin': glyph = <><Path d="M15 2l7 7-3 1-4 4 1 3-3 3-9-9 3-3 3 1 4-4 1-3Z" fill={color} /><Path d="M8 16l-6 6" {...stroke} /></>; break;
    case 'clock': glyph = <><Circle cx={12} cy={12} r={9} {...stroke} /><Path d="M12 6v6l4 2" {...stroke} /></>; break;
    case 'globe': glyph = <><Circle cx={12} cy={12} r={10} {...stroke} /><Path d="M2 12h20M4 6h16M4 18h16M12 2c-6 5-6 15 0 20 6-5 6-15 0-20Z" {...stroke} /></>; break;
    case 'copy': glyph = <><Rect x={8} y={8} width={13} height={13} rx={2} {...stroke} /><Path d="M16 8V3H3v13h5" {...stroke} /></>; break;
    case 'paste': glyph = <><Rect x={5} y={4} width={14} height={18} rx={2} {...stroke} /><Rect x={9} y={2} width={6} height={4} rx={1} {...stroke} /><Path d="M9 11h6M9 15h4" {...stroke} /></>; break;
    case 'edit': glyph = <Path d="M4 16l-1 5 5-1L21 7l-4-4L4 16ZM14 6l4 4" {...stroke} />; break;
  }
  return <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>{glyph}</Svg>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, gap: 12 },
  circle: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  identity: { alignItems: 'center', gap: 5, flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  scroller: { flex: 1 },
  conversation: { flexGrow: 1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  scrollHeader: { marginHorizontal: -12, marginTop: -10, marginBottom: 10 },
  outgoingBlock: { alignItems: 'flex-end', marginBottom: 0 },
  outgoingBubble: { width: 190, maxWidth: '85%', borderRadius: 16, borderWidth: 0.7, paddingHorizontal: 12, paddingVertical: 10 },
  expandedOutgoing: { width: '90%' },
  outgoingTime: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingEnd: 2 },
  assistantBlock: { marginTop: 0 },
  assistantRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  avatar: { width: 33, height: 33, borderRadius: 17, borderWidth: 0.8, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  assistantBubble: { maxWidth: 232, flexShrink: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, gap: 5 },
  firstAssistantBubble: { maxWidth: 216 },
  expandedBubble: { flex: 1, maxWidth: '100%' },
  incomingTime: { marginStart: 43, marginTop: 3 },
  scheduleBlock: { marginStart: 41, marginTop: 7, maxWidth: 290 },
  expandedSchedule: { marginStart: 0, maxWidth: '100%' },
  scheduleCard: { borderWidth: 0.8, borderRadius: 14, padding: 11, gap: 6 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, paddingHorizontal: 3 },
  nextGroup: { marginTop: 8 },
  scheduleRows: { borderWidth: 0.7, borderRadius: 10, paddingHorizontal: 8 },
  scheduleRow: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 48, paddingVertical: 7 },
  // The whole row is the checkbox (the small check on the icon only marks
  // it), at least 44 tall without leaning on hitSlop (u28).
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 44 },
  rowIcon: { width: 33, height: 33, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  checkMark: { position: 'absolute', bottom: -4, end: -4, width: 15, height: 15, borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  notIncluded: { borderWidth: 0.7, borderRadius: 6, paddingHorizontal: 5, overflow: 'hidden' },
  rowWords: { flex: 1, alignItems: 'flex-start', gap: 2 },
  rowMore: { width: 32, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  rowDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 3 },
  rowExtra: { paddingStart: 44, paddingBottom: 8, gap: 4 },
  reviewExtras: { gap: 8, marginVertical: 5 },
  confirm: { minHeight: 33, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  confirmGlyph: { width: 15, height: 15, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  scheduleTime: { marginTop: 4, paddingStart: 2 },
  followup: { marginTop: 12 },
  laterTurn: { marginTop: 12 },
  notice: { marginTop: 8, marginStart: 41 },
  typingBubble: { minHeight: 38, justifyContent: 'center' },
  quickScroller: { marginHorizontal: -12, marginTop: 12, flexGrow: 0, flexShrink: 0 },
  quickActions: { paddingHorizontal: 14, paddingVertical: 1, gap: 9, alignItems: 'center' },
  quickAction: { minHeight: 34, paddingVertical: 7, paddingHorizontal: 8, borderWidth: 0.7, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 7 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 9, paddingHorizontal: 12, gap: 8 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, minHeight: 40, borderWidth: 0.8, borderRadius: 23, paddingHorizontal: 13, paddingTop: 10, paddingBottom: 10 },
  composerAction: { width: 39, height: 39, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  languageRow: { alignItems: 'flex-start' },
  scrollLanguage: { marginTop: 12 },
  language: { minHeight: 25, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 2, borderWidth: 0.7, flexDirection: 'row', alignItems: 'center', gap: 7 },
  stopGlyph: { width: 14, height: 14, borderRadius: 3 },
  flexShrink: { flexShrink: 1 },
  center: { textAlign: 'center' },
});
