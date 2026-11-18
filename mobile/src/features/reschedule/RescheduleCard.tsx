import React from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import type { RescheduleProposal } from '../../api/schemas/reschedule';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { formatRelativeDay, formatTimeRange } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { useTimeZone } from '../../i18n/timezone';
import { useApp } from '../../state/AppContext';
import { Tag } from '../../ui/chrome';
import { Btn, Txt } from '../../ui/primitives';
import { ReferenceCard, useReferencePalette } from '../../ui/referenceDesign';
import { rescheduleLine } from './rescheduleLine';
import { useDecideReschedule, useReschedule } from './useReschedule';

type Session = RescheduleProposal['sessions'][number];

/**
 * Missed work's new plan on Today (lane E4; spec 2026-11-12 item 4, owner
 * answer of 2026-11-13).
 *
 * It says it is a suggestion twice over — the «اقتراح» tag and the product's
 * own line, «هذا اقتراح. لم يتغيّر أي شيء بعد.» — and nothing moves until
 * «اقبل». The line under the title is what changed and why, worded here from
 * the server's reason; the times are the server's, computed from free time,
 * never chosen by a model. Once accepted, the card turns into «انحطّت بوقتها
 * الجديد» with «رجّعها», for as long as the server keeps the undo open (24
 * hours). Off on the server, or failing, the card is not there at all.
 */
export function RescheduleCard() {
  const query = useReschedule();
  const decide = useDecideReschedule();
  const proposal = query.data?.proposal ?? null;
  const accepted = query.data?.accepted[0] ?? null;
  if (!proposal && !accepted) return null;
  return (
    <View style={{ gap: 10 }}>
      {accepted ? <AcceptedView item={accepted} decide={decide} /> : null}
      {proposal ? <ProposalView proposal={proposal} decide={decide} /> : null}
    </View>
  );
}

type Decide = ReturnType<typeof useDecideReschedule>;

function sessionText(session: Session, lang: ReturnType<typeof useApp>['lang'], timeZone: string): string {
  const day = formatRelativeDay(new Date(session.startsAt), { locale: lang, timeZone });
  const range = formatTimeRange(new Date(session.startsAt), new Date(session.endsAt), { locale: lang, timeZone });
  return `${isolateAuto(day)} · ${range}`;
}

function SessionLines({ sessions, testID }: { sessions: readonly Session[]; testID: string }) {
  const { lang, p } = useApp();
  const timeZone = useTimeZone();
  return (
    <View style={{ gap: 2 }}>
      {sessions.map((session, index) => (
        <Txt key={session.startsAt} size={15} weight={600} color={p.tx} testID={`${testID}-${index}`}>
          {sessionText(session, lang, timeZone)}
        </Txt>
      ))}
    </View>
  );
}

function ProposalView({ proposal, decide }: { proposal: RescheduleProposal; decide: Decide }) {
  const { t, actions, lang } = useApp();
  const p = useReferencePalette();
  const line = rescheduleLine(proposal, t);
  const timeZone = useTimeZone();
  const summary = [t.rsTag, proposal.title, line, ...proposal.sessions.map((session) => sessionText(session, lang, timeZone)), t.suggestionNote].join('. ');
  const busy = decide.isPending;
  const act = (action: 'accept' | 'dismiss') => decide.mutate(
    { commitmentId: proposal.commitmentId, action, ...(action === 'accept' ? { proposalId: proposal.proposalId } : {}) },
    {
      onSuccess: () => {
        if (action !== 'accept') return;
        actions.toast(t.rsAcceptedLine);
        // The toast is a live region, which TalkBack hears; VoiceOver has
        // none, so it is told here (the `useAnnounceOnIos` rule).
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(t.rsAcceptedLine);
      },
      onError: (error) => actions.toast(userFacingMessage(error, t)),
    },
  );
  return (
    <ReferenceCard pad={18} testID="reschedule-card">
      {/* One stop for a screen reader: what, why, when, and that it is only
          a suggestion; the two buttons stay their own stops. */}
      <View accessible accessibilityLabel={summary} testID="reschedule-summary" style={{ gap: 12 }}>
        <Tag kind="proposal" label={t.rsTag} testID="reschedule-tag" accessible={false} />
        <Txt role="section" size={17} weight={700} color={p.tx} lines={2} testID="reschedule-title">{proposal.title}</Txt>
        <Txt size={15} color={p.mu} lh={1.6} testID="reschedule-line">{line}</Txt>
        <SessionLines sessions={proposal.sessions} testID="reschedule-session" />
        <Txt size={13} color={p.mu} testID="reschedule-note">{t.suggestionNote}</Txt>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 10 }}>
        <Btn testID="reschedule-accept" label={t.accept} disabled={busy} accessibilityState={{ disabled: busy }}
          onPress={busy ? undefined : () => act('accept')}
          style={{ flexGrow: 1, flexBasis: 120, minHeight: 48, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, backgroundColor: p.ac, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={15} weight={600} color={p.onAccent}>{t.accept}</Txt>
        </Btn>
        <Btn testID="reschedule-dismiss" label={t.rsDecline} disabled={busy} accessibilityState={{ disabled: busy }}
          onPress={busy ? undefined : () => act('dismiss')}
          style={{ flexGrow: 1, flexBasis: 110, minHeight: 48, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={14} weight={500} color={p.mu}>{t.rsDecline}</Txt>
        </Btn>
      </View>
    </ReferenceCard>
  );
}

function AcceptedView({ item, decide }: { item: { commitmentId: string; title: string; sessions: Session[] }; decide: Decide }) {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const busy = decide.isPending;
  const undo = () => decide.mutate({ commitmentId: item.commitmentId, action: 'undo' }, {
    onSuccess: () => actions.toast(t.rsUndone),
    onError: (error) => actions.toast(userFacingMessage(error, t)),
  });
  return (
    <ReferenceCard pad={18} testID="reschedule-accepted">
      <Txt size={15} weight={600} color={p.tx} lines={2} testID="reschedule-accepted-title">{item.title}</Txt>
      <Txt size={14} color={p.mu} testID="reschedule-accepted-line">{t.rsAcceptedLine}</Txt>
      <SessionLines sessions={item.sessions} testID="reschedule-accepted-session" />
      <Txt size={13} color={p.mu} testID="reschedule-undo-hint">{t.rsUndoHint}</Txt>
      <Btn testID="reschedule-undo" label={t.rsUndo} disabled={busy} accessibilityState={{ disabled: busy }}
        onPress={busy ? undefined : undo}
        style={{ alignSelf: 'flex-start', minHeight: 48, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center' }}>
        <Txt size={14} weight={600} color={p.tx}>{t.rsUndo}</Txt>
      </Btn>
    </ReferenceCard>
  );
}
