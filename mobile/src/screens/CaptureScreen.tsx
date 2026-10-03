import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Keyboard, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH, chatSaves, confirmableItems, goalLinkKept, wantsDiscardConfirmation, weeklyChoice, weeklyLockedByEdit, type CaptureItemEdit, type ChatSavedNote } from '../features/capture/captureMachine';
import { noCommitmentLine } from '../features/capture/noCommitment';
import { COMPOSER_EXAMPLE_KEYS, exampleText } from '../features/capture/examples';
import { ClipboardImportSheet } from '../features/capture/ClipboardImportSheet';
import { readClipboardText, type ClipboardImport } from '../features/capture/clipboardImport';
import { ClarifySheet } from '../features/capture/ClarifySheet';
import { questionText } from '../features/capture/clarificationCopy';
import { EditProposalItemSheet } from '../features/capture/EditProposalItemSheet';
import { chatItemPresentation } from '../features/capture/chatPresentation';
import { chatConflictA11y, chatConflictLines } from '../features/capture/chatConflicts';
import { collisionLines } from '../features/capture/savedCollisions';
import { fill, ltr } from '../i18n/strings';
import { isolateAuto, isolateLatinRuns, stripIsolates } from '../i18n/bidi';
import { formatDayKey, formatRelativeDay, formatTime } from '../i18n/format';
import type { Lang, Strings } from '../i18n/strings';
import { useTimeZone } from '../i18n/timezone';
import { family, LINE_HEIGHT, scriptOfText } from '../theme/fonts';
import { captureChatPalette } from '../theme/tokens';
import { useLayoutMode } from '../theme/textScale';
import { VoiceButton, VoiceNote } from '../features/capture/voice/VoiceButton';
import { appendDictation } from '../features/capture/voice/dictationText';
import type { SpeechStatus } from '../features/capture/voice/SpeechCaptureService';
import { createSpeechCaptureService, SpeechEventBridge } from '../features/capture/voice/speechService';
import { VoiceLanguageChip } from '../features/capture/voice/VoiceLanguageChip';
import { speechLanguageForTag } from '../features/capture/voice/speechLocale';
import { loadSpeechLanguage, saveSpeechLanguage, type SpeechLanguagePref } from '../lib/deviceSettings/speechLanguage';
import { SayItChatPage, ChatMicrophone, ChatLanguage, ChatIcon, type ChatHistoryEntry, type ChatScheduleGroup } from '../features/capture/SayItChatPage';
import { WeeklyChoice } from '../features/weeklyBlocks/WeeklyChoice';
import { weeklyA11yLabel, weeklyLine } from '../features/weeklyBlocks/weeklyText';
import { SeedProposalSection } from '../features/seeds/SeedProposalSection';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import { busyAt, chipBlock } from '../features/calendar/conflicts';
import { Btn, Pill, Txt } from '../ui/primitives';
import { Tag } from '../ui/chrome';
import { ProcessingDots, useReducedMotion } from '../ui/motion';
import { Screen } from '../ui/screen';
import { AvoidKeyboard } from '../ui/keyboard';
import { useAnnounceOnIos } from '../ui/announce';
import type { UserFacingKey } from '../api/ui/userFacingMessage';
import { ReviewScreen } from './ReviewScreen';

const REVIEW_STATUSES = ['needsConfirmation', 'needsClarification', 'unresolvedIntent', 'confirming', 'confirmFailed'];

/**
 * What a save in the chat says, as the assistant's line (owner request
 * 2026-09-30): what was saved, by title; the weekly blocks and where they are
 * changed; what it lands on; what did not save; Undo's answer when pressed.
 * The invitation to say the next thing («في إشي تاني؟ احكيلي.») follows in a
 * bubble of its own (Stitch 03, the line's `tail`). Built here, from the confirm's
 * own answer — the server never wrote it, and it claims nothing the server
 * did not report saved.
 */
function savedNoteText(note: ChatSavedNote, t: Strings, lang: Lang, timeZone: string): string {
  const list = (titles: string[]) => titles.map((title) => (lang === 'ar' ? `«${isolateAuto(title)}»` : `"${isolateAuto(title)}"`))
    .join(lang === 'ar' ? '، ' : ', ');
  const whenOf = (startsAt: string | null) => (startsAt
    ? `${formatRelativeDay(new Date(startsAt), { locale: lang, timeZone })} · ${ltr(formatTime(new Date(startsAt), { locale: lang, timeZone }))}`
    : t.noTimeYet);
  const paragraphs: string[] = [];
  if (note.persisted.length > 0) paragraphs.push(fill(t.chatSaved, { titles: list(note.persisted.map((item) => item.title)) }));
  if (note.weeklySaved.length > 0) {
    paragraphs.push([...note.weeklySaved.map(({ block }) => weeklyLine(block, lang)), t.wbSavedNote].join('\n'));
  }
  // One line for every clash the confirm reported, never one per pair (audit
  // 2026-10-03 #1); Undo sits right under it.
  paragraphs.push(...collisionLines(note.collisions, t, lang, (startsAt) => whenOf(startsAt)));
  // What it now counts toward (audit 2026-10-03 #6), when a goal link was kept.
  if (note.goalTitles?.length) paragraphs.push(fill(t.chatSavedGoal, { goals: list(note.goalTitles) }));
  if (note.failed.length > 0) {
    paragraphs.push(`${t.savedFailedTitle}${note.failedTitles.length > 0 ? `: ${list(note.failedTitles)}` : ''}. ${t.savedFailedBody}`);
  }
  if (note.undone) {
    const still = note.undone.stillSaved.map((id) => note.persisted.find((item) => item.commitmentId === id)?.title ?? id);
    paragraphs.push(still.length === 0 ? t.undoneTitle : `${t.undonePartialTitle}. ${fill(t.undonePartialBody, { titles: list(still) })}`);
  }
  return paragraphs.join('\n\n');
}

