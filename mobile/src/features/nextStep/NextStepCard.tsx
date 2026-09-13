import React, { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useNextStep, useNextStepDecision } from '../../api/queries';
import { QueryBoundary } from '../../api/ui/QueryBoundary';
import { ConflictError } from '../../api/errors';
import { family } from '../../theme/fonts';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { evidencePhrases } from './evidence';
import { DEFER_PRESETS, postponeTo, type PostponePreset } from '../commitments/postpone';
import { useTimeZone } from '../../i18n/timezone';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import type { NextStepDecisionKind, NextStepRecommendation } from '../../api/schemas/nextStep';

/**
 * The one suggestion, and the five answers to it (UC-2.R3 #173, UC-2.9 #170).
 *
 * ── It is a suggestion, and it says so every time ────────────────
 *
 * `suggestionNote` — «هذا اقتراح. لم يتغيّر أي شيء بعد.» — is not decoration
 * and is not conditional. The contract says `persistence.occurred: false` and
 * `confirmationRequired: true` on every proposal; the line is that fact in
 * words, and a card that dropped it would be the product implying it had
 * already acted.
 *
 * ── Only the actions the server offered ──────────────────────────
 *
 * `availableActions` is the list, not a hint. Rendering a fixed row and
 * disabling the rest would show the user a control that this proposal has no
 * meaning for, and `decideNextStep` refuses one that is not in the list
 * anyway — so a button outside it can only ever fail.
 *
 * ── One tap is one decision ──────────────────────────────────────
 *
 * Each decision carries an `idempotencyKey` generated once per call. A second
 * tap while the first is in flight would generate a second key and so be a
 * second decision, which is why the guard is a ref rather than only
 * `isPending`: `isPending` is state, and two taps in the same frame both see
 * the old value.
 *
 * ── Quiet is not an empty day ────────────────────────────────────
 *
 * Inside the user's own quiet window, or with quiet mode on, the route answers
 * 200 with `exposure.allowed: false` and a placeholder `empty` recommendation
 * (#170). The card then renders nothing at all — not the empty state, which
 * would claim there is nothing to do, and not an error, which would report a
 * problem. The user asked not to be spoken to, so the product does not speak.
 *
 * ── A 409 is not an error to show ────────────────────────────────
 *
 * It means the commitments moved under the proposal. The card says so plainly
 * and shows the refetched one; it never resubmits, because applying a decision
 * the user made about a different suggestion is worse than asking again.
 */
export function NextStepCard() {
  const { t, p } = useApp();
  const query = useNextStep();
  const decide = useNextStepDecision();
  const [showWhy, setShowWhy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  const recommendation = query.data?.recommendation;
  const silenced = query.data?.exposure?.allowed === false;
  const strings = t as unknown as Record<string, string>;

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
        onError: (error) => { if (error instanceof ConflictError) setStale(true); },
        onSettled: () => { inFlight.current = false; setEditing(false); setDeferring(false); },
      },
    );
  };

  return (
    <QueryBoundary isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
      {recommendation && !silenced ? (
        <Card pad={18} style={{ gap: 12 }} testID="next-step-card">
          <Txt size={13} color={p.mu}>{t.nextStepLabel}</Txt>

          {stale ? <Txt size={13} color={p.wm} testID="next-step-stale">{t.nextStepStale}</Txt> : null}

          {recommendation.state === 'ready' && recommendation.primaryStep ? (
            <Ready
              recommendation={recommendation}
              strings={strings}
              showWhy={showWhy}
              onToggleWhy={() => setShowWhy(!showWhy)}
              editing={editing}
              onEdit={() => setEditing(true)}
              deferring={deferring}
              onDefer={() => setDeferring(true)}
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
        </Card>
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
  recommendation, strings, showWhy, onToggleWhy, editing, onEdit, deferring, onDefer, onSend, busy,
}: {
  recommendation: NextStepRecommendation;
  strings: Record<string, string>;
  showWhy: boolean;
  onToggleWhy: () => void;
  editing: boolean;
  onEdit: () => void;
  deferring: boolean;
  onDefer: () => void;
  onSend: (decision: NextStepDecisionKind, extra?: { editedTitle?: string; deferUntil?: string }) => void;
  busy: boolean;
}) {
  const { t, p, ar, lang } = useApp();
  const timezone = useTimeZone();
  const step = recommendation.primaryStep!;
  const [draft, setDraft] = useState(step.title);
  const phrases = evidencePhrases(recommendation.explanation?.evidenceCodes ?? [], strings);
  // The server's list, in the server's order, filtered to what this build can
  // render — never a fixed row with the rest greyed out.
  const actions = DECISIONS.filter((decision) => recommendation.availableActions?.includes(decision));

  return (
    <>
      <Txt size={19} weight={600} lh={1.4} testID="next-step-title">{step.title}</Txt>

      {/* Unconditional. See the header: the contract says nothing has been
          written, and this is that fact in words. */}
      <Txt size={12} color={p.mu} testID="next-step-note">{t.suggestionNote}</Txt>

      {phrases.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Btn testID="next-step-why-toggle" label={t.nextStepWhy} onPress={onToggleWhy} style={{ alignItems: 'flex-start', paddingVertical: 6 }}>
            <Txt size={13} weight={600} color={p.ac}>{t.nextStepWhy}</Txt>
          </Btn>
          {showWhy ? (
            <View style={{ gap: 4 }} testID="next-step-why">
              {phrases.map((phrase) => (
                <Txt key={phrase} size={13} color={p.mu}>{`· ${phrase}`}</Txt>
              ))}
              {/* The contract pins `sensitiveInferenceUsed` to false, so this
                  is a promise the app can keep rather than a status. */}
              <Txt size={12} color={p.mu} testID="next-step-no-sensitive">{t.nextStepNoSensitive}</Txt>
            </View>
          ) : null}
        </View>
      ) : null}

      {editing ? (
        <View style={{ gap: 10 }}>
          <Txt size={13} color={p.mu}>{t.nextStepEditTitle}</Txt>
          <TextInput
            testID="next-step-edit-input"
            value={draft}
            onChangeText={setDraft}
            multiline
            style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 56, color: p.tx, fontFamily: family(400, ar), textAlign: ar ? 'right' : 'left' }}
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
                  style={{ flexGrow: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, gap: 2, alignItems: 'flex-start', opacity: busy ? 0.4 : 1 }}
                >
                  <Txt size={14} weight={600}>{DEFER_LABEL(strings)[preset]}</Txt>
                  <Txt size={12} color={p.mu} testID={`next-step-defer-when-${preset}`}>
                    {`${formatRelativeDay(until, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(until, { locale: lang, timeZone: timezone }))}`}
                  </Txt>
                </Btn>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {actions.map((decision) => (
            <Pill
              key={decision}
              testID={`next-step-${decision}`}
              label={ACTION_LABEL(strings)[decision]}
              kind={decision === 'accept' ? 'accent' : 'outline'}
              size={14}
              pad={12}
              disabled={busy}
              onPress={() => {
                if (decision === 'edit') return onEdit();
                if (decision === 'defer') return onDefer();
                return onSend(decision);
              }}
            />
          ))}
        </View>
      )}
    </>
  );
}
