import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, BackHandler, Keyboard, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useCaptureFlow } from '../features/capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH, chatSaves, confirmableGoals, confirmableHabits, confirmableItems, confirmableThoughts, goalLinkKept, pointSelected, selectedCount, showsUnderstood, summaryPoints, wantsDiscardConfirmation, weeklyChoice, weeklyLockedByEdit, type CaptureItemEdit, type ChatSavedNote } from '../features/capture/captureMachine';
import { GoalProposalCard, HabitProposalCard, SeedCommitAction, ThoughtProposalCard } from '../features/capture/ProposalPointCards';
import { tFor } from '../i18n';
import { LiveRegion } from '../ui/liveRegion';
import { useGoalPlan } from '../api/queries';
import { understoodKeyOf, UnderstoodMessage, type UnderstoodTarget } from '../features/capture/UnderstoodMessage';
import { familyIdOf, familyIdOfLine, type PointTarget } from '../features/capture/pointIdentity';
import { SummaryEditSheet } from '../features/capture/SummaryEditSheet';
import { useCaptureKinds } from '../features/capture/useCaptureKinds';
import { instantForLocalDateTime } from '../features/capture/localInstant';
import { usableUnderstood, type CaptureEntry } from '../api/schemas/capture';
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
import { busyDuring, chipBlock } from '../features/calendar/conflicts';
import { Btn, Pill, Txt } from '../ui/primitives';
import { Tag } from '../ui/chrome';
import { ProcessingDots, useReducedMotion } from '../ui/motion';
import { Screen } from '../ui/screen';
import { AvoidKeyboard } from '../ui/keyboard';
import { useAnnounceOnIos } from '../ui/announce';
import { focusForAccessibility } from '../ui/accessibilityFocus';
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
/**
 * A saved goal's two ways on (M3b): «اعمللي خطة» while that goal's plan path
 * answers — asked of the goal itself, so a switched-off plan module (404)
 * hides it (R2-013) — and «افتح الهدف», the memory list where it can be
 * changed or removed (R4-004).
 */
function SavedGoalActions({ goalId, title }: { goalId: string; title: string }) {
  const { t, actions } = useApp();
  const plan = useGoalPlan(goalId);
  const planOn = plan.isSuccess;
  return <>
    {planOn ? <Pill testID={`capture-saved-start-plan-${goalId}`} label={t.xStartPlan}
      accessibilityLabel={fill(t.xOpenSubjectLabel, { action: t.xStartPlan, title })}
      onPress={() => actions.openGoal(goalId, { startPlan: true })} kind="soft" size={13} pad={10} radius={12} /> : null}
    <Pill testID={`capture-saved-open-goal-${goalId}`} label={t.xOpenGoal}
      accessibilityLabel={fill(t.xOpenSubjectLabel, { action: t.xOpenGoal, title })}
      onPress={() => actions.go('memory')} kind="soft" size={13} pad={10} radius={12} />
  </>;
}

/**
 * What each M3b confirm refusal says and lets the person do (R2-010, R3-007):
 * the save wrote nothing, and the action takes out what could not be saved.
 */
const M3B_REFUSALS: Record<string, { message: 'xRefusedGoals' | 'xRefusedKinds' | 'xRefusedTooMany' | 'xRefusedHabit' | 'xRefusedKeyReused' | 'xRefusedGoalInvalid' | 'xRefusedSeedInvalid';
  action?: { label: 'xRefusedGoalsAction' | 'xRefusedKindsAction' | 'xRefusedSeedAction'; drop?: readonly ('habit' | 'goal' | 'seed')[] } }> = {
  goals_unavailable: { message: 'xRefusedGoals', action: { label: 'xRefusedGoalsAction', drop: ['goal'] } },
  kinds_unavailable: { message: 'xRefusedKinds', action: { label: 'xRefusedKindsAction', drop: ['habit', 'goal', 'seed'] } },
  // The person lowers a habit's rhythm on its card; no button pretends to do it for them.
  too_many_writes: { message: 'xRefusedTooMany' },
  // The habit's card asks its rhythm again, right above (`reask`).
  habit_invalid: { message: 'xRefusedHabit' },
  key_reused: { message: 'xRefusedKeyReused' },
  // The server no longer has the goal or thought that was picked: take it out, save the rest.
  goal_invalid: { message: 'xRefusedGoalInvalid', action: { label: 'xRefusedGoalsAction', drop: ['goal'] } },
  seed_invalid: { message: 'xRefusedSeedInvalid', action: { label: 'xRefusedSeedAction', drop: ['seed'] } },
};

