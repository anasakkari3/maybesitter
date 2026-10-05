import React, { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLayoutMode } from '../../theme/textScale';
import { useApp } from '../../state/AppContext';
import { useNextStep, useNextStepDecision } from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { ConflictError } from '../../api/errors';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { Tag, TextLink, priorityTagKind } from '../../ui/chrome';
import { evidencePhrases } from './evidence';
import { FeedbackFlagButton } from './FeedbackFlagButton';
import { DEFER_PRESETS, postponeTo, type PostponePreset } from '../commitments/postpone';
import type { CommitmentView } from '../commitments/model';
import { useTimeZone } from '../../i18n/timezone';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import { drawnWhenLine, dueAsideText } from '../plan/savedPlacement';
import type { NextStepDecisionKind, NextStepRecommendation } from '../../api/schemas/nextStep';
import { ReferenceIcon, useReferencePalette } from '../../ui/referenceDesign';
import { BottomSheet, SheetChoice, SheetFootnote, SheetHeader } from '../../ui/bottomSheet';
import { canPrepareFor } from '../meetings/prepTargets';

/**
 * The one suggestion, and the answers to it (UC-2.R3 #173, UC-2.9 #170;
 * Round 2, Phase C for the shape).
 *
 * ── It is a suggestion, and it says so every time ────────────────
 *
 * `suggestionNote` — «هذا اقتراح. لم يتغيّر أي شيء بعد.» — is not decoration
 * and is not conditional. The contract says `persistence.occurred: false` and
 * `confirmationRequired: true` on every proposal; the line is that fact in
 * words. The reference card has no outline; the note communicates that it is
 * a proposal. There is no «اقتراح» tag as well: that said the note's words a
 * second time on the same card (#17).
 *
 * ── Only the actions the server offered ──────────────────────────
 *
 * `availableActions` is the list, not a hint. The Stitch card arranges them —
 * «بلّش فيها» (accept: started, never done) as the one accent button, then
 * «خلصتها» (done) and «مش هلّق» (defer, which asks when in a sheet), and the
 * rest folded behind «المزيد» — but never adds one the server did not offer,
 * and never greys one out. A disclosed action is still only shown if offered.
 *
 * ── Started ──────────────────────────────────────────────────────
 *
 * Accepting records the decision on the server and, for this proposal, the
 * card shows a «بلّشت فيها» tag and one button — done —
 * if the server offers it. The memory of "started" is this card's, keyed to
 * the proposal id; a new proposal starts fresh. The decision itself is in
 * the account's history either way.
 *
 * ── One tap is one decision ──────────────────────────────────────
 *
 * Each decision carries an `idempotencyKey` generated once per call. The
 * guard is a ref rather than only `isPending`: two taps in the same frame
 * both see the old state value.
 *
 * ── Quiet is not an empty day ────────────────────────────────────
 *
 * Inside the user's own quiet window, or with quiet mode on, the route answers
 * 200 with `exposure.allowed: false` (#170). Alone, the card renders nothing.
 * On Today, the screen says so in its own words (composeToday → `quiet`).
 *
 * ── A 409 is not an error to show ────────────────────────────────
 *
 * It means the commitments moved under the proposal. The card says so plainly
 * and shows the refetched one; it never resubmits.
 */