/**
 * The capture chat «احكيها» (owner decision 2026-09-30): the independently
 * built chat page, driven by the conversation the server keeps.
 *
 * Every send goes to `POST /api/mobile/capture/chat` in the current
 * conversation. The page shows the opening line, then the conversation turn by
 * turn — the person's messages and the assistant's replies, as the server kept
 * them — and under the newest reply the proposal's cards, which are the same
 * review rows as before: check, «…» edit sheet, weekly choice, the one
 * question's options (answered through `/capture/clarify`), «هذا اقتراح. لم
 * يتغيّر أي شيء بعد.», and the counted confirm (`/capture/confirm`). A reply is
 * words: whatever it says, nothing is saved and nothing reads "saved" until
 * the confirm succeeds.
 */
export function CaptureScreen() {
  const { t, tr, p: appPalette, rtl, script, lang, scheme, actions } = useApp();
  const p = captureChatPalette(scheme, appPalette);
  const flow = useCaptureFlow();
  const { state } = flow;
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  const timezone = useTimeZone();
  const keyboardShown = useKeyboardShown();
  const reducedMotion = useReducedMotion();
  const reviewing = REVIEW_STATUSES.includes(state.status);
  const busy = state.status === 'confirming' || state.status === 'analyzing';
  // Something «ابدأ من جديد» would clear: a conversation, a proposal, a draft.
  const hasConversation = state.turns.length > 0 || state.earlier.length > 0 || state.proposal !== null || state.text.trim().length > 0;
  // What the discard question is about: closing capture, going back from a
  // touched proposal to the composer (which keeps what was said), or starting
  // the conversation over.
  const [discarding, setDiscarding] = useState<'close' | 'back' | 'restart' | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<Date | null>(null);
  const [answering, setAnswering] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [clarifyError, setClarifyError] = useState<{ itemId: string; key: UserFacingKey } | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardImport | null>(null);
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<SpeechStatus>('idle');
  const [speechLang, setSpeechLang] = useState<SpeechLanguagePref>(() => speechLanguageForTag(lang));
  useEffect(() => {
    let active = true;
    void loadSpeechLanguage().then(stored => { if (active && stored) setSpeechLang(stored); });
    return () => { active = false; };
  }, []);
  const speech = useMemo(() => createSpeechCaptureService(() => speechLang), [speechLang]);
  // The field is always the next message. While one is on its way it sits in
  // the conversation as a bubble, and the field is empty.
  const composerText = state.status === 'analyzing' ? '' : state.text;
  const changeText = (text: string) => flow.setText(text);
  const latestText = useRef(composerText);
  useEffect(() => { latestText.current = composerText; }, [composerText]);
  const dictationBase = useRef('');
  const dictationEnabled = useRef(true);
  const onDictationStart = () => { dictationEnabled.current = true; dictationBase.current = latestText.current; };
  const onDictated = (spoken: string) => { if (dictationEnabled.current) changeText(appendDictation(dictationBase.current, spoken)); };
  const stopDictation = () => { dictationEnabled.current = false; void speech.cancel?.(); setVoiceEpoch(epoch => epoch + 1); };
  /** «إلغاء» while listening: the dictation ends and the field holds what it held before it. */
  const cancelDictation = () => { const before = dictationBase.current; stopDictation(); changeText(before); };
  const strings = t as unknown as Record<string, string>;
  const items = reviewing ? state.proposal?.items ?? [] : [];
  const confirmable = confirmableItems(state.proposal, state.edits);
  const unclarified = items.filter(item => item.needsClarification && !confirmable.includes(item.itemId));
  const waiting = unclarified.filter(item => item.clarification && !skipped.includes(item.itemId)
    && questionText(item.clarification.questionKey, item.clarification.params, strings) !== null);
  const asking = waiting[0];
  const inputLength = composerText.length;
  const conflictBlocks = useConflictBusyBlocks(useBusyBlocks());
  // The newest reply, told to VoiceOver when it lands (TalkBack hears the
  // bubble's live region).
  // What the chat said and saved before this conversation (a save keeps the
  // person here, owner request 2026-09-30), then this conversation.
  const saves = chatSaves(state);
  let savedLines = 0;
  const earlier: ChatHistoryEntry[] = state.earlier.map(entry => entry.kind === 'turn'
    ? { role: entry.role, text: entry.text, ...(entry.role === 'user' ? { delivered: true } : {}) }
    : { role: 'assistant', id: `chat-saved-${++savedLines}`, tone: 'saved', text: savedNoteText(entry, t, lang, timezone), tail: t.chatSavedNext });
  const newest: { role: string; text: string; tail?: string } | undefined = state.turns.length > 0 ? state.turns[state.turns.length - 1] : earlier[earlier.length - 1];
  useAnnounceOnIos(newest?.role === 'assistant' ? (newest.tail ? `${newest.text}\n\n${newest.tail}` : newest.text) : null);
  const [disclosureOpen, setDisclosureOpen] = useState(true);
  const [undoing, setUndoing] = useState(false);
  const undoLast = () => {
    if (undoing) return;
    setUndoing(true);
    void flow.undo().finally(() => setUndoing(false));
  };

  const leave = () => { setDiscarding(null); flow.close(); actions.closeCapture(); };
  /** «خلصت» after a save: where the saved screen's OK went, to the day the things are on. */
  const done = () => { stopDictation(); flow.close(); actions.go('today'); };
  const back = () => { setDiscarding(null); setEditingId(null); setToolsOpen(false); flow.backToComposer(); };
  const restart = () => { setDiscarding(null); setEditingId(null); setToolsOpen(false); setMenuOpen(false); stopDictation(); flow.startOver(); };
  const discardsSomething = () => wantsDiscardConfirmation(state);
  /** The explicit exit ("Cancel all" in review, the header in the composer). */
  const requestClose = () => {
    if (state.status === 'confirming') return;
    if (discardsSomething()) setDiscarding('close');
    else leave();
  };
  /**
   * The header's Back while reviewing: back to the composer with the sentence
   * still in it. Only hand edits, a changed selection or a typed reply are
   * worth asking about; an untouched proposal is simply re-derivable.
   */
  const requestBack = () => {
    if (state.status === 'confirming') return;
    if (discardsSomething()) setDiscarding('back');
    else back();
  };
  const answer = async (itemId: string, value: { optionId?: string; freeText?: string }) => {
    if (answering) return;
    setAnswering(true);
    setClarifyError(null);
    const outcome = await flow.clarify(itemId, value);
    setAnswering(false);
    if (!outcome.ok) setClarifyError({ itemId, key: outcome.messageKey });
  };
  /**
   * Every send is the next message of the conversation — a first request, a
   * correction ("make it 6pm"), an answer to what the assistant asked. The
   * answer's proposal replaces the one on screen (`chatAnswered`).
   */
  const send = () => {
    if (!composerText.trim() || inputLength > MAX_CAPTURE_LENGTH || busy || answering) return;
    stopDictation();
    Keyboard.dismiss();
    setSentAt(new Date());
    setSkipped([]);
    setClarifyError(null);
    setEditingId(null);
    void flow.analyze();
  };
  const editItem = (itemId: string, edit: CaptureItemEdit) => {
    const item = items.find(candidate => candidate.itemId === itemId);
    const noTime = item?.needsClarification
      ? item.clarification?.options.find(option => !option.value.localTime && !option.value.localDate) : undefined;
    if (noTime && edit.localDateTime === '') {
      void answer(itemId, { optionId: noTime.optionId });
      const rest: CaptureItemEdit = {};
      if (edit.title !== undefined && edit.title !== item?.title) rest.title = edit.title;
      if (edit.priority !== undefined && edit.priority !== (item?.priority ?? 'normal')) rest.priority = edit.priority;
      if (edit.locationTrigger !== undefined) rest.locationTrigger = edit.locationTrigger;
      if (Object.keys(rest).length) flow.editItem(itemId, rest);
    } else flow.editItem(itemId, edit);
  };
  const quickAction = (id: string) => {
    if (busy || answering) return;
    // Examples only fill an empty draft of a new conversation; they are never
    // offered over typed text, or once the assistant has answered.
    if (reviewing || state.text.trim() || state.turns.length > 0 || state.earlier.length > 0) return;
    const key = COMPOSER_EXAMPLE_KEYS.find(key => `example-${key}` === id);
    if (key) changeText(exampleText(key, t));
  };

  const groups = new Map<string, ChatScheduleGroup>();
  for (const item of items) {
    const shown = chatItemPresentation(item, state.edits[item.itemId], lang, timezone, t);
    const selected = state.selected.includes(item.itemId);
    const needsQuestion = !confirmable.includes(item.itemId);
    const weekly = weeklyChoice(state, item.itemId);
    const linked = goalLinkKept(state, item.itemId);
    const groupKey = weekly === 'weekly' ? 'weekly' : shown.date ?? 'undated';
    // What the item's time lands on (owner request 2026-09-30): the server's
    // clashes, named; the device chip below keeps the phone's own calendar.
    const busyHere = shown.instant && weekly !== 'weekly' ? busyAt(shown.instant.toISOString(), conflictBlocks) : [];
    const clashLines = weekly === 'weekly' ? [] : chatConflictLines(item, state.edits[item.itemId], { lang, timezone, t, busyChipShown: chipBlock(busyHere) !== null });
    if (!groups.has(groupKey)) groups.set(groupKey, { id: groupKey,
      title: weekly === 'weekly' ? t.wbReviewWeekly : shown.date ? formatDayKey(shown.date, { locale: lang, timeZone: timezone }) : t.chatUnscheduled, rows: [] });
    // «حزرناها» qualifies the importance, so it sits beside the importance it
    // qualifies — never alone under a time the person said, where it read as
    // "we guessed the time" (chat UAT 2026-09-30). The card shows the
    // importance only when it is «لازم», as the coral «لازم» tag (Stitch).
    const badge = shown.priority === 'high' ? <>
      <Tag kind="must" label={t.todayGroupMust} testID={`review-priority-${item.itemId}`} />
      {shown.priorityEstimated ? <Txt size={12} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt> : null}
    </> : null;
    const extra = <View style={{ gap: 6, alignItems: 'flex-start' }}>
      {shown.dateEstimated && weekly !== 'weekly' ? <Btn testID={`review-date-estimated-${item.itemId}`} label={t.reviewDateEstimated} hint={t.reviewEdit} hitSlop={12} onPress={() => setEditingId(item.itemId)}><Txt size={12} color={p.mu}>{t.reviewDateEstimated}</Txt></Btn> : null}
      {shown.timeEstimated && weekly !== 'weekly' ? <Btn testID={`review-time-estimated-${item.itemId}`} label={t.reviewTimeEstimated} hint={t.reviewEdit} hitSlop={12} onPress={() => setEditingId(item.itemId)}><Txt size={12} color={p.mu} testID={`review-time-estimated-${item.itemId}-text`}>{t.reviewTimeEstimated}</Txt></Btn> : null}
      {needsQuestion ? <Txt size={12} color={p.wm} testID={`review-needs-question-${item.itemId}`}>{t.reviewNeedsQuestion}</Txt> : null}
      {/* A clash is a full-width warning line naming what it clashes with
          (Stitch 03), not a pill: amber edge, warning glyph, the words. */}
      {clashLines.map((line, index) => <View key={`clash-${index}`} testID={`review-conflict-${item.itemId}-${index}`} accessible accessibilityLabel={chatConflictA11y(line)}
        style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: p.wms, borderStartWidth: 4, borderStartColor: p.wm, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 }}>
        <ChatIcon name="warning" size={18} color={p.wm} />
        <Txt size={13} weight={500} color={p.wm} style={{ flex: 1 }} testID={`review-conflict-${item.itemId}-${index}-text`}>{line}</Txt>
      </View>)}
      {shown.instant && weekly !== 'weekly' ? <BusyConflictChip testID={`review-busy-${item.itemId}`} blocks={busyHere} /> : null}
      {/* «مرتبط بهدف …» (audit 2026-10-03 #6): the goal this card would count
          toward, kept unless the person takes it off — one control, a
          checkbox, its state said in words as well as by the action. */}
      {item.goalLink ? <Btn testID={`review-goal-${item.itemId}`} accessibilityRole="checkbox" accessibilityState={{ checked: linked, disabled: busy || answering }}
        label={stripIsolates(fill(t.reviewGoalLink, { goal: item.goalLink.title }))} disabled={busy || answering}
        onPress={() => flow.setGoalLink(item.itemId, !linked)} scaleTo={1}
        style={{ alignSelf: 'stretch', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: p.sf, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12 }}>
        <Txt size={13} weight={500} color={linked ? p.tx : p.mu} style={{ flex: 1 }} testID={`review-goal-${item.itemId}-text`}>
          {fill(linked ? t.reviewGoalLink : t.reviewGoalLinkRemoved, { goal: isolateAuto(item.goalLink.title) })}
        </Txt>
        <Txt size={13} weight={600} color={busy || answering ? p.mu : p.ac} testID={`review-goal-${item.itemId}-action`}>{linked ? t.reviewGoalLinkRemove : t.reviewGoalLinkRestore}</Txt>
      </Btn> : null}
      {item.weeklyBlock && weekly ? <WeeklyChoice itemId={item.itemId} offer={item.weeklyBlock} title={state.edits[item.itemId]?.title ?? item.weeklyBlock.title} choice={weekly} locked={weeklyLockedByEdit(state, item.itemId)} onChoose={value => flow.setWeekly(item.itemId, value)} /> : null}
    </View>;
    // Kept weekly, the card is the block: «تدريب», with «كل سبت · 10:00–16:00»
    // said by the weekly line — not «تدريب كل سبت» (chat UAT round 2).
    const cardTitle = weekly === 'weekly' && item.weeklyBlock ? state.edits[item.itemId]?.title ?? item.weeklyBlock.title : shown.title;
    groups.get(groupKey)!.rows = [...groups.get(groupKey)!.rows, {
      id: item.itemId, title: cardTitle,
      ...(weekly === 'weekly' ? {} : { subtitle: shown.subtitle }),
      icon: /doctor|طبيب|دكتور|רופא/i.test(shown.title) ? 'doctor' : 'briefcase', selected, badge, selectionDisabled: busy || answering || needsQuestion, disabled: busy || answering,
      accessibilityLabel: `${cardTitle}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${weekly === 'weekly' && item.weeklyBlock ? weeklyA11yLabel({ ...item.weeklyBlock, title: state.edits[item.itemId]?.title ?? item.weeklyBlock.title }, lang, { withTitle: false }) : shown.subtitle}${shown.dateEstimated && weekly !== 'weekly' ? ', ' + t.reviewDateEstimated : ''}${shown.timeEstimated && weekly !== 'weekly' ? ', ' + t.reviewTimeEstimated : ''}${clashLines.map(line => ', ' + chatConflictA11y(line)).join('')}${item.goalLink && linked ? ', ' + stripIsolates(fill(t.reviewGoalLink, { goal: item.goalLink.title })) : ''}`,
      extra,
    }];
  }

  const failed = isFailedStatus(state.status) ? state.status : null;
  let bodyOverride: React.ReactNode = null;
  if (discarding) bodyOverride = <View style={{ gap: 16 }} testID="capture-discard">
    <Txt size={22} weight={600}>{t.captureDiscardTitle}</Txt>
    <Txt size={15}>{discarding === 'back' ? t.chatBackDiscardBody : discarding === 'restart' ? t.chatStartOverBody : t.captureDiscardBody}</Txt>
    {/* Staying, said as what staying is: with a proposal on screen it is back
        to that proposal, not «كمّل كتابة» (chat UAT 2026-09-30). */}
    <Pill testID="capture-discard-keep" label={reviewing ? t.chatBackToProposal : t.captureKeepEditing} onPress={() => setDiscarding(null)} />
    <Pill testID="capture-discard-confirm" label={discarding === 'restart' ? t.chatStartOver : t.captureDiscardConfirm}
      onPress={discarding === 'back' ? back : discarding === 'restart' ? restart : leave} kind="warm" />
  </View>;
  else if (clipboard) bodyOverride = <ClipboardImportSheet result={clipboard} replacing={composerText.trim().length > 0}
    onUse={text => { changeText(text); setClipboard(null); }} onCancel={() => setClipboard(null)} />;
  else if (editingId && items.some(item => item.itemId === editingId)) bodyOverride = <EditProposalItemSheet
    key={editingId} item={items.find(item => item.itemId === editingId)!} edit={state.edits[editingId]}
    onChange={next => editItem(editingId, next)} onClose={() => setEditingId(null)} />;
  else if (menuOpen) bodyOverride = <View style={{ gap: 14 }} testID="chat-menu">
    <Pill testID="chat-menu-paste" label={t.capturePaste} onPress={() => { setMenuOpen(false); void readClipboardText().then(setClipboard); }} />
    {reviewing ? <Pill testID="chat-menu-review-tools" label={t.chatReviewTools} kind="soft"
      onPress={() => { setMenuOpen(false); setToolsOpen(true); }} /> : null}
    {/* A new conversation, on purpose: the assistant forgets this one. */}
    {hasConversation ? <Pill testID="chat-menu-start-over" label={t.chatStartOver} kind="soft"
      onPress={() => { setMenuOpen(false); if (wantsDiscardConfirmation(state)) setDiscarding('restart'); else restart(); }} /> : null}
    <Pill testID="chat-menu-close" label={t.close} onPress={() => setMenuOpen(false)} kind="ghost" />
  </View>;
  else if (state.status === 'noCommitment') bodyOverride = <NothingFound line={noCommitmentLine(state.proposal?.noCommitmentReason, strings)} onClose={leave} />;
  else if (failed) bodyOverride = <Failed status={failed} messageKey={state.messageKey}
    onRetry={() => { setSentAt(new Date()); void flow.analyze(); }} onBack={flow.dismissFailure} />;

  // The one question's quick replies sit under the reply that asks it, above
  // the cards (Stitch 03b); answering is still `/capture/clarify`.
  const clarification = reviewing && asking ? <ClarifySheet key={asking.itemId} item={asking} position={unclarified.length - waiting.length + 1}
    total={unclarified.length} busy={answering} error={clarifyError?.itemId === asking.itemId ? t[clarifyError.key] : null}
    onAnswer={value => { void answer(asking.itemId, value); }} onSkip={() => {
      const noTime = asking.clarification?.options.find(option => !option.value.localTime && !option.value.localDate);
      if (noTime) void answer(asking.itemId, { optionId: noTime.optionId });
      else setSkipped(current => [...current, asking.itemId]);
    }} /> : null;
  const reviewExtras = reviewing ? <View style={{ gap: 10 }}>
    {state.status === 'confirmFailed' ? <Txt testID="review-confirm-failed" color={p.wm}>{t[state.messageKey ?? 'errorsGeneric']}</Txt> : null}
    {state.selected.length === 0 && items.length ? <Txt size={13} testID="review-none-selected" color={p.mu}>{t.reviewNothingSelected}</Txt> : null}
    {state.proposal?.seeds?.length ? <SeedProposalSection proposalId={state.proposal.proposalId} seeds={state.proposal.seeds} /> : null}
  </View> : null;
  // Under the save (Stitch 03): every review option, the propose-only note,
  // and the explicit exit.
  const reviewFooter = reviewing ? <>
    <Pill testID="review-tools" label={t.chatReviewTools} onPress={() => setToolsOpen(true)} disabled={state.status === 'confirming'} kind="ghost" size={13} weight={500} pad={10} />
    <Txt size={13} color={p.mu} align="center" testID="review-note">{t.suggestionNote}</Txt>
    <Pill testID="review-cancel" label={t.cancelAll} onPress={requestClose} disabled={state.status === 'confirming'} kind="ghost" size={13} pad={10} />
  </> : null;
  // After a save the person stays in the chat: Undo for the last save while
  // its window is open — what the saved screen offered — and «خلصت», inside
  // the saved line when it is the newest thing said, under the chat otherwise.
  const savedActions = !reviewing && saves > 0 && state.status !== 'analyzing' ? <>
    {state.undoable && state.persisted.length > 0 ? <Pill testID="chat-saved-undo" label={t.undo} onPress={undoLast} disabled={undoing} kind="soft" size={13} pad={10} radius={12} style={{ minWidth: 88 }} /> : null}
    <Pill testID="chat-done" label={t.chatDone} onPress={done} kind="soft" size={13} pad={10} radius={12} style={{ minWidth: 88 }} />
  </> : null;
  const savedIsNewest = savedActions !== null && state.turns.length === 0 && state.earlier.length > 0
    && state.earlier[state.earlier.length - 1]!.kind === 'saved';
  if (savedIsNewest) {
    const last = earlier[earlier.length - 1]!;
    earlier[earlier.length - 1] = { ...last, actions: <View testID="chat-saved-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{savedActions}</View> };
  }
  const afterChat = reviewing ? reviewExtras : savedActions && !savedIsNewest
    ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }} testID="chat-saved-actions">{savedActions}</View> : null;
  const counter = inputLength > MAX_CAPTURE_LENGTH - 200
    ? <Txt size={12} latin color={inputLength > MAX_CAPTURE_LENGTH ? p.wm : p.mu} testID="capture-counter">{fill(t.captureCounter, { n: inputLength })}</Txt> : null;
  const language = voiceStatus !== 'unavailable' ? <VoiceLanguageChip value={speechLang}
    onChange={next => { setSpeechLang(next); void saveSpeechLanguage(next); }}
    renderControl={({ label, accessibilityLabel, onPress }) => <ChatLanguage colors={p} label={label} accessibilityLabel={accessibilityLabel}
      fontFamily={family(600, speechLang === 'ar' ? 'arabic' : speechLang === 'he' ? 'hebrew' : 'latin')} onPress={onPress} />} /> : null;

  const sentTime = sentAt ? ltr(formatTime(sentAt, { locale: lang, timeZone: timezone })) : undefined;
  const lastMine = state.turns.map(turn => turn.role).lastIndexOf('user');
  const history: ChatHistoryEntry[] = [...earlier, ...state.turns.map((turn, index): ChatHistoryEntry => turn.role === 'user'
    ? { role: 'user', text: turn.text, delivered: true, ...(index === lastMine && sentTime && state.status !== 'analyzing' ? { time: sentTime } : {}) }
    : { role: 'assistant', text: turn.text })];
  // The message on its way: in the conversation already, not yet delivered.
  if (state.status === 'analyzing' && state.text.trim()) {
    history.push({ role: 'user', text: state.text, ...(sentTime ? { time: sentTime } : {}) });
  }

  /**
   * The header's back/✕, one function for both ways back. Each layer shut in
   * turn — an open sheet, the replace question, the discard question — then
   * review → composer (`requestBack`) and composer → closed (`requestClose`),
   * both of which ask before throwing away a typed draft.
   */
  const headerBack = () => {
    if (state.status === 'confirming') return;
    if (editingId) setEditingId(null);
    else if (clipboard) setClipboard(null);
    else if (menuOpen) setMenuOpen(false);
    else if (discarding) setDiscarding(null);
    else if (reviewing) requestBack();
    else requestClose();
  };
  /*
   * Android's hardware/gesture back is the header's back (UAT 2026-09-30,
   * u57–u60). Root's handler walks the navigation history, which closed the
   * capture task outright and dropped a typed draft without the question the
   * header asks. This screen registers after Root, so BackHandler calls it
   * first; it always consumes the press, because every way out of capture
   * goes through `headerBack`.
   */
  const hardwareBack = useRef(headerBack);
  useEffect(() => { hardwareBack.current = toolsOpen && reviewing ? () => setToolsOpen(false) : headerBack; });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { hardwareBack.current(); return true; });
    return () => sub.remove();
  }, []);

  if (toolsOpen && reviewing) return <ReviewScreen onBackToChat={() => setToolsOpen(false)} />;
  // The shell owns the safe-area top (screenShellCensus); the chat header sits
  // below it on the chat palette's background.
  return <Screen style={{ backgroundColor: p.bg }}><SpeechEventBridge />
    <AvoidKeyboard testID="capture-kav" style={{ flex: 1 }}>
      <SayItChatPage colors={p} fonts={{ regular: family(400, script), semibold: family(600, script), latin: family(400, 'latin'), lineRatio: LINE_HEIGHT[script],
        forText: (value, weight) => { const run = scriptOfText(value, script); return { fontFamily: family(weight === 'semibold' ? 600 : 400, run), lineRatio: LINE_HEIGHT[run] }; } }}
        copy={{ title: t.captureTitle, subtitle: t.chatSubtitle, placeholder: t.chatPlaceholder,
          closeLabel: reviewing ? t.back : t.cancel, moreLabel: t.chatOptions, pasteLabel: t.capturePaste, sendLabel: t.chatSend,
          // The save says what it saves, by count and plural-safe (ICU, as
          // confirmN): «احفظ الاتنين», «احفظ وحدة», nothing when none is ticked.
          confirmLabel: tr('chatSaveN', { n: state.selected.length }), editLabel: t.reviewEdit, includeLabel: t.chatWillSave,
          proposalsTitle: fill(t.chatProposedN, { n: items.length }),
          listeningTitle: t.chatListening, listeningNote: t.voiceListening, cancelListeningLabel: t.cancel }}
        text={composerText} onChangeText={changeText} onSend={send}
        canSend={Boolean(composerText.trim()) && inputLength <= MAX_CAPTURE_LENGTH && !busy && !answering}
        inputDisabled={state.status === 'confirming' || answering}
        composerDisabled={state.status === 'analyzing'}
        onClose={headerBack} onMore={() => { if (!busy && !answering) setMenuOpen(true); }}
        onPaste={() => { if (!busy && !answering) void readClipboardText().then(setClipboard); }}
        assistant={{ text: t.chatWelcome }}
        // The disclosure that replaced the AI consent (owner decision
        // 2026-09-30): on the page, before the first message is sent.
        // Its heading as on Trust («مين بيفهم كلامك»), so it reads as what it
        // is rather than a stray line (chat UAT 2026-09-30).
        // Stitch draws it as the link «مين بيفهم كلامك» under the welcome; the
        // words stay open under it until the person folds them (a 44-point
        // control), so the disclosure is read, not hidden behind a tap.
        notice={<View testID="capture-ai-disclosure" style={{ gap: 2, alignItems: 'flex-start' }}>
          <Btn testID="capture-ai-disclosure-toggle" label={t.aiDisclosureTitle} onPress={() => setDisclosureOpen(open => !open)}
            accessibilityState={{ expanded: disclosureOpen }} scaleTo={1}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingEnd: 4 }}>
            <ChatIcon name="info" size={16} color={p.success} />
            <Txt size={13} weight={500} color={p.mu} testID="capture-ai-disclosure-title"
              style={{ textDecorationLine: 'underline', textDecorationColor: p.lnStrong }}>{t.aiDisclosureTitle}</Txt>
          </Btn>
          {disclosureOpen ? <View style={{ gap: 4, alignItems: 'flex-start', paddingBottom: 4 }}>
            <Txt size={13} color={p.mu} testID="capture-ai-disclosure-body">{isolateLatinRuns(t.aiDisclosure)}</Txt>
            <Txt size={13} color={p.mu}>{t.aiDisclosureKept}</Txt>
          </View> : null}
        </View>}
        history={history}
        {...(state.status === 'analyzing' ? { typing: <ProcessingDots color={p.ac} />, typingLabel: t.understanding } : {})}
        scheduleGroups={[...groups.values()]} onRowPress={setEditingId} onRowToggle={flow.toggleItem}
        onConfirm={() => { stopDictation(); Keyboard.dismiss(); void flow.confirm(); }} canConfirm={state.selected.length > 0 && !busy && !answering} confirming={state.status === 'confirming'}
        quickActions={reviewing || state.text.trim() || state.turns.length > 0 || state.earlier.length > 0 || state.status === 'analyzing' ? []
          : COMPOSER_EXAMPLE_KEYS.map(key => ({ id: `example-${key}`, label: exampleText(key, t) }))}
        onQuickAction={quickAction} rtl={rtl} safeBottom={insets.bottom} keyboardShown={keyboardShown} mode={mode} listening={voiceStatus === 'listening'}
        bodyOverride={bodyOverride} clarification={clarification} reviewExtras={afterChat} reviewFooter={reviewFooter} languageControl={language}
        onCancelListening={cancelDictation}
        // After a save the field is NOT focused (audit 2026-10-03 #8): the
        // keyboard it raised hid the line saying what was saved. The person
        // taps the field when they have the next thing to say.
        // A new proposal scrolls its confirm into view above the composer.
        revealConfirmKey={reviewing ? state.proposal?.proposalId ?? null : null}
        reduceMotion={reducedMotion}
        // While listening the panel above the field says so; the note line
        // keeps the other states (failed, no speech, denied → Settings).
        voiceNotice={<>{counter}{voiceStatus === 'listening' ? null : <VoiceNote status={voiceStatus} />}</>}
        microphone={busy || answering || voiceStatus === 'unavailable' ? undefined : <VoiceButton key={voiceEpoch} service={speech} showNote={false} autoFocus={voiceEpoch === 0 && state.inputMode === 'voice'} onStart={onDictationStart}
          onStatusChange={setVoiceStatus} onPartial={onDictated} onFinal={onDictated}
          renderControl={({ onPress, listening, busy }) => <ChatMicrophone colors={p} label={listening ? t.stopReview : t.tapToTalk}
            onPress={onPress} listening={listening} busy={busy} />} />}
      />
    </AvoidKeyboard>
  </Screen>;
}

