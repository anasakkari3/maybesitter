import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
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
import { localDateTimeFor } from '../features/capture/localInstant';
import { fill, ltr } from '../i18n/strings';
import { dayKey, formatDayKey, formatTime, shiftDayKey } from '../i18n/format';
import { useTimeZone } from '../i18n/timezone';
import { family, LINE_HEIGHT } from '../theme/fonts';
import { captureChatPalette } from '../theme/tokens';
import { useLayoutMode } from '../theme/textScale';
import { VoiceButton, VoiceNote } from '../features/capture/voice/VoiceButton';
import { appendDictation } from '../features/capture/voice/dictationText';
import type { SpeechStatus } from '../features/capture/voice/SpeechCaptureService';
import { createSpeechCaptureService, SpeechEventBridge } from '../features/capture/voice/speechService';
import { VoiceLanguageChip } from '../features/capture/voice/VoiceLanguageChip';
import { speechLanguageForTag } from '../features/capture/voice/speechLocale';
import { loadSpeechLanguage, saveSpeechLanguage, type SpeechLanguagePref } from '../lib/deviceSettings/speechLanguage';
import { SayItChatPage, ChatMicrophone, ChatLanguage, type ChatScheduleGroup } from '../features/capture/SayItChatPage';
import { WeeklyChoice } from '../features/weeklyBlocks/WeeklyChoice';
import { weeklyA11yLabel } from '../features/weeklyBlocks/weeklyText';
import { SeedProposalSection } from '../features/seeds/SeedProposalSection';
import { BusyConflictChip } from '../features/calendar/BusyConflictChip';
import { useBusyBlocks } from '../features/calendar/useBusyCalendar';
import { useConflictBusyBlocks } from '../features/google/useGoogle';
import { busyAt } from '../features/calendar/conflicts';
import { Btn, Pill, Txt } from '../ui/primitives';
import { ProcessingDots, ScreenIn } from '../ui/motion';
import { AvoidKeyboard } from '../ui/keyboard';
import type { UserFacingKey } from '../api/ui/userFacingMessage';
import { ReviewScreen } from './ReviewScreen';

const REVIEW_STATUSES = ['needsConfirmation', 'needsClarification', 'unresolvedIntent', 'confirming', 'confirmFailed'];

