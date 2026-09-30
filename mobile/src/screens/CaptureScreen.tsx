import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Keyboard, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH, confirmableItems, wantsDiscardConfirmation, weeklyChoice, weeklyLockedByEdit, type CaptureItemEdit } from '../features/capture/captureMachine';
import { noCommitmentLine } from '../features/capture/noCommitment';
import { COMPOSER_EXAMPLE_KEYS, exampleText } from '../features/capture/examples';
import { ClipboardImportSheet } from '../features/capture/ClipboardImportSheet';
import { readClipboardText, type ClipboardImport } from '../features/capture/clipboardImport';
import { ClarifySheet } from '../features/capture/ClarifySheet';
import { questionText } from '../features/capture/clarificationCopy';
import { EditProposalItemSheet } from '../features/capture/EditProposalItemSheet';
import { chatItemPresentation } from '../features/capture/chatPresentation';
import { fill, ltr } from '../i18n/strings';
import { isolateLatinRuns } from '../i18n/bidi';
import { formatDayKey, formatTime } from '../i18n/format';
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
import { SayItChatPage, ChatMicrophone, ChatLanguage, type ChatHistoryEntry, type ChatScheduleGroup } from '../features/capture/SayItChatPage';
import { WeeklyChoice } from '../features/weeklyBlocks/WeeklyChoice';
import { weeklyA11yLabel } from '../features/weeklyBlocks/weeklyText';
import { SeedProposalSection } from '../features/seeds/SeedProposalSection';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import { busyAt } from '../features/calendar/conflicts';
import { Btn, Pill, Txt } from '../ui/primitives';
import { ProcessingDots } from '../ui/motion';
import { Screen } from '../ui/screen';
import { AvoidKeyboard } from '../ui/keyboard';
import { useAnnounceOnIos } from '../ui/announce';
import type { UserFacingKey } from '../api/ui/userFacingMessage';
import { ReviewScreen } from './ReviewScreen';