/** Whether the software keyboard is up, so the footer can drop the home-indicator inset. */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return shown;
}

type FailedStatus = 'networkError' | 'validationError' | 'extractionFailed' | 'refused';

function isFailedStatus(status: string): status is FailedStatus {
  return status === 'networkError' || status === 'validationError'
    || status === 'extractionFailed' || status === 'refused';
}

/**
 * Nothing was created, and the screen says only that (UC-2.6, #166).
 *
 * The line comes from the server's reason code through a fixed lookup. What is
 * deliberately absent is any reaction to the message itself: the text the user
 * wrote is not echoed back here, because quoting «حسّيت بضغط» under a heading
 * is a response to the person rather than to their request.
 */
function NothingFound({ line, onClose }: { line: string; onClose: () => void }) {
  const { t, p } = useApp();
  const flow = useCaptureFlow();
  return (
    <>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 12 }} testID="capture-nothing">
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: p.sf2 }} />
        <Txt size={20} weight={600} align="center">{t.nothingTitle}</Txt>
        <Txt size={14} color={p.mu} align="center" testID="capture-nothing-reason">{line}</Txt>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill testID="capture-nothing-close" label={t.close} onPress={onClose} kind="soft" size={15} weight={500} style={{ flex: 1 }} />
        <Pill testID="capture-nothing-rephrase" label={t.rephrase} onPress={() => flow.backToComposer()} size={15} style={{ flex: 1 }} />
      </View>
    </>
  );
}