/** Connects the independently built chat page to the existing capture transaction. */
export function CaptureScreen() {
  const { t, p: appPalette, rtl, script, lang, scheme, actions } = useApp();
  const p = captureChatPalette(scheme, appPalette);
  const flow = useCaptureFlow();
  const { state } = flow;
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  const timezone = useTimeZone();
  const keyboardShown = useKeyboardShown();
  const reviewing = REVIEW_STATUSES.includes(state.status);
  const busy = state.status === 'confirming' || state.status === 'analyzing';
  // A reply is separate from the active proposal: typing never resets its edits.
  const { replyDraft: reply, setReplyDraft: setReply, replyIntent: replyMode, setReplyIntent: setReplyMode } = flow;
  const [replacement, setReplacement] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const composerText = reviewing ? reply : state.text;
  const changeText = (text: string) => { if (reviewing) setReply(text); else flow.setText(text); };
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
  const composerAnswersQuestion = reviewing && replyMode === 'answer' && Boolean(asking?.clarification?.allowFreeText);
  const inputLimit = composerAnswersQuestion ? 200 : MAX_CAPTURE_LENGTH;
  const inputLength = composerAnswersQuestion ? composerText.trim().length : composerText.length;
  const conflictBlocks = useConflictBusyBlocks(useBusyBlocks());

  const leave = () => { flow.close(); actions.closeCapture(); };
  const requestClose = () => {
    if (state.status === 'confirming') return;
    if (wantsDiscardConfirmation(state) || reply.trim()) setConfirmingDiscard(true);
    else leave();
  };
  const answer = async (itemId: string, value: { optionId?: string; freeText?: string }, submittedReply?: string) => {
    if (answering) return;
    setAnswering(true);
    setClarifyError(null);
    const outcome = await flow.clarify(itemId, value);
    setAnswering(false);
    if (!outcome.ok) setClarifyError({ itemId, key: outcome.messageKey });
    else if (submittedReply !== undefined) { setReply(''); setReplyMode('answer'); }
  };
  const submit = (override?: string) => {
    stopDictation();
    Keyboard.dismiss();
    setSentAt(new Date());
    setReply('');
    setReplyMode('answer');
    setReplacement(null);
    setNotice(null);
    setSkipped([]);
    setClarifyError(null);
    void flow.analyze(override);
  };
  const send = () => {
    if (!composerText.trim() || inputLength > inputLimit || busy || answering) return;
    if (!reviewing) { submit(); return; }
    if (replyMode === 'answer' && asking?.clarification?.allowFreeText) {
      void answer(asking.itemId, { freeText: reply }, reply);
    } else {
      // The existing endpoint creates a new proposal, not a conversation patch.
      // Explicit replacement keeps the old selection and edits intact until agreed.
      setReplacement(reply);
    }
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
    if (id.startsWith('example-')) {
      const key = COMPOSER_EXAMPLE_KEYS.find(key => `example-${key}` === id);
      if (key) changeText(exampleText(key, t));
      return;
    }
    if (id === 'commute') { setReplyMode('new'); setReply(t.chatCommuteDraft); setNotice(t.chatCommuteHint); return; }
    const selected = items.filter(item => state.selected.includes(item.itemId));
    if (id === 'must') {
      selected.forEach(item => flow.editItem(item.itemId, { priority: 'high' }));
      setNotice(t.chatMustUpdated);
    }
    if (id === 'tomorrow') {
      const timed = selected.map(item => ({ item, shown: chatItemPresentation(item, state.edits[item.itemId], lang, timezone, t) }));
      if (timed.some(({ shown }) => !shown.instant)) { setNotice(t.chatChooseTime); setToolsOpen(true); return; }
      const tomorrow = shiftDayKey(dayKey(new Date(), timezone), 1);
      timed.forEach(({ item, shown }) => {
        flow.editItem(item.itemId, { localDateTime: `${tomorrow}T${localDateTimeFor(shown.instant!, timezone).slice(11)}` });
        flow.setWeekly(item.itemId, false);
      });
      setNotice(t.chatTomorrowUpdated);
    }
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
      {shown.priority === 'high' ? <Txt size={12} color={p.wm}>{t.todayGroupMust}</Txt> : null}
      {shown.priorityEstimated ? <Txt size={11} color={p.mu} testID={`review-estimated-${item.itemId}`}>{t.reviewEstimated}</Txt> : null}
      {shown.dateEstimated && weekly !== 'weekly' ? <Btn testID={`review-date-estimated-${item.itemId}`} label={t.reviewDateEstimated} onPress={() => setEditingId(item.itemId)}><Txt size={11} color={p.mu}>{t.reviewDateEstimated}</Txt></Btn> : null}
      {shown.timeEstimated && weekly !== 'weekly' ? <Btn testID={`review-time-estimated-${item.itemId}`} label={t.reviewTimeEstimated} onPress={() => setEditingId(item.itemId)}><Txt size={11} color={p.mu} testID={`review-time-estimated-${item.itemId}-text`}>{t.reviewTimeEstimated}</Txt></Btn> : null}
      {needsQuestion ? <Txt size={12} color={p.wm} testID={`review-needs-question-${item.itemId}`}>{t.reviewNeedsQuestion}</Txt> : null}
      {shown.instant && weekly !== 'weekly' ? <BusyConflictChip testID={`review-busy-${item.itemId}`} blocks={busyAt(shown.instant.toISOString(), conflictBlocks)} /> : null}
      {item.weeklyBlock && weekly ? <WeeklyChoice itemId={item.itemId} offer={item.weeklyBlock} title={state.edits[item.itemId]?.title ?? item.weeklyBlock.title} choice={weekly} locked={weeklyLockedByEdit(state, item.itemId)} onChoose={value => flow.setWeekly(item.itemId, value)} /> : null}
    </View>;
    groups.get(groupKey)!.rows = [...groups.get(groupKey)!.rows, {
      id: item.itemId, title: shown.title,
      ...(weekly === 'weekly' ? {} : { subtitle: shown.subtitle }),
      icon: /doctor|طبيب|دكتور|רופא/i.test(shown.title) ? 'doctor' : 'briefcase', selected, selectionDisabled: busy || answering || needsQuestion, disabled: busy || answering,
      accessibilityLabel: `${shown.title}, ${selected ? t.reviewSelected : t.reviewNotSelected}, ${weekly === 'weekly' && item.weeklyBlock ? weeklyA11yLabel({ ...item.weeklyBlock, title: state.edits[item.itemId]?.title ?? item.weeklyBlock.title }, lang, { withTitle: false }) : shown.subtitle}${shown.dateEstimated && weekly !== 'weekly' ? ', ' + t.reviewDateEstimated : ''}${shown.timeEstimated && weekly !== 'weekly' ? ', ' + t.reviewTimeEstimated : ''}`,
      extra,
    }];
  }

  const failed = isFailedStatus(state.status) ? state.status : null;
  let bodyOverride: React.ReactNode = null;
  if (confirmingDiscard) bodyOverride = <View style={{ gap: 16 }} testID="capture-discard">
    <Txt size={22} weight={600}>{t.captureDiscardTitle}</Txt><Txt size={15}>{t.captureDiscardBody}</Txt>
    <Pill testID="capture-discard-keep" label={t.captureKeepEditing} onPress={() => setConfirmingDiscard(false)} />
    <Pill testID="capture-discard-confirm" label={t.captureDiscardConfirm} onPress={leave} kind="warm" />
  </View>;
  else if (replacement !== null) bodyOverride = <View style={{ gap: 16 }} testID="chat-replace-draft">
    <Txt size={22} weight={600}>{t.chatReplaceTitle}</Txt><Txt size={15}>{t.chatReplaceBody}</Txt>
    <Txt size={15} color={p.mu}>{replacement}</Txt>
    <Pill testID="chat-replace-keep" label={t.chatKeepProposal} onPress={() => setReplacement(null)} />
    <Pill testID="chat-replace-confirm" label={t.chatStartNew} onPress={() => submit(replacement)} kind="warm" />
  </View>;
  else if (clipboard) bodyOverride = <ClipboardImportSheet result={clipboard} replacing={composerText.trim().length > 0}
    onUse={text => { changeText(text); setClipboard(null); }} onCancel={() => setClipboard(null)} />;
  else if (editingId && items.some(item => item.itemId === editingId)) bodyOverride = <EditProposalItemSheet
    key={editingId} item={items.find(item => item.itemId === editingId)!} edit={state.edits[editingId]}
    onChange={next => editItem(editingId, next)} onClose={() => setEditingId(null)} />;
  else if (menuOpen) bodyOverride = <View style={{ gap: 14 }}>
    <Pill label={t.capturePaste} onPress={() => { setMenuOpen(false); void readClipboardText().then(setClipboard); }} />
    <Pill label={t.captureAiOffHint} onPress={() => actions.go('trust')} kind="soft" />
    <Pill label={t.close} onPress={() => setMenuOpen(false)} kind="ghost" />
  </View>;
  else if (state.status === 'analyzing') bodyOverride = <View style={{ alignItems: 'center', gap: 20 }} testID="capture-analyzing">
    <ProcessingDots color={p.ac} /><Txt size={18}>{t.understanding}</Txt><Txt size={14} color={p.mu}>{state.text}</Txt>
  </View>;
  else if (state.status === 'noCommitment') bodyOverride = <NothingFound line={noCommitmentLine(state.proposal?.noCommitmentReason, strings)} onClose={leave} />;
  else if (failed) bodyOverride = <Failed status={failed} messageKey={state.messageKey} onRetry={() => submit()} onBack={flow.backToComposer} />;

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
  </View> : <Txt size={12} color={p.mu} align="center">{t.privacyText}</Txt>;
  const counter = inputLength > inputLimit - (composerAnswersQuestion ? 50 : 200)
    ? <Txt size={12} latin color={inputLength > inputLimit ? p.wm : p.mu} testID="capture-counter">{fill(composerAnswersQuestion ? t.chatAnswerCounter : t.captureCounter, { n: inputLength })}</Txt> : null;
  const language = voiceStatus !== 'unavailable' ? <VoiceLanguageChip value={speechLang}
    onChange={next => { setSpeechLang(next); void saveSpeechLanguage(next); }}
    renderControl={({ label, accessibilityLabel, onPress }) => <ChatLanguage colors={p} label={label} accessibilityLabel={accessibilityLabel}
      fontFamily={family(600, speechLang === 'ar' ? 'arabic' : speechLang === 'he' ? 'hebrew' : 'latin')} onPress={onPress} />} /> : null;

  const outgoing = reviewing && state.text ? { text: state.text, delivered: true,
    ...(sentAt ? { time: ltr(formatTime(sentAt, { locale: lang, timeZone: timezone })) } : {}) } : null;
  const followup = notice ? { text: notice } : reviewing && items.length > 1 ? { text: t.chatCommuteQuestion } : null;

  if (toolsOpen && reviewing) return <ReviewScreen onBackToChat={() => setToolsOpen(false)} />;
  return <ScreenIn style={{ backgroundColor: p.bg }}><SpeechEventBridge />
    <AvoidKeyboard testID="capture-kav" style={{ flex: 1 }}>
      <SayItChatPage colors={p} fonts={{ regular: family(400, script), semibold: family(600, script), latin: family(400, 'latin'), lineRatio: LINE_HEIGHT[script] }}
        copy={{ title: t.captureTitle, subtitle: t.chatAssistant, placeholder: replyMode === 'answer' && asking?.clarification?.allowFreeText ? t.chatAnswerPlaceholder : t.chatPlaceholder,
          closeLabel: reviewing ? t.back : t.cancel, moreLabel: t.chatOptions, pasteLabel: t.capturePaste, sendLabel: t.analyze, confirmLabel: t.chatAddSchedule }}
        text={composerText} onChangeText={changeText} onSend={send}
        canSend={Boolean(composerText.trim()) && inputLength <= inputLimit && !busy && !answering}
        inputDisabled={state.status === 'confirming' || answering}
        onClose={() => {
          if (state.status === 'confirming') return;
          if (editingId) setEditingId(null);
          else if (replacement !== null) setReplacement(null);
          else if (clipboard) setClipboard(null);
          else if (menuOpen) setMenuOpen(false);
          else if (confirmingDiscard) setConfirmingDiscard(false);
          else requestClose();
        }} onMore={() => { if (!busy && !answering) { if (reviewing) setToolsOpen(true); else setMenuOpen(true); } }}
        onPaste={() => { if (!busy && !answering) void readClipboardText().then(setClipboard); }}
        {...(outgoing ? { outgoing } : {})}
        assistant={{ text: reviewing ? t.chatFound : t.chatWelcome }}
        scheduleGroups={[...groups.values()]} onRowPress={setEditingId} onRowToggle={flow.toggleItem}
        onConfirm={() => { stopDictation(); Keyboard.dismiss(); void flow.confirm(); }} canConfirm={state.selected.length > 0 && !busy && !answering} confirming={state.status === 'confirming'}
        {...(followup ? { followup } : {})}
        quickActions={reviewing ? [{ id: 'commute', label: t.chatAddCommute, icon: 'car', disabled: busy || answering },
          { id: 'tomorrow', label: t.chatTomorrowOnly, disabled: busy || answering || !state.selected.length },
          { id: 'must', label: t.chatMakeMust, icon: 'pin', disabled: busy || answering || !state.selected.length }]
          : COMPOSER_EXAMPLE_KEYS.map(key => ({ id: `example-${key}`, label: exampleText(key, t) }))}
        onQuickAction={quickAction} rtl={rtl} safeTop={insets.top} safeBottom={insets.bottom} keyboardShown={keyboardShown} mode={mode} listening={voiceStatus === 'listening'}
        headerAccessory={!flow.aiGranted ? <Btn testID="capture-ai-off" label={`${t.captureAiOff}. ${t.captureAiOffHint}`} onPress={() => actions.go('trust')}><Txt size={12} color={p.mu}>{t.captureAiOff}</Txt></Btn> : null}
        bodyOverride={bodyOverride} reviewExtras={reviewExtras} languageControl={language}
        voiceNotice={<>{counter}<VoiceNote status={voiceStatus} /></>}
        microphone={busy || answering || voiceStatus === 'unavailable' ? undefined : <VoiceButton key={voiceEpoch} service={speech} showNote={false} autoFocus={voiceEpoch === 0 && state.inputMode === 'voice'} onStart={onDictationStart}
          onStatusChange={setVoiceStatus} onPartial={onDictated} onFinal={onDictated}
          renderControl={({ onPress, listening, busy }) => <ChatMicrophone colors={p} label={listening ? t.stopReview : t.tapToTalk}
            onPress={onPress} listening={listening} busy={busy} />} />}
      />
    </AvoidKeyboard>
  </ScreenIn>;
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