export function NextStepCard({ lookup }: {
  /** Today's items by id, so the card can show the time and importance of the thing it names. */
  lookup?: ReadonlyMap<string, CommitmentView> | undefined;
}) {
  const { t, tr } = useApp();
  const p = useReferencePalette();
  const compact = useLayoutMode() !== 'normal';
  const query = useNextStep();
  const decide = useNextStepDecision();
  const [showWhy, setShowWhy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [more, setMore] = useState(false);
  const [stale, setStale] = useState(false);
  const [startedProposal, setStartedProposal] = useState<string | null>(null);
  const inFlight = useRef(false);

  const recommendation = query.data?.recommendation;
  const silenced = query.data?.exposure?.allowed === false;
  const strings = t as unknown as Record<string, string>;
  const started = !!recommendation && startedProposal === recommendation.proposalId;

  const send = (
    decision: NextStepDecisionKind,
    extra: { editedTitle?: string; deferUntil?: string } = {},
  ) => {
    if (!recommendation || inFlight.current) return;
    inFlight.current = true;
    setStale(false);
    decide.mutate(
      { decision, proposal: recommendation, ...extra },
      {
        onSuccess: () => { if (decision === 'accept') setStartedProposal(recommendation.proposalId); },
        onError: (error) => { if (error instanceof ConflictError) setStale(true); },
        onSettled: () => { inFlight.current = false; setEditing(false); setDeferring(false); setMore(false); },
      },
    );
  };

  return (
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {recommendation && !silenced ? (
        <View
          testID="next-step-card"
          style={{
            gap: compact ? 9 : 12, padding: compact ? 14 : 18, borderRadius: compact ? 18 : 22, borderWidth: 1, borderColor: p.heroEdge, backgroundColor: p.sf,
            // The one card with a halo (Stitch): coral, soft, below it.
            shadowColor: p.ac, shadowOpacity: p.shadow ? 0.12 : 0.22, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 4,
          }}
        >
          {recommendation.state === 'ready' && recommendation.primaryStep ? (
            <Ready
              recommendation={recommendation}
              item={lookup?.get(recommendation.primaryStep.commitmentId) ?? null}
              strings={strings}
              translateCount={(key, values) => tr(key, values)}
              showWhy={showWhy}
              onToggleWhy={() => setShowWhy(!showWhy)}
              editing={editing}
              onEdit={() => setEditing(true)}
              deferring={deferring}
              onDefer={() => setDeferring(true)}
              onCloseDefer={() => setDeferring(false)}
              more={more}
              onMore={() => setMore(!more)}
              started={started}
              stale={stale}
              onSend={send}
              busy={decide.isPending}
            />
          ) : (
            <>
              <NextStepBadge />
              {stale ? <Txt size={13} color={p.wm} testID="next-step-stale">{t.nextStepStale}</Txt> : null}
              <View style={{ gap: 6 }} testID={`next-step-${recommendation.state}`}>
                <Txt size={17} weight={600}>
                  {recommendation.state === 'empty' ? t.nextStepEmptyTitle : t.nextStepThinTitle}
                </Txt>
                <Txt size={14} color={p.mu} lh={1.5}>
                  {recommendation.state === 'empty' ? t.nextStepEmptyBody : t.nextStepThinBody}
                </Txt>
              </View>
            </>
          )}
        </View>
      ) : null}
    </QueryBoundary>
  );
}

const ACTION_LABEL = (t: Record<string, string>): Record<NextStepDecisionKind, string> => ({
  accept: t.nextStepAccept!,
  edit: t.nextStepEdit!,
  // «مش هلّق» (Stitch), the same words a row's swipe uses; not «بعدين».
  defer: t.notNow!,
  dismiss: t.nextStepDismiss!,
  done: t.nextStepDone!,
});

const DECISIONS: readonly NextStepDecisionKind[] = ['accept', 'edit', 'defer', 'dismiss', 'done'];

const DEFER_LABEL = (t: Record<string, string>): Record<PostponePreset, string> => ({
  oneHour: t.postponeOneHour!,
  threeHours: t.postponeThreeHours!,
  thisEvening: t.postponeThisEvening!,
  tomorrowMorning: t.postponeTomorrowMorning!,
  nextWeek: t.postponeNextWeek!,
});

/** «خطوتك التالية», as the card's own chip: coral tint, a dot, the words. */
function NextStepBadge() {
  const { t } = useApp();
  const p = useReferencePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: p.acs, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 12 }}>
      <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.ac }} />
      <Txt size={13} weight={600} color={p.acd}>{t.nextStepLabel}</Txt>
    </View>
  );
}

