import React, { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLayoutMode } from '../../theme/textScale';
import { useApp } from '../../state/AppContext';
import { useNextStep, useNextStepDecision } from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { ConflictError } from '../../api/errors';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { Tag, TextLink } from '../../ui/chrome';
import { evidencePhrases } from './evidence';
import { FeedbackFlagButton } from './FeedbackFlagButton';
import { DEFER_PRESETS, postponeTo, type PostponePreset } from '../commitments/postpone';
import type { CommitmentView } from '../commitments/model';
import { useTimeZone } from '../../i18n/timezone';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import type { NextStepDecisionKind, NextStepRecommendation } from '../../api/schemas/nextStep';

/**
 * The one suggestion, and the answers to it (UC-2.R3 #173, UC-2.9 #170;
 * Round 2, Phase C for the shape).
 *
 * ── It is a suggestion, and it says so every time ────────────────
 *
 * `suggestionNote` — «هذا اقتراح. لم يتغيّر أي شيء بعد.» — is not decoration
 * and is not conditional. The contract says `persistence.occurred: false` and
 * `confirmationRequired: true` on every proposal; the line is that fact in
 * words. Round 2 adds the same fact as a *shape*: the card's edge is dashed in
 * the proposal colour until a decision is made, and a tag says «اقتراح».
 *
 * ── Only the actions the server offered ──────────────────────────
 *
 * `availableActions` is the list, not a hint. Round 2 arranges them — the
 * accept as the one accent button, defer beside it, and the rest folded
 * behind «المزيد» — but never adds one the server did not offer, and never
 * greys one out. A disclosed action is still only shown if offered.
 *
 * ── Started ──────────────────────────────────────────────────────
 *
 * Accepting records the decision on the server and, for this proposal, the
 * card changes shape: solid edge, a «بلّشت فيها» tag, and one button — done —
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
  const { t, p } = useApp();
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
            backgroundColor: p.sf, borderRadius: 24, padding: 22, gap: 14,
            borderWidth: 1.5, borderColor: started ? p.acs : p.prop, borderStyle: started ? 'solid' : 'dashed',
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <Txt size={13} weight={600} color={p.mu}>{t.nextStepLabel}</Txt>
            {recommendation.state === 'ready' ? (
              <Tag kind={started ? 'started' : 'proposal'} label={started ? t.nextStepTagStarted : t.nextStepTagProposal} testID="next-step-tag" />
            ) : null}
          </View>

          {stale ? <Txt size={13} color={p.wm} testID="next-step-stale">{t.nextStepStale}</Txt> : null}

          {recommendation.state === 'ready' && recommendation.primaryStep ? (
            <Ready
              recommendation={recommendation}
              item={lookup?.get(recommendation.primaryStep.commitmentId) ?? null}
              strings={strings}
              showWhy={showWhy}
              onToggleWhy={() => setShowWhy(!showWhy)}
              editing={editing}
              onEdit={() => setEditing(true)}
              deferring={deferring}
              onDefer={() => setDeferring(true)}
              more={more}
              onMore={() => setMore(!more)}
              started={started}
              onSend={send}
              busy={decide.isPending}
            />
          ) : (
            <View style={{ gap: 6 }} testID={`next-step-${recommendation.state}`}>
              <Txt size={17} weight={600}>
                {recommendation.state === 'empty' ? t.nextStepEmptyTitle : t.nextStepThinTitle}
              </Txt>
              <Txt size={14} color={p.mu} lh={1.5}>
                {recommendation.state === 'empty' ? t.nextStepEmptyBody : t.nextStepThinBody}
              </Txt>
            </View>
          )}
        </View>
      ) : null}
    </QueryBoundary>
  );
}

const ACTION_LABEL = (t: Record<string, string>): Record<NextStepDecisionKind, string> => ({
  accept: t.nextStepAccept!,
  edit: t.nextStepEdit!,
  defer: t.nextStepDefer!,
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

function Ready({
  recommendation, item, strings, showWhy, onToggleWhy, editing, onEdit, deferring, onDefer, more, onMore, started, onSend, busy,
}: {
  recommendation: NextStepRecommendation;
  item: CommitmentView | null;
  strings: Record<string, string>;
  showWhy: boolean;
  onToggleWhy: () => void;
  editing: boolean;
  onEdit: () => void;
  deferring: boolean;
  onDefer: () => void;
  more: boolean;
  onMore: () => void;
  started: boolean;
  onSend: (decision: NextStepDecisionKind, extra?: { editedTitle?: string; deferUntil?: string }) => void;
  busy: boolean;
}) {
  const stacked = useLayoutMode() !== 'normal';
  const { t, p, rtl, script, lang, actions } = useApp();
  const timezone = useTimeZone();
  const step = recommendation.primaryStep!;
  const [draft, setDraft] = useState(step.title);
  const phrases = evidencePhrases(recommendation.explanation?.evidenceCodes ?? [], strings);
  // The server's list, in the server's order, filtered to what this build can
  // render — never a fixed row with the rest greyed out.
  const actionsOffered = DECISIONS.filter((decision) => recommendation.availableActions?.includes(decision));
  const offers = (d: NextStepDecisionKind) => actionsOffered.includes(d);
  const folded = actionsOffered.filter((d) => d !== 'accept' && d !== 'defer');
  const when = item?.shownAt ? ltr(formatTime(new Date(item.shownAt), { locale: lang, timeZone: timezone })) : null;
  const impLabel = item ? (item.importance === 'must' ? t.todayGroupMust : item.importance === 'should' ? t.todayGroupShould : t.todayGroupNice) : null;

  const run = (decision: NextStepDecisionKind) => {
    if (decision === 'edit') return onEdit();
    if (decision === 'defer') return onDefer();
    return onSend(decision);
  };

  return (
    <>
      <Btn label={step.title} onPress={() => actions.openDetail(step.commitmentId)} scaleTo={0.99} testID="next-step-open" style={{ alignItems: 'flex-start', gap: 4 }}>
        <Txt role="section" testID="next-step-title">{step.title}</Txt>
        {item ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Txt size={14} color={p.mu} latin testID="next-step-when">{when ?? t.noTimeYet}</Txt>
            {impLabel ? <Txt size={14} color={p.mu}>·</Txt> : null}
            {impLabel ? <Tag kind={item.importance === 'must' ? 'must' : 'should'} label={impLabel} /> : null}
          </View>
        ) : null}
      </Btn>

      {/* Unconditional. See the header: the contract says nothing has been
          written, and this is that fact in words. */}
      <Txt size={12} color={p.mu} testID="next-step-note">{t.suggestionNote}</Txt>

      {phrases.length > 0 || (item && !item.importanceIsStated) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} testID="next-step-evidence">
          {phrases.map((phrase) => <Tag key={phrase} kind="muted" label={phrase} />)}
          {item && !item.importanceIsStated ? <Tag kind="estimated" label={t.nextStepEvidenceEstimated} /> : null}
        </View>
      ) : null}

      {phrases.length > 0 ? (
        <View style={{ gap: 6 }}>
          <TextLink testID="next-step-why-toggle" label={t.nextStepWhy} onPress={onToggleWhy} size={13} />
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

      {editing ? (
        <View style={{ gap: 10 }}>
          <Txt size={13} color={p.mu}>{t.nextStepEditTitle}</Txt>
          <TextInput
            testID="next-step-edit-input"
            value={draft}
            onChangeText={setDraft}
            multiline
            style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 56, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
          />
          <Pill
            testID="next-step-edit-save"
            label={t.nextStepEditSave}
            disabled={busy || draft.trim().length === 0}
            onPress={() => onSend('edit', { editedTitle: draft.trim() })}
          />
        </View>
      ) : deferring ? (
        /**
         * Three choices, each showing the time it means (UC-2.9, #170).
         *
         * Fewer than the details sheet's four: deferring a *suggestion* is a
         * small "not right now", and offering to push it a week would turn one
         * tap into a decision about the rest of the month.
         */
        <View style={{ gap: 10 }}>
          <Txt size={13} color={p.mu}>{t.nextStepDeferTitle}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {DEFER_PRESETS.map((preset) => {
              const until = new Date(postponeTo(preset, new Date(), timezone));
              return (
                <Btn
                  key={preset}
                  testID={`next-step-defer-${preset}`}
                  label={DEFER_LABEL(strings)[preset]}
                  disabled={busy}
                  onPress={() => onSend('defer', { deferUntil: until.toISOString() })}
                  style={{ flexGrow: 1, backgroundColor: busy ? p.dis : p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, gap: 2, alignItems: 'flex-start' }}
                >
                  <Txt size={14} weight={600} color={busy ? p.disTx : p.tx}>{DEFER_LABEL(strings)[preset]}</Txt>
                  <Txt size={12} color={busy ? p.disTx : p.mu} testID={`next-step-defer-when-${preset}`}>
                    {`${formatRelativeDay(until, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(until, { locale: lang, timeZone: timezone }))}`}
                  </Txt>
                </Btn>
              );
            })}
          </View>
        </View>
      ) : started ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {offers('done') ? (
            <Pill testID="next-step-done" label={ACTION_LABEL(strings).done} size={14} pad={12} disabled={busy} onPress={() => run('done')} style={stacked ? undefined : { flex: 1 }} />
          ) : null}
          <Txt size={12} color={p.mu} lh={1.4} style={{ flex: 1 }} testID="next-step-started-note">{t.nextStepStartedNote}</Txt>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8, alignItems: 'stretch' }}>
            {offers('accept') ? (
              <Pill testID="next-step-accept" label={ACTION_LABEL(strings).accept} kind="accent" size={14} pad={12} disabled={busy} onPress={() => run('accept')} style={stacked ? undefined : { flex: 1 }} />
            ) : null}
            {offers('defer') ? (
              <Pill testID="next-step-defer" label={ACTION_LABEL(strings).defer} kind="soft" size={14} pad={12} disabled={busy} onPress={() => run('defer')} style={stacked ? undefined : { flex: 1 }} />
            ) : null}
            {folded.length > 0 ? (
              <Btn testID="next-step-more" accessibilityState={{ expanded: more }} label={t.nextStepMore} onPress={onMore}
                style={{ width: 48, minHeight: 48, borderRadius: 999, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
                <Txt size={18} weight={600} color={p.tx} latin>{more ? '×' : '…'}</Txt>
              </Btn>
            ) : null}
          </View>
          {more ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} testID="next-step-more-actions">
              {folded.map((decision) => (
                <Pill key={decision} testID={`next-step-${decision}`} label={ACTION_LABEL(strings)[decision]} kind="outline" size={14} pad={12} disabled={busy} onPress={() => run(decision)} />
              ))}
            </View>
          ) : null}
        </View>
      )}
    </>
  );
}