const REVIEW_STATUSES = ['needsConfirmation', 'needsClarification', 'unresolvedIntent', 'confirming', 'confirmFailed'];

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
  const reviewing = REVIEW_STATUSES.includes(state.status);
  const busy = state.status === 'confirming' || state.status === 'analyzing';
  // Something «ابدأ من جديد» would clear: a conversation, a proposal, a draft.
  const hasConversation = state.turns.length > 0 || state.proposal !== null || state.text.trim().length > 0;
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
  const newest = state.turns[state.turns.length - 1];
  useAnnounceOnIos(newest?.role === 'assistant' ? newest.text : null);

  const leave = () => { setDiscarding(null); flow.close(); actions.closeCapture(); };
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
    if (reviewing || state.text.trim() || state.turns.length > 0) return;
    const key = COMPOSER_EXAMPLE_KEYS.find(key => `example-${key}` === id);
    if (key) changeText(exampleText(key, t));
  };

  const groups = new Map<string, ChatScheduleGroup>();
  for (const item of items) {
    const shown = chatItemPresentation(item, state.edits[item.itemId], lang, timezone, t);
    const selected = state.selected.includes(item.itemId);
    const needsQuestion = !confirmable.includes(item.itemId);
    const weekly = weeklyChoice(state, item.itemId);
    const groupKey = weekly === 'weekly' ? 'weekly' : shown.date ?? 'undated';
    if (!groups.has(groupKey)) groups.set(groupKey, { id: groupKey,
      title: weekly === 'weekly' ? t.wbReviewWeekly : shown.date ? formatDayKey(shown.date, { locale: lang, timeZone: timezone }) : t.chatUnscheduled, rows: [] });
    const extra = <View style={{ gap: 4, alignItems: 'flex-start' }}>
      {/* «حزرناها» qualifies the importance, so it sits beside the importance
          it qualifies — never alone under a time the person said, where it
          read as "we guessed the time" (chat UAT 2026-09-30). The card shows
          the importance only when it is «لازم». */}
      {shown.priority === 'high' ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <Txt size={12} color={p.wm} testID={`review-priority-${item.itemId}`}>{t.todayGroupMust}</Txt>
        {shown.priorityEstimated ? <Txt size={11} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt> : null}
      </View> : null}
      {shown.dateEstimated && weekly !== 'weekly' ? <Btn testID={`review-date-estimated-${item.itemId}`} label={t.reviewDateEstimated} hint={t.reviewEdit} hitSlop={12} onPress={() => setEditingId(item.itemId)}><Txt size={11} color={p.mu}>{t.reviewDateEstimated}</Txt></Btn> : null}
      {shown.timeEstimated && weekly !== 'weekly' ? <Btn testID={`review-time-estimated-${item.itemId}`} label={t.reviewTimeEstimated} hint={t.reviewEdit} hitSlop={12} onPress={() => setEditingId(item.itemId)}><Txt size={11} color={p.mu} testID={`review-time-estimated-${item.itemId}-text`}>{t.reviewTimeEstimated}</Txt></Btn> : null}
      {needsQuestion ? <Txt size={12} color={p.wm} testID={`review-needs-question-${item.itemId}`}>{t.reviewNeedsQuestion}</Txt> : null}
      {shown.instant && weekly !== 'weekly' ? <BusyConflictChip testID={`review-busy-${item.itemId}`} blocks={busyAt(shown.instant.toISOString(), conflictBlocks)} /> : null}
      {item.weeklyBlock && weekly ? <WeeklyChoice itemId={item.itemId} offer={item.weeklyBlock} title={state.edits[item.itemId]?.title ?? item.weeklyBlock.title} choice={weekly} locked={weeklyLockedByEdit(state, item.itemId)} onChoose={value => flow.setWeekly(item.itemId, value)} /> : null}
    </View>;
    // Kept weekly, the card is the block: «تدريب», with «كل سبت · 10:00–16:00»
    // said by the weekly line — not «تدريب كل سبت» (chat UAT round 2).
    const cardTitle = weekly === 'weekly' && item.weeklyBlock ? state.edits[item.itemId]?.title ?? item.weeklyBlock.title : shown.title;
    groups.get(groupKey)!.rows = [...groups.get(groupKey)!.rows, {
      id: item.itemId, title: cardTitle,
      ...(weekly === 'weekly' ? {} : { subtitle: shown.subtitle }),
      icon: /doctor|طبيب|دكتور|רופא/i.test(shown.title) ? 'doctor' : 'briefcase', selected, selectionDisabled: busy || answering || needsQuestion, disabled: busy || answering,
      accessibilityLabel: `${cardTitle}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${weekly === 'weekly' && item.weeklyBlock ? weeklyA11yLabel({ ...item.weeklyBlock, title: state.edits[item.itemId]?.title ?? item.weeklyBlock.title }, lang, { withTitle: false }) : shown.subtitle}${shown.dateEstimated && weekly !== 'weekly' ? ', ' + t.reviewDateEstimated : ''}${shown.timeEstimated && weekly !== 'weekly' ? ', ' + t.reviewTimeEstimated : ''}`,
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

  const reviewExtras = reviewing ? <View style={{ gap: 12 }}>
    <Txt size={12} color={p.mu} testID="review-note">{t.suggestionNote}</Txt>
    {asking ? <ClarifySheet key={asking.itemId} item={asking} position={unclarified.length - waiting.length + 1}
      total={unclarified.length} busy={answering} error={clarifyError?.itemId === asking.itemId ? t[clarifyError.key] : null}
      onAnswer={value => { void answer(asking.itemId, value); }} onSkip={() => {
        const noTime = asking.clarification?.options.find(option => !option.value.localTime && !option.value.localDate);
        if (noTime) void answer(asking.itemId, { optionId: noTime.optionId });
        else setSkipped(current => [...current, asking.itemId]);
      }} /> : null}
    {state.status === 'confirmFailed' ? <Txt testID="review-confirm-failed" color={p.wm}>{t[state.messageKey ?? 'errorsGeneric']}</Txt> : null}
    {state.selected.length === 0 && items.length ? <Txt testID="review-none-selected" color={p.mu}>{t.reviewNothingSelected}</Txt> : null}
    {state.proposal?.seeds?.length ? <SeedProposalSection proposalId={state.proposal.proposalId} seeds={state.proposal.seeds} /> : null}
    <Pill testID="review-cancel" label={t.cancelAll} onPress={requestClose} disabled={state.status === 'confirming'} kind="ghost" size={13} />
  </View> : null;
  const counter = inputLength > MAX_CAPTURE_LENGTH - 200
    ? <Txt size={12} latin color={inputLength > MAX_CAPTURE_LENGTH ? p.wm : p.mu} testID="capture-counter">{fill(t.captureCounter, { n: inputLength })}</Txt> : null;
  const language = voiceStatus !== 'unavailable' ? <VoiceLanguageChip value={speechLang}
    onChange={next => { setSpeechLang(next); void saveSpeechLanguage(next); }}
    renderControl={({ label, accessibilityLabel, onPress }) => <ChatLanguage colors={p} label={label} accessibilityLabel={accessibilityLabel}
      fontFamily={family(600, speechLang === 'ar' ? 'arabic' : speechLang === 'he' ? 'hebrew' : 'latin')} onPress={onPress} />} /> : null;

  const sentTime = sentAt ? ltr(formatTime(sentAt, { locale: lang, timeZone: timezone })) : undefined;
  const lastMine = state.turns.map(turn => turn.role).lastIndexOf('user');
  const history: ChatHistoryEntry[] = state.turns.map((turn, index) => turn.role === 'user'
    ? { role: 'user', text: turn.text, delivered: true, ...(index === lastMine && sentTime && state.status !== 'analyzing' ? { time: sentTime } : {}) }
    : { role: 'assistant', text: turn.text });
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
          confirmLabel: tr('confirmN', { n: state.selected.length }), editLabel: t.reviewEdit, notIncludedLabel: t.chatNotIncluded }}
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
        notice={<View testID="capture-ai-disclosure" style={{ gap: 2, alignItems: 'flex-start' }}>
          <Txt role="section" size={12.5} weight={600} color={p.tx} testID="capture-ai-disclosure-title">{t.aiDisclosureTitle}</Txt>
          <Txt size={12} color={p.mu} testID="capture-ai-disclosure-body">{isolateLatinRuns(t.aiDisclosure)}</Txt>
          <Txt size={12} color={p.mu}>{t.aiDisclosureKept}</Txt>
        </View>}
        history={history}
        {...(state.status === 'analyzing' ? { typing: <ProcessingDots color={p.ac} />, typingLabel: t.understanding } : {})}
        scheduleGroups={[...groups.values()]} onRowPress={setEditingId} onRowToggle={flow.toggleItem}
        onConfirm={() => { stopDictation(); Keyboard.dismiss(); void flow.confirm(); }} canConfirm={state.selected.length > 0 && !busy && !answering} confirming={state.status === 'confirming'}
        quickActions={reviewing || state.text.trim() || state.turns.length > 0 || state.status === 'analyzing' ? []
          : COMPOSER_EXAMPLE_KEYS.map(key => ({ id: `example-${key}`, label: exampleText(key, t) }))}
        onQuickAction={quickAction} rtl={rtl} safeBottom={insets.bottom} keyboardShown={keyboardShown} mode={mode} listening={voiceStatus === 'listening'}
        bodyOverride={bodyOverride} reviewExtras={reviewExtras} languageControl={language}
        voiceNotice={<>{counter}<VoiceNote status={voiceStatus} /></>}
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