function Ready({
  recommendation, item, strings, translateCount, showWhy, onToggleWhy, editing, onEdit, deferring, onDefer, onCloseDefer, more, onMore, started, stale, onSend, busy,
}: {
  recommendation: NextStepRecommendation;
  item: CommitmentView | null;
  strings: Record<string, string>;
  translateCount: (key: 'evidenceEffort', values: { minutes: number }) => string;
  showWhy: boolean;
  onToggleWhy: () => void;
  editing: boolean;
  onEdit: () => void;
  deferring: boolean;
  onDefer: () => void;
  onCloseDefer: () => void;
  more: boolean;
  onMore: () => void;
  started: boolean;
  stale: boolean;
  onSend: (decision: NextStepDecisionKind, extra?: { editedTitle?: string; deferUntil?: string }) => void;
  busy: boolean;
}) {
  const stacked = useLayoutMode() !== 'normal';
  const { t, rtl, script, lang, actions } = useApp();
  const p = useReferencePalette();
  const timezone = useTimeZone();
  const step = recommendation.primaryStep!;
  const [draft, setDraft] = useState(step.title);
  // An all-day item is late only once its day is over, by the phone's own
  // rule (`isPast`): «الوقت راح» on today's all-day appointment at 10:05 was
  // the server reading its midnight as a deadline (final UAT, N18).
  const evidence = (recommendation.explanation?.evidenceCodes ?? [])
    .filter((e) => !(e.code === 'overdue' && item?.allDay === true && !item.isPast));
  // When an event is, as the «حضّرني» sheet says it: «بكرا · 10:00».
  const formatWhen = (iso: string, allDay: boolean) => {
    const at = new Date(iso);
    const day = formatRelativeDay(at, { locale: lang, timeZone: timezone });
    return allDay ? day : `${day} · ${ltr(formatTime(at, { locale: lang, timeZone: timezone }))}`;
  };
  // The evening plan before the event is a question to the person, not a
  // reason chip (audit 2026-10-03 #2): it gets its own line, and stays in
  // «ليش هاي بالذات» with the rest.
  const chipEvidence = evidence.filter((e) => e.code !== 'evening_plan_before_event');
  const eveningItem = evidence.find((e) => e.code === 'evening_plan_before_event');
  const eveningNote = eveningItem ? evidencePhrases([eveningItem], strings, translateCount, formatWhen)[0] ?? null : null;
  const chips = evidencePhrases(chipEvidence, strings, translateCount, formatWhen);
  const phrases = evidencePhrases(evidence, strings, translateCount, formatWhen);
  // Preparation for an event (audit 2026-10-03 #2): the card names the
  // preparation, and «حضّرني» on it plans the time for it. The event's own
  // start comes with the reason, since a tomorrow's exam is not in `lookup`.
  const prepare = step.purpose === 'prepare';
  const eventAt = prepare ? evidence.find((e) => e.code === 'prepares_for_event')?.params : undefined;
  const prepTarget = prepare && eventAt?.at && eventAt.allDay !== true && canPrepareFor(eventAt.at, new Date())
    ? { startAt: eventAt.at, endAt: null, appointment: true as const, commitmentId: step.commitmentId }
    : null;
  // The server's list, in the server's order, filtered to what this build can
  // render — never a fixed row with the rest greyed out.
  const actionsOffered = DECISIONS.filter((decision) => recommendation.availableActions?.includes(decision));
  const offers = (d: NextStepDecisionKind) => actionsOffered.includes(d);
  // Up front (Stitch): «بلّش فيها», «خلصتها», «مش هلّق». The rest behind «المزيد».
  const folded = actionsOffered.filter((d) => d !== 'accept' && d !== 'defer' && d !== 'done');
  // Where a saved week day puts it, as Today's rows, the Calendar and Details
  // say it, with its own due beside it when that differs (FX1, review I1).
  // Its day as well, when that is not today — a due two weeks back read as
  // this morning beside «الوقت راح» (owner's Redmi, 2026-09-29).
  const when = item ? drawnWhenLine(item, lang, timezone) : null;
  const dueAside = item ? dueAsideText(item, t.plannedDueAside, lang, timezone) : null;
  const impLabel = item ? (item.importance === 'must' ? t.todayGroupMust : item.importance === 'should' ? t.todayGroupShould : t.todayGroupNice) : null;

  const run = (decision: NextStepDecisionKind) => {
    if (decision === 'edit') return onEdit();
    if (decision === 'defer') return onDefer();
    return onSend(decision);
  };

  const button = (kind: 'primary' | 'secondary' | 'tertiary') => ({
    ...(stacked ? {} : kind === 'primary' ? { flex: 1 } : {}),
    minHeight: 48, paddingVertical: 10, paddingHorizontal: kind === 'primary' ? 14 : 16, borderRadius: 999,
    flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 6,
    backgroundColor: busy ? p.dis : kind === 'primary' ? p.ac : p.sf2,
    borderWidth: kind === 'primary' ? 0 : 1, borderColor: p.ln,
  });

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <NextStepBadge />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 1 }}>
          {/* Started only. A proposal already says so in `suggestionNote`;
              a tag saying it again was #17's duplicate (UAT 2026-09-27). */}
          {started ? <Tag kind="started" label={t.nextStepTagStarted} testID="next-step-tag" /> : null}
          {impLabel && item ? <Tag kind={priorityTagKind(item.importance)} label={impLabel} /> : null}
          {item ? <Txt size={13} weight={500} color={p.mu} latin={!when?.dated} testID="next-step-when">{when?.text ?? t.noTimeYet}</Txt> : null}
        </View>
      </View>

      {stale ? <Txt size={13} color={p.wm} testID="next-step-stale">{t.nextStepStale}</Txt> : null}

      <Btn label={dueAside ? `${step.title}, ${dueAside}` : step.title} onPress={() => actions.openDetail(step.commitmentId)} scaleTo={0.99} testID="next-step-open" style={{ alignItems: 'flex-start', gap: 4 }}>
        <Txt role="section" size={stacked ? 17 : 20} weight={700} color={p.tx} lines={2} testID="next-step-title">{step.title}</Txt>
        {dueAside ? <Txt size={13} color={p.mu} testID="next-step-due">{dueAside}</Txt> : null}
      </Btn>

      {eveningNote ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }} testID="next-step-evening-note">
          <ReferenceIcon name="bulb" size={16} color={p.wm} />
          <Txt size={14} color={p.tx} lh={1.5} style={{ flex: 1 }}>{eveningNote}</Txt>
        </View>
      ) : null}

      {!stacked && (chips.length > 0 || (item && !item.importanceIsStated)) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} testID="next-step-evidence">
          {chips.map((phrase) => <Tag key={phrase} kind="muted" label={phrase} />)}
          {item && !item.importanceIsStated ? <Tag kind="estimated" label={t.nextStepEvidenceEstimated} /> : null}
        </View>
      ) : null}

      {editing ? (
        <View style={{ gap: 10 }}>
          <Txt size={13} color={p.mu}>{t.nextStepEditTitle}</Txt>
          <TextInput
            testID="next-step-edit-input"
            accessibilityLabel={t.nextStepEditTitle}
            value={draft}
            onChangeText={setDraft}
            multiline
            style={{ backgroundColor: p.sf2, borderRadius: 16, borderWidth: 1, borderColor: p.ln, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 56, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
          />
          <Pill
            testID="next-step-edit-save"
            label={t.nextStepEditSave}
            disabled={busy || draft.trim().length === 0}
            onPress={() => onSend('edit', { editedTitle: draft.trim() })}
          />
        </View>
      ) : started ? (
        <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: p.acs, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
            <ReferenceIcon name="play" size={16} color={p.acd} />
            <Txt size={14} weight={500} color={p.acd} lh={1.4} style={{ flex: 1 }} testID="next-step-started-note">{prepare ? (prepTarget ? t.nextStepPrepStartedNote : t.nextStepPrepStartedPlain) : t.nextStepStartedNote}</Txt>
          </View>
          {prepTarget ? (
            <Pill testID="next-step-prepare" label={t.xPrepare} kind="outline" size={15} pad={12} onPress={() => actions.openMeetingPrep(prepTarget)} />
          ) : null}
          {offers('done') ? (
            <Btn testID="next-step-done" label={ACTION_LABEL(strings).done} disabled={busy} onPress={() => run('done')} style={button('primary')}>
              <ReferenceIcon name="check" size={17} color={busy ? p.disTx : p.onAccent} />
              <Txt size={15} weight={600} color={busy ? p.disTx : p.onAccent} align="center">{ACTION_LABEL(strings).done}</Txt>
            </Btn>
          ) : null}
          {/* A started preparation is never a dead end (review of audit #2):
              «مش هلّق» and «مش هاي» stay, as the server offers them. */}
          {prepare && (offers('defer') || offers('dismiss')) ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {offers('defer') ? (
                <Btn testID="next-step-defer" label={ACTION_LABEL(strings).defer} disabled={busy} onPress={() => run('defer')}
                  style={{ ...button('tertiary'), flexGrow: 1, flexBasis: 120 }}>
                  <Txt size={14} weight={500} color={busy ? p.disTx : p.mu} align="center">{ACTION_LABEL(strings).defer}</Txt>
                </Btn>
              ) : null}
              {offers('dismiss') ? (
                <Btn testID="next-step-dismiss" label={ACTION_LABEL(strings).dismiss} disabled={busy} onPress={() => run('dismiss')}
                  style={{ ...button('tertiary'), flexGrow: 1, flexBasis: 120 }}>
                  <Txt size={14} weight={500} color={busy ? p.disTx : p.mu} align="center">{ACTION_LABEL(strings).dismiss}</Txt>
                </Btn>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 12 }}>
          {/* Two rows, never four buttons in one: at the owner's Redmi text
              size (1.17×) a single row squeezed «خلصتها» and «مش هلّق» until
              their labels broke letter by letter. The start action gets the
              full width; the answers share the row under it. */}
          {offers('accept') ? (
            <Btn testID="next-step-accept" label={ACTION_LABEL(strings).accept} disabled={busy} onPress={() => run('accept')}
              style={{ ...button('primary'), flex: undefined, alignSelf: 'stretch' }}>
              <ReferenceIcon name="play" size={16} color={busy ? p.disTx : p.onAccent} />
              <Txt size={15} weight={600} color={busy ? p.disTx : p.onAccent} align="center" style={{ flexShrink: 1 }}>{ACTION_LABEL(strings).accept}</Txt>
            </Btn>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {offers('done') ? (
              <Btn testID="next-step-done" label={ACTION_LABEL(strings).done} disabled={busy} onPress={() => run('done')}
                style={{ ...button('secondary'), flexGrow: 1, flexBasis: 120 }}>
                <Txt size={15} weight={600} color={busy ? p.disTx : p.tx} align="center">{ACTION_LABEL(strings).done}</Txt>
              </Btn>
            ) : null}
            {offers('defer') ? (
              <Btn testID="next-step-defer" label={ACTION_LABEL(strings).defer} disabled={busy} onPress={() => run('defer')}
                style={{ ...button('tertiary'), flexGrow: 1, flexBasis: 120 }}>
                <Txt size={14} weight={500} color={busy ? p.disTx : p.mu} align="center">{ACTION_LABEL(strings).defer}</Txt>
              </Btn>
            ) : null}
            {folded.length > 0 ? (
              <Btn testID="next-step-more" accessibilityState={{ expanded: more }} label={t.nextStepMore} onPress={onMore}
                style={{ width: 48, minHeight: 48, borderRadius: 999, backgroundColor: p.sf2, borderWidth: 1, borderColor: p.ln, alignItems: 'center', justifyContent: 'center' }}>
                <Txt size={18} weight={600} color={p.tx} latin>{more ? '×' : '…'}</Txt>
              </Btn>
            ) : null}
          </View>
          {/* Preparing has a planner of its own: «حضّرني» finds the time. */}
          {prepTarget ? (
            <Pill testID="next-step-prepare" label={t.xPrepare} kind="outline" size={15} pad={12} onPress={() => actions.openMeetingPrep(prepTarget)} />
          ) : null}
          {more ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} testID="next-step-more-actions">
              {folded.map((decision) => (
                <Pill key={decision} testID={`next-step-${decision}`} label={ACTION_LABEL(strings)[decision]} kind="outline" size={14} pad={12} disabled={busy} onPress={() => run(decision)} />
              ))}
            </View>
          ) : null}
        </View>
      )}

      {/* Unconditional. See the header: the contract says nothing has been
          written, and this is that fact in words. */}
      <Txt size={13} color={p.mu} align="center" testID="next-step-note">{t.suggestionNote}</Txt>

      {/*
        «مش هلّق» asks when, in a sheet (Stitch: «إمتى نرجّعها؟»). Three
        choices, each showing the time it means (UC-2.9, #170). Fewer than the
        details sheet's four: deferring a *suggestion* is a small "not right
        now", and offering to push it a week would turn one tap into a decision
        about the rest of the month.
      */}
      <BottomSheet visible={deferring} onClose={onCloseDefer} testID="next-step-defer-sheet">
        <SheetHeader title={t.nextStepDeferTitle} icon="clock" onClose={onCloseDefer} closeTestID="next-step-defer-close" />
        <Txt size={14} color={p.mu} lh={1.5}>{t.postponeBody}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {DEFER_PRESETS.map((preset) => {
            const until = new Date(postponeTo(preset, new Date(), timezone));
            return (
              <SheetChoice
                key={preset}
                testID={`next-step-defer-${preset}`}
                subTestID={`next-step-defer-when-${preset}`}
                label={DEFER_LABEL(strings)[preset]}
                sub={`${formatRelativeDay(until, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(until, { locale: lang, timeZone: timezone }))}`}
                disabled={busy}
                onPress={() => onSend('defer', { deferUntil: until.toISOString() })}
              />
            );
          })}
        </View>
        <SheetFootnote text={t.suggestionNote} />
      </BottomSheet>

      {phrases.length > 0 ? (
        <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 5 }}>
          <Btn testID="next-step-why-toggle" label={t.nextStepWhy} onPress={onToggleWhy} accessibilityState={{ expanded: showWhy }}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 7 }}>
            <ReferenceIcon name="bulb" size={20} color={p.mu} />
            <Txt size={14} color={p.tx} style={{ flex: 1 }}>{t.nextStepWhy}</Txt>
            <View style={{ transform: [{ rotate: showWhy ? '180deg' : '0deg' }] }}><ReferenceIcon name="chevron-down" size={18} color={p.mu} /></View>
          </Btn>
          {showWhy ? (
            <View style={{ gap: 6, backgroundColor: p.bg, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }} testID="next-step-why">
              {phrases.map((phrase) => (
                <Txt key={phrase} size={13} color={p.mu}>{`· ${phrase}`}</Txt>
              ))}
              {/* The contract pins `sensitiveInferenceUsed` to false, so this
                  is a promise the app can keep rather than a status. */}
              <Txt size={12} color={p.mu} testID="next-step-no-sensitive">{t.nextStepNoSensitive}</Txt>
              <TextLink label={t.nextStepKnows} onPress={() => actions.go('knows')} testID="next-step-knows" size={13} />
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Saying the suggestion was wrong (#173 step 4). Below the reasons,
          because it is a response to them. */}
      <FeedbackFlagButton
        proposalId={recommendation.proposalId}
        commitmentId={step.commitmentId}
      />

    </>
  );
}