/**
 * The four ways analyze can fail, told apart.
 *
 * ── The words are not chosen here ────────────────────────────────
 *
 * `messageKey` comes from `userFacingMessageKey`, the one table that turns an
 * error into copy. This screen used to pick between three strings itself, and
 * the AI refusals — a spent daily quota, a minute's rate limit, a busy
 * service, text too long — had localized lines in en/ar/he that no branch
 * could reach: all four came out as "something went wrong" (#181). A screen
 * that writes its own copy is a second table, and a second table drifts.
 *
 * ── Which failures get a Retry ───────────────────────────────────
 *
 * A 400 is the server refusing this input and it will refuse it again, so
 * there is no Retry — offering one would invite the user to press it until
 * they gave up. A refusal is the same answer for a different reason: pressing
 * Retry against a spent quota is precisely the loop the quota exists to stop.
 * Back is always there, and it returns to the composer with the text intact.
 */
function Failed({
  status, messageKey, onRetry, onBack,
}: {
  status: FailedStatus;
  messageKey: UserFacingKey | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t, p } = useApp();
  // Read now, not when the failure happened: switching language with this on
  // screen has to change the sentence, which a stored message could not do.
  const message = messageKey ? t[messageKey] : t.errorsGeneric;
  const retryable = status === 'networkError' || status === 'extractionFailed';

  return (
    <>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 12 }} testID={`capture-error-${status}`}>
        <Txt size={20} weight={600} align="center">{t.captureFailedTitle}</Txt>
        <Txt size={14} color={p.mu} align="center" testID="capture-error-message">{message}</Txt>
      </View>
      <View style={{ gap: 10 }}>
        {retryable ? (
          <Pill testID="capture-retry" label={t.errorsRetry} onPress={onRetry} />
        ) : null}
        <Pill testID="capture-error-back" label={t.back} onPress={onBack} kind="outline" />
      </View>
    </>
  );
}