function savedNoteText(note: ChatSavedNote, t: Strings, lang: Lang, timeZone: string): string {
  const list = (titles: string[]) => titles.map((title) => (lang === 'ar' ? `«${isolateAuto(title)}»` : `"${isolateAuto(title)}"`))
    .join(lang === 'ar' ? '، ' : ', ');
  const whenOf = (startsAt: string | null) => (startsAt
    ? `${formatRelativeDay(new Date(startsAt), { locale: lang, timeZone })} · ${ltr(formatTime(new Date(startsAt), { locale: lang, timeZone }))}`
    : t.noTimeYet);
  const paragraphs: string[] = [];
  if (note.persisted.length > 0) paragraphs.push(fill(t.chatSaved, { titles: list(note.persisted.map((item) => item.title)) }));
  // The other families the same confirm saved (M3b, R3-004), counted by kind.
  const families = [
    note.habitsSaved?.length ? tFor(lang)('xSavedHabitsN', { n: note.habitsSaved.length }) : null,
    note.goalsSaved?.length ? tFor(lang)('xSavedGoalsN', { n: note.goalsSaved.length }) : null,
    note.seedsSaved?.length ? tFor(lang)('xSavedThoughtsN', { n: note.seedsSaved.length }) : null,
  ].filter((part): part is string => part !== null);
  if (families.length > 0) paragraphs.push(fill(t.xSavedFamilies, { list: families.join(lang === 'en' ? ', ' : '، ') }));
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
/**
 * «في محادثة مفتوحة» (M3b SIM-5): which chat this is going to be.
 *
 * It takes the chat's place the moment capture opens, so a screen reader would
 * otherwise still be on the button that opened it, or land on the header, and
 * never hear that a question is waiting (inspection FU-003).
 *
 * One thing is spoken, once: the title and the question are a single heading,
 * and the accessibility focus is moved to it. Nothing else is announced. A
 * separate announcement beside the focus is two speech events, and on Android
 * either can cut the other off, or the title is said twice (A11Y-001/002).
 */
function EntryQuestion({ title, body, continueLabel, newLabel, onContinue, onNew }: {
  title: string; body: string; continueLabel: string; newLabel: string; onContinue: () => void; onNew: () => void;
}) {
  const question = useRef<View>(null);
  useEffect(() => { focusForAccessibility(question.current); }, []);
  return <View style={{ gap: 16 }} testID="capture-entry-ask">
    <View ref={question} testID="capture-entry-ask-title" accessible accessibilityRole="header"
      accessibilityLabel={`${title}. ${body}`} style={{ gap: 16 }}>
      <Txt size={22} weight={600}>{title}</Txt>
      <Txt size={15}>{body}</Txt>
    </View>
    <Pill testID="capture-entry-ask-continue" label={continueLabel} onPress={onContinue} />
    <Pill testID="capture-entry-ask-new" label={newLabel} onPress={onNew} kind="warm" />
  </View>;
}

/**
 * `entryQuestion`: an entry page was opened while a chat of another kind is
 * still in progress (M3b SIM-5). The chat is kept, and the person is asked
 * whether to go on with it or start the one they came for.
 */
export function CaptureScreen({ entryQuestion }: { entryQuestion?: { entry: CaptureEntry; onAnswered: () => void } } = {}) {
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
  // «هيك فهمت» first (audit 2026-10-06 #5, #6): an answer that says what it
  // understood shows that summary, and its cards only once the person opens
  // them (`showsUnderstood`, keyed to the proposal in the reducer).
  const understood = showsUnderstood(state) && state.proposal ? summaryPoints(state.proposal) ?? null : null;
  // The line the refused change belongs to now, found by its point's id: the
  // current version may have moved it, or dropped it (then nothing reopens).
  // A point keeps its id when its kind changes, so the id alone finds it.
  const refused = state.refusedEdit?.target;
  const refusedId = refused ? familyIdOf(refused) : null;
  const refusedLine = refusedId && understood
    ? understood.findIndex((point) => familyIdOfLine(point) === refusedId) + 1
    : 0;
  const cardsOpen = reviewing && understood === null;
  /** The cards came from the summary: Back returns to it, not to the composer. */
  const fromSummary = cardsOpen && state.proposal !== null && state.reviewOf === state.proposal.proposalId
    && usableUnderstood(state.proposal) !== undefined;
  // The card a tapped line asked for, for that proposal only: a later answer
  // never inherits it (M2A-REV-004).
  const [revealRequest, setRevealRequest] = useState<{ key: number; id: string; proposalId: string } | null>(null);
  const revealRow = revealRequest && revealRequest.proposalId === state.proposal?.proposalId ? revealRequest : null;
  const seedAnchors = useRef(new Map<string, { target: View | null; focus: View | null }>());
  const anchorSeed = (seedItemId: string, part: 'card' | 'focus', node: View | null) => {
    const current = seedAnchors.current.get(seedItemId) ?? { target: null, focus: null };
    seedAnchors.current.set(seedItemId, part === 'card' ? { ...current, target: node } : { ...current, focus: node });
  };
  const openFromSummary = (target: UnderstoodTarget | null) => {
    flow.acceptUnderstood();
    const proposalId = state.proposal?.proposalId;
    setRevealRequest(target === null || !proposalId ? null
      : { key: Date.now(), id: familyIdOf(target), proposalId });
  };
  // A habit answered «موعد ثابت» comes back as a commitment card: once it is
  // there, the screen reader is taken to it, since the habit card it was on
  // is gone (M3B-A-R2-005). Found by its point id, which the conversion keeps.
  const becameCommitment = useRef<string | null>(null);
  useEffect(() => {
    const pointId = becameCommitment.current;
    if (!pointId || !state.proposal) return;
    const item = state.proposal.items.find((candidate) => candidate.pointId === pointId);
    if (!item) return;
    becameCommitment.current = null;
    setRevealRequest({ key: Date.now(), id: item.itemId, proposalId: state.proposal.proposalId });
  }, [state.proposal]);
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
  /** «عدّل» on line n of the summary (M2b), and what the last edit came to. */
  const [summaryEditing, setSummaryEditing] = useState<number | null>(null);
  // Whether a «possible goal» can become a goal here: goals are offered only where memory is writable.
  const captureKinds = useCaptureKinds();
  const [editNote, setEditNote] = useState<'changed' | 'ended' | 'failed' | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  /** The refused change opened again in the sheet (it lives in `state.refusedEdit` until then). */
  const [draftToReopen, setDraftToReopen] = useState<Parameters<typeof flow.editPoint>[1] | undefined>(undefined);
  /** Each «عدّل», and the one to give the screen reader back to when its sheet closes. */
  const editRefs = useRef(new Map<number, View>());
  const returnFocusTo = useRef<number | null>(null);
  /** One structured change to the summary, through the chat (M2b). */
  const sendEdit = async (target: PointTarget, change: Parameters<typeof flow.editPoint>[1]) => {
    if (editBusy) return;
    setEditBusy(true);
    setEditNote(null);
    const outcome = await flow.editPoint(target, change);
    setEditBusy(false);
    // Nothing was sent (another write held the proposal): the sheet and its
    // values stay, to save again (M2B-A-R4-REVIEW-001).
    if (!outcome.ok && outcome.reason === 'unavailable') return;
    closeSummaryEdit();
    // A refused change is not lost: the provider keeps it on its point
    // (`state.refusedEdit`), to be opened again over the current version.
    // Already saved elsewhere says so in its own line (`capture-confirmed-elsewhere`).
    if (!outcome.ok && outcome.reason !== 'unavailable' && outcome.reason !== 'confirmed') setEditNote(outcome.reason);
  };
  const closeSummaryEdit = () => {
    returnFocusTo.current = summaryEditing;
    setSummaryEditing(null);
    setDraftToReopen(undefined);
  };
  // Back to the «عدّل» the sheet came from, for a screen reader (criterion 6).
  useEffect(() => {
    if (summaryEditing !== null || returnFocusTo.current === null) return;
    const control = editRefs.current.get(returnFocusTo.current);
    returnFocusTo.current = null;
    if (control) AccessibilityInfo.sendAccessibilityEvent(control, 'focus');
  });
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
  const onDictationStart = () => { dictationEnabled.current = true; dictationBase.current = latestText.current; flow.dictationStarted(); };
  // Leaving this screen (another account, a closed capture) ends the dictation
  // here: a recogniser answering afterwards writes into nothing (M2b).
  useEffect(() => () => { dictationEnabled.current = false; }, []);
  const onDictated = (spoken: string) => { if (dictationEnabled.current) flow.dictate(appendDictation(dictationBase.current, spoken), false); };
  /**
   * The dictation's end: its words, and the recogniser's other readings of the
   * whole draft (what was in the field before it, plus each), offered as
   * «أو قصدك» chips. Only what is in the field is ever sent (M2b).
   */
  const onDictationDone = (spoken: string, alternatives: readonly string[] = []) => {
    if (!dictationEnabled.current) return;
    const base = dictationBase.current;
    flow.dictate(appendDictation(base, spoken), true, alternatives.map((alternative) => appendDictation(base, alternative)));
  };
  const stopDictation = () => { dictationEnabled.current = false; void speech.cancel?.(); setVoiceEpoch(epoch => epoch + 1); };
  /** «إلغاء» while listening: the dictation ends and the field holds what it held before it. */
  const cancelDictation = () => { const before = dictationBase.current; stopDictation(); changeText(before); };
  const strings = t as unknown as Record<string, string>;
  const items = cardsOpen ? state.proposal?.items ?? [] : [];
  const confirmable = confirmableItems(state.proposal, state.edits);
  // The one question is answerable under the summary too: the reply asks it
  // («الصبح ولا المسا؟»), so its quick replies sit right under that reply,
  // not behind «هيك صح» (M2a combined review F1).
  const questioned = reviewing ? state.proposal?.items ?? [] : [];
  const unclarified = questioned.filter(item => item.needsClarification && !confirmable.includes(item.itemId));
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
  // Not while the entry question has the page: the chat is not showing, and
  // its last reply would be spoken over the question. It is said once the
  // person goes on with that chat.
  useAnnounceOnIos(!entryQuestion && newest?.role === 'assistant' ? (newest.tail ? `${newest.text}\n\n${newest.tail}` : newest.text) : null);
  const [disclosureOpen, setDisclosureOpen] = useState(true);
  const [undoing, setUndoing] = useState(false);
  const undoLast = () => {
    if (undoing) return;
    setUndoing(true);
    void flow.undo().finally(() => setUndoing(false));
  };

  const leave = () => { setDiscarding(null); flow.close(); actions.closeCapture(); };
  /**
   * Back from the chat (M2b, condition 9): capture closes, and everything —
   * the conversation, the summary, the draft — is still there when «احكيها»
   * opens again. Only «ابدأ من جديد» and «إلغاء الكل» throw it away.
   */
  const closeKeeping = () => { setDiscarding(null); stopDictation(); actions.closeCapture(); };
  /** «خلصت» after a save: where the saved screen's OK went, to the day the things are on. */
  const done = () => { stopDictation(); flow.close(); actions.go('today'); };
  const back = () => { setDiscarding(null); setEditingId(null); setToolsOpen(false); flow.backToComposer(); };
  const restart = () => { setDiscarding(null); setEditingId(null); setToolsOpen(false); setMenuOpen(false); stopDictation(); flow.startOver(); };
  /** «ابدأ جديدة» from an entry page: this chat goes, the new one starts on that page's line. */
  const startEntryChat = () => {
    if (!entryQuestion) return;
    restart();
    flow.changeEntry(entryQuestion.entry);
    entryQuestion.onAnswered();
  };
  const discardsSomething = () => wantsDiscardConfirmation(state);
  /**
   * The explicit exit, «إلغاء الكل»: it throws the conversation away, so it
   * always asks first when there is anything to lose — a conversation, saved
   * lines, a proposal or a draft (M2b) — not only after hand edits.
   */
  const requestClose = () => {
    if (state.status === 'confirming') return;
    if (hasConversation) setDiscarding('close');
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
    if (!composerText.trim() || inputLength > MAX_CAPTURE_LENGTH || busy || answering || flow.writing) return;
    stopDictation();
    Keyboard.dismiss();
    setSentAt(new Date());
    setSkipped([]);
    setClarifyError(null);
    setEditingId(null);
    setRevealRequest(null);
    setEditNote(null);
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
    const busyHere = shown.instant && weekly !== 'weekly' ? busyDuring(shown.instant, shown.end, conflictBlocks) : [];
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
  // Asked before anything else on the page: which chat this is going to be.
  if (entryQuestion) bodyOverride = <EntryQuestion title={t.xEntryOpenChatTitle} body={t.xEntryOpenChatBody}
    continueLabel={t.xEntryOpenChatContinue} newLabel={t.xEntryOpenChatNew}
    onContinue={() => { setMenuOpen(false); entryQuestion.onAnswered(); }} onNew={startEntryChat} />;
  else if (discarding) bodyOverride = <View style={{ gap: 16 }} testID="capture-discard">
    {/* Starting over is asked as what it is, not as «بدك تتجاهلها؟» (M2b design critique). */}
    <Txt size={22} weight={600}>{discarding === 'restart' ? t.chatStartOverTitle : t.captureDiscardTitle}</Txt>
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
  else if (summaryEditing !== null && understood && state.proposal && understood[summaryEditing - 1]) {
    const point = understood[summaryEditing - 1]!;
    const item = point.kind === 'commitment' ? state.proposal.items.find((candidate) => candidate.itemId === point.itemId) : undefined;
    const seed = 'seedItemId' in point ? state.proposal.seeds.find((candidate) => candidate.seedItemId === point.seedItemId) : undefined;
    const habit = 'habitItemId' in point ? (state.proposal.habits ?? []).find((candidate) => candidate.habitItemId === point.habitItemId) : undefined;
    const goal = 'goalItemId' in point ? (state.proposal.goals ?? []).find((candidate) => candidate.goalItemId === point.goalItemId) : undefined;
    const staged = item ? state.edits[item.itemId] : undefined;
    const stagedAt = staged?.localDateTime !== undefined
      ? (staged.localDateTime ? instantForLocalDateTime(staged.localDateTime, timezone)?.toISOString() ?? null : null)
      : item?.resolvedTime ?? null;
    const offered = { habit: state.proposal.habits !== undefined, goal: state.proposal.goals !== undefined && captureKinds.entries.includes('goal') };
    bodyOverride = <SummaryEditSheet key={summaryEditing} kind={point.kind} offered={offered} timedSeed={Boolean(seed?.suggestedTime)} busy={editBusy || flow.writing}
      text={staged?.title ?? item?.title ?? seed?.summary ?? habit?.title ?? goal?.title ?? point.text} at={stagedAt}
      {...(draftToReopen ? { draft: draftToReopen } : {})}
      onCancel={closeSummaryEdit}
      onSave={(change) => { void sendEdit(understoodKeyOf(point).target, change); }} />;
  }
  else if (menuOpen) bodyOverride = <View style={{ gap: 14 }} testID="chat-menu">
    <Pill testID="chat-menu-paste" label={t.capturePaste} onPress={() => { setMenuOpen(false); void readClipboardText().then(setClipboard); }} />
    {cardsOpen ? <Pill testID="chat-menu-review-tools" label={t.chatReviewTools} kind="soft"
      onPress={() => { setMenuOpen(false); setToolsOpen(true); }} /> : null}
    {/* A new conversation, on purpose: the assistant forgets this one. */}
    {hasConversation ? <Pill testID="chat-menu-start-over" label={t.chatStartOver} kind="soft"
      onPress={() => { setMenuOpen(false); setDiscarding('restart'); }} /> : null}
    <Pill testID="chat-menu-close" label={t.close} onPress={() => setMenuOpen(false)} kind="ghost" />
  </View>;
  else if (state.status === 'noCommitment') bodyOverride = <NothingFound line={noCommitmentLine(state.proposal?.noCommitmentReason, strings)} onClose={leave} />;
  else if (failed) bodyOverride = <Failed status={failed} messageKey={state.messageKey}
    onRetry={() => { setSentAt(new Date()); void flow.analyze(); }} onBack={flow.dismissFailure} />;

  // The one question's quick replies sit under the reply that asks it, above
  // the cards (Stitch 03b); answering is still `/capture/clarify`.
  const clarification = reviewing && asking ? <ClarifySheet key={asking.itemId} item={asking} position={unclarified.length - waiting.length + 1}
    total={unclarified.length} busy={answering || flow.writing} error={clarifyError?.itemId === asking.itemId ? t[clarifyError.key] : null}
    onAnswer={value => { void answer(asking.itemId, value); }} onSkip={() => {
      const noTime = asking.clarification?.options.find(option => !option.value.localTime && !option.value.localDate);
      if (noTime) void answer(asking.itemId, { optionId: noTime.optionId });
      else setSkipped(current => [...current, asking.itemId]);
    }} /> : null;
  // M3b: a refusal the person can act on — «الأهداف مش مفعّلة هلّق» with
  // «شيل الهدف واحفظ الباقي», and so on (R2-010, R3-007) — never the generic line.
  const refusal = state.status === 'confirmFailed' ? M3B_REFUSALS[state.errorReason ?? ''] : undefined;
  // VoiceOver has no live regions: the refusal is said when it appears (DESIGN-M3b a11y 4).
  useAnnounceOnIos(refusal ? t[refusal.message] : null);
  const thoughtEntry = state.proposal?.entry === 'thought';
  const reviewExtras = cardsOpen ? <View style={{ gap: 10 }}>
    {state.reviewNotice ? <Txt testID="review-conflict-note" color={p.wm}>{t.captureProposalChanged}</Txt> : null}
    {/* Always mounted, so a screen reader hears the refusal arrive (live-region census). */}
    <LiveRegion alert>{refusal ? <View testID="capture-confirm-refused" style={{ gap: 8, alignItems: 'flex-start' }}>
      <Txt color={p.wm}>{t[refusal.message]}</Txt>
      {refusal.action ? <Pill testID="capture-confirm-refused-action" label={t[refusal.action.label]} kind="outline" size={14} pad={10}
        onPress={() => { if (refusal.action?.drop) flow.dropFamilies(refusal.action.drop); }} /> : null}
    </View> : null}</LiveRegion>
    {!refusal && state.status === 'confirmFailed' ? <Txt testID="review-confirm-failed" color={p.wm}>{t[state.messageKey ?? 'errorsGeneric']}</Txt> : null}
    {selectedCount(state) === 0 && items.length ? <Txt size={13} testID="review-none-selected" color={p.mu}>{t.reviewNothingSelected}</Txt> : null}
    {(state.proposal?.habits ?? []).map((habit) => <HabitProposalCard key={habit.pointId} habit={habit}
      selected={pointSelected(state, habit.pointId)} onToggle={() => flow.togglePoint(habit.pointId)}
      busy={editBusy || flow.writing} reask={state.status === 'confirmFailed' && state.errorReason === 'habit_invalid'}
      onAnswer={(change) => {
        becameCommitment.current = change.kind === 'commitment' ? habit.pointId : null;
        void sendEdit({ habitItemId: habit.habitItemId }, change);
      }} />)}
    {(state.proposal?.goals ?? []).map((goal) => <GoalProposalCard key={goal.pointId} goal={goal}
      selected={pointSelected(state, goal.pointId)} onToggle={() => flow.togglePoint(goal.pointId)} />)}
    {thoughtEntry ? state.proposal!.seeds.map((seed) => <ThoughtProposalCard key={seed.seedItemId} seed={seed}
      selected={pointSelected(state, seed.pointId ?? seed.seedItemId)} onToggle={() => flow.togglePoint(seed.pointId ?? seed.seedItemId)}
      busy={editBusy || flow.writing} onMakeCommitment={() => { void sendEdit({ seedItemId: seed.seedItemId }, { kind: 'commitment' }); }} />)
      : state.proposal?.seeds?.length ? <SeedProposalSection proposalId={state.proposal.proposalId} seeds={state.proposal.seeds} onAnchor={anchorSeed}
      {...(state.proposal.revision !== undefined ? { revision: state.proposal.revision } : {})} onProposalChanged={flow.adoptCurrent}
      writing={flow.writing} guardWrite={flow.guardWrite}
      renderAction={(seed) => <SeedCommitAction seed={seed} busy={editBusy || flow.writing}
        onPress={() => { void sendEdit({ seedItemId: seed.seedItemId }, { kind: 'commitment' }); }} />} /> : null}
  </View> : null;
  // Under the save (Stitch 03): every review option, the propose-only note,
  // and the explicit exit.
  const reviewFooter = cardsOpen ? <>
    <Pill testID="review-tools" label={t.chatReviewTools} onPress={() => setToolsOpen(true)} disabled={state.status === 'confirming'} kind="ghost" size={13} weight={500} pad={10} />
    <Txt size={13} color={p.mu} align="center" testID="review-note">{t.suggestionNote}</Txt>
    <Pill testID="review-cancel" label={t.cancelAll} onPress={requestClose} disabled={state.status === 'confirming'} kind="ghost" size={13} pad={10} />
  </> : null;
  // After a save the person stays in the chat: Undo for the last save while
  // its window is open — what the saved screen offered — and «خلصت», inside
  // the saved line when it is the newest thing said, under the chat otherwise.
  // What the last save wrote of the other families (M3b, R3-004): each opens
  // its own page, where it can be changed or removed — Undo takes back
  // commitments only, so it is not offered when one of these was saved.
  const lastSaved = [...state.earlier].reverse().find((entry): entry is ChatSavedNote => entry.kind === 'saved');
  const savedFamilies = lastSaved && (lastSaved.habitsSaved?.length || lastSaved.goalsSaved?.length || lastSaved.seedsSaved?.length)
    ? <View testID="capture-saved" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {(lastSaved.habitsSaved ?? []).map((habit) => <Pill key={habit.habitId} testID={`capture-saved-open-habit-${habit.habitId}`}
        label={t.xOpenHabit} accessibilityLabel={fill(t.xOpenSubjectLabel, { action: t.xOpenHabit, title: habit.title })}
        onPress={() => actions.go('habitDetail')} kind="soft" size={13} pad={10} radius={12} />)}
      {(lastSaved.goalsSaved ?? []).map((goal) => <SavedGoalActions key={goal.goalId} goalId={goal.goalId} title={goal.title} />)}
      {(lastSaved.seedsSaved?.length ?? 0) > 0 ? <Pill testID="capture-saved-open-thoughts" label={t.xOpenThoughts}
        onPress={() => actions.go('seeds')} kind="soft" size={13} pad={10} radius={12} /> : null}
    </View> : null;
  const savedActions = !reviewing && saves > 0 && state.status !== 'analyzing' ? <>
    {savedFamilies}
    {state.undoable && state.persisted.length > 0 ? <Pill testID="chat-saved-undo" label={t.undo} onPress={undoLast} disabled={undoing} kind="soft" size={13} pad={10} radius={12} style={{ minWidth: 88 }} /> : null}
    <Pill testID="chat-done" label={t.chatDone} onPress={done} kind="soft" size={13} pad={10} radius={12} style={{ minWidth: 88 }} />
  </> : null;
  const savedIsNewest = savedActions !== null && state.turns.length === 0 && state.earlier.length > 0
    && state.earlier[state.earlier.length - 1]!.kind === 'saved';
  if (savedIsNewest) {
    const last = earlier[earlier.length - 1]!;
    earlier[earlier.length - 1] = { ...last, actions: <View testID="chat-saved-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{savedActions}</View> };
  }
  const confirmedElsewhereLine = state.confirmedElsewhere
    ? <Txt size={13} color={p.mu} testID="capture-confirmed-elsewhere">{t.captureConfirmedElsewhere}</Txt> : null;
  const afterChat = cardsOpen ? reviewExtras : reviewing ? null : confirmedElsewhereLine && !savedActions ? confirmedElsewhereLine : savedActions && !savedIsNewest
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
  // Which sheet is showing, in the order the chain above picks it: the page
  // starts each one at its top (M2B-A-R5-REVIEW-002).
  const overlayKey = bodyOverride == null ? null
    : entryQuestion ? 'entry-ask' : discarding ? `discard-${discarding}` : clipboard ? 'clipboard' : editingId ? `card-${editingId}`
      : summaryEditing !== null ? `summary-${summaryEditing}` : menuOpen ? 'menu' : `status-${state.status}`;
  // The summary is the newest reply's: its words, then the numbered lines, then «هيك صح».
  if (understood && state.proposal && state.status !== 'analyzing' && history.length > 0 && history[history.length - 1]!.role === 'assistant') {
    const last = history[history.length - 1]!;
    history[history.length - 1] = { ...last,
      body: <View style={{ alignSelf: 'stretch', gap: 6 }}>
        <UnderstoodMessage proposal={state.proposal} points={understood} edits={state.edits} onOpen={openFromSummary}
          editable={state.proposal.revision !== undefined} busy={editBusy || flow.writing}
          onEdit={(n) => { setEditNote(null); setSummaryEditing(n); }}
          editRef={(n, node) => { if (node) editRefs.current.set(n, node); else editRefs.current.delete(n); }}
          onRejectCorrection={(itemId, correctionId) => { void sendEdit({ itemId }, { rejectCorrectionIds: [correctionId] }); }}
          onRestore={(target) => { void sendEdit(target, { restore: true }); }} />
        {editNote || refusedLine ? <Txt size={13} color={p.wm} testID="understood-edit-note">
          {editNote === 'ended' ? t.understoodEditEnded : editNote === 'failed' ? t.errorsGeneric : t.captureProposalChanged}
        </Txt> : null}
        {refusedLine && state.refusedEdit ? <Pill testID="understood-edit-reopen" label={t.understoodEditReopen} kind="soft" size={13} pad={10} disabled={flow.writing}
          style={{ alignSelf: 'flex-start' }}
          onPress={() => { setDraftToReopen(state.refusedEdit!.change); setSummaryEditing(refusedLine); flow.takeRefusedEdit(); setEditNote(null); }} /> : null}
      </View>,
      // Nothing to confirm when only removed points are left (contract v5).
      actions: understood.length > 0 ? <Pill testID="understood-confirm" label={t.understoodConfirm} onPress={() => openFromSummary(null)} size={15} pad={12} style={{ minWidth: 120 }} /> : undefined };
  }
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
    // Back from the question is the safe answer: the open chat stays.
    if (entryQuestion) entryQuestion.onAnswered();
    else if (editingId) setEditingId(null);
    else if (clipboard) setClipboard(null);
    else if (menuOpen) setMenuOpen(false);
    else if (discarding) setDiscarding(null);
    // The same way out as «إلغاء»: the reopened draft goes, focus goes back (M2B-A-R2-REVIEW-007).
    else if (summaryEditing !== null) closeSummaryEdit();
    else if (fromSummary) { setRevealRequest(null); setToolsOpen(false); flow.reopenUnderstood(); }
    // Cards with no summary (an older server, a share's review): back to the composer, as before.
    // Cards with no summary in the chat (an older server) close and keep too;
    // a share's or a meeting's review (no conversation) goes back as before.
    else if (reviewing && !understood) { if (state.conversationId !== null) closeKeeping(); else requestBack(); }
    else closeKeeping();
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
  useEffect(() => { hardwareBack.current = toolsOpen && cardsOpen ? () => setToolsOpen(false) : headerBack; });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { hardwareBack.current(); return true; });
    return () => sub.remove();
  }, []);

  if (toolsOpen && cardsOpen) return <ReviewScreen onBackToChat={() => setToolsOpen(false)} />;
  // The shell owns the safe-area top (screenShellCensus); the chat header sits
  // below it on the chat palette's background.
  return <Screen style={{ backgroundColor: p.bg }}><SpeechEventBridge />
    <AvoidKeyboard testID="capture-kav" style={{ flex: 1 }}>
      <SayItChatPage colors={p} fonts={{ regular: family(400, script), semibold: family(600, script), latin: family(400, 'latin'), lineRatio: LINE_HEIGHT[script],
        forText: (value, weight) => { const run = scriptOfText(value, script); return { fontFamily: family(weight === 'semibold' ? 600 : 400, run), lineRatio: LINE_HEIGHT[run] }; } }}
        copy={{ title: t.captureTitle, subtitle: t.chatSubtitle, placeholder: t.chatPlaceholder,
          // Back, never «إلغاء»: it closes capture and keeps the conversation (M2b).
          closeLabel: t.back, moreLabel: t.chatOptions, pasteLabel: t.capturePaste, sendLabel: t.chatSend,
          // The save says what it saves, by count and plural-safe (ICU, as
          // confirmN): «احفظ الاتنين», «احفظ وحدة», nothing when none is ticked.
          confirmLabel: tr('chatSaveN', { n: selectedCount(state) }), editLabel: t.reviewEdit, includeLabel: t.chatWillSave,
          proposalsTitle: fill(t.chatProposedN, { n: items.length }),
          listeningTitle: t.chatListening, listeningNote: t.voiceListening, cancelListeningLabel: t.cancel }}
        text={composerText} onChangeText={changeText} onSend={send}
        // One proposal writer at a time: a «مش هيك» on its way is one too (M2B-A-R2-REVIEW-005).
        canSend={Boolean(composerText.trim()) && inputLength <= MAX_CAPTURE_LENGTH && !busy && !answering && !flow.writing}
        inputDisabled={state.status === 'confirming' || answering}
        composerDisabled={state.status === 'analyzing'}
        // While the entry question is up, nothing else on the page opens under it (inspection FU-005).
        toolsDisabled={flow.writing || entryQuestion !== undefined}
        onClose={headerBack} onMore={() => { if (!busy && !answering && !flow.writing && !entryQuestion) setMenuOpen(true); }}
        onPaste={() => { if (!busy && !answering && !flow.writing) void readClipboardText().then(setClipboard); }}
        // The entry the chat was opened from sets its first line (M3b, COPY-M3b 2).
        assistant={{ text: state.entry === 'goal' ? t.xChatOpenGoal : state.entry === 'habit' ? t.xChatOpenHabit
          : state.entry === 'thought' ? t.xChatOpenThought : t.chatWelcome }}
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
        onConfirm={() => { stopDictation(); Keyboard.dismiss(); void flow.confirm(); }} canConfirm={selectedCount(state) > 0 && !busy && !answering && !flow.writing} confirming={state.status === 'confirming'}
        confirmWithoutRows={cardsOpen && items.length === 0
          && confirmableHabits(state.proposal).length + confirmableGoals(state.proposal).length + confirmableThoughts(state.proposal).length > 0}
        quickActions={reviewing || state.text.trim() || state.turns.length > 0 || state.earlier.length > 0 || state.status === 'analyzing' ? []
          : COMPOSER_EXAMPLE_KEYS.map(key => ({ id: `example-${key}`, label: exampleText(key, t) }))}
        onQuickAction={quickAction} rtl={rtl} safeBottom={insets.bottom} keyboardShown={keyboardShown} mode={mode} listening={voiceStatus === 'listening'}
        bodyOverride={bodyOverride} bodyKey={overlayKey} clarification={clarification} reviewExtras={afterChat} reviewFooter={reviewFooter} languageControl={language}
        onCancelListening={cancelDictation}
        // After a save the field is NOT focused (audit 2026-10-03 #8): the
        // keyboard it raised hid the line saying what was saved. The person
        // taps the field when they have the next thing to say.
        // A new proposal scrolls its confirm into view above the composer.
        revealConfirmKey={cardsOpen && !revealRow ? state.proposal?.proposalId ?? null : null}
        reviewing={cardsOpen} revealRow={cardsOpen ? revealRow : null} revealAnchor={(id) => seedAnchors.current.get(id) ?? null}
        reduceMotion={reducedMotion}
        // While listening the panel above the field says so; the note line
        // keeps the other states (failed, no speech, denied → Settings).
        voiceNotice={<>{counter}{voiceStatus === 'listening' ? null : <VoiceNote status={voiceStatus} />}
          {state.alternatives.length > 0 && state.status !== 'analyzing' ? <AlternativeChips alternatives={state.alternatives} onChoose={flow.chooseAlternative} /> : null}</>}
        microphone={busy || answering || voiceStatus === 'unavailable' ? undefined : <VoiceButton key={voiceEpoch} service={speech} showNote={false} autoFocus={voiceEpoch === 0 && state.inputMode === 'voice'} onStart={onDictationStart}
          onStatusChange={setVoiceStatus} onPartial={onDictated} onFinal={onDictationDone}
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

/**
 * «أو قصدك: …» (M2b, condition 1): the recogniser's other readings of the
 * whole dictated draft, under the field before anything is sent. A tap puts
 * that reading in the field; nothing is sent until the person sends it.
 */
function AlternativeChips({ alternatives, onChoose }: { alternatives: readonly string[]; onChoose(text: string): void }) {
  const { t, p } = useApp();
  return <View testID="capture-alternatives" style={{ gap: 6, alignItems: 'flex-start' }}>
    <Txt size={13} color={p.mu}>{t.captureAlternativesTitle}</Txt>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {alternatives.map((alternative, index) => <Btn key={alternative} testID={`capture-alternative-${index + 1}`} label={alternative}
        onPress={() => onChoose(alternative)} scaleTo={0.97}
        style={{ minHeight: 44, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: p.lnStrong, backgroundColor: p.sf2, justifyContent: 'center' }}>
        <Txt size={14}>{alternative}</Txt>
      </Btn>)}
    </View>
  </View>;
}
