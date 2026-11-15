import React, { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { WatcherProposal } from '../../api/schemas/watchers';
import { HubHeading } from '../../ui/hub';
import { Card, Pill, Txt } from '../../ui/primitives';
import { ProductActions } from '../../ui/product';
import { LiveRegion } from '../../ui/liveRegion';
import { useDecideWatcherProposal, useWatcherProposals } from '../product/useWatchers';

type Strings = ReturnType<typeof useApp>['t'];

/** Where a proposal came from, in words; the server sends only the watch kind. */
function originOf(t: Strings, signalKind: string): string {
  if (signalKind === 'readiness') return t.xProposalFromReadiness;
  if (signalKind === 'football_team' || signalKind === 'fixture') return t.xProposalFromFootball;
  return t.xProposalFromWatch;
}

/** The title the field starts with. The person's own words are what is saved. */
function suggestedTitle(t: Strings, signalKind: string): string {
  return signalKind === 'readiness' ? t.xProposalTitleReadiness : t.xProposalTitleOther;
}

/**
 * A watcher's «اقترح التزام» proposals (QA audit de7fcb8, CA6.1; owner
 * decision 2026-11-15), on the Watching tab.
 *
 * Here rather than on Background activity: Watching is the tab where what is
 * waiting on the person already lives — the proactive loop's suggestions with
 * their accept / not-for-me — and a tab root is seen on its own, while
 * Background activity is a settings leaf most people never open. The watcher
 * is listed a few rows below, under Watches, so the source is one glance away.
 *
 * Each card says it is a suggestion (`suggestionNote`) and changes nothing
 * until a button is pressed. Accept sends the title in the field, trimmed;
 * dismiss sends no title. One answer per card: a synchronous ref holds a
 * second tap that lands before the button disables, and the server decides
 * each proposal once whatever arrives from another phone.
 */
export function WatcherProposalsCard() {
  const { t } = useApp();
  const proposals = useWatcherProposals();
  const open = proposals.data?.proposals.filter(proposal => proposal.state === 'proposed') ?? [];
  if (open.length === 0) return null;
  return (
    <View testID="watcher-proposals" style={{ gap: 10 }}>
      <HubHeading title={t.xProposalsTitle} icon="spark" count={open.length} testID="watcher-proposals-heading" />
      {open.map(proposal => <ProposalCard key={proposal.proposalId} proposal={proposal} />)}
    </View>
  );
}

function ProposalCard({ proposal }: { proposal: WatcherProposal }) {
  const { t, p, rtl } = useApp();
  const decide = useDecideWatcherProposal();
  const [title, setTitle] = useState(() => suggestedTitle(t, proposal.signalKind));
  const sending = useRef(false);
  const [answered, setAnswered] = useState(false);
  const id = proposal.proposalId;
  const answer = (input: { decision: 'accept'; title: string } | { decision: 'dismiss' }) => {
    if (sending.current) return;
    sending.current = true;
    // Released only by a failure: an answered card never sends again, even
    // while the list that still holds it is being re-read.
    decide.mutate({ id, answer: input }, {
      onSuccess: () => setAnswered(true),
      onError: () => { sending.current = false; },
    });
  };
  if (answered) return null;
  const trimmed = title.trim();
  return (
    <Card style={{ gap: 12 }} testID={`watcher-proposal-${id}`}>
      <Txt role="supporting" color={p.mu}>{originOf(t, proposal.signalKind)}</Txt>
      <TextInput
        testID={`watcher-proposal-title-${id}`}
        accessibilityLabel={t.xIntelligenceEditTitle}
        value={title}
        onChangeText={setTitle}
        placeholder={t.xIntelligenceEditTitle}
        placeholderTextColor={p.mu}
        maxLength={200}
        style={{ color: p.tx, backgroundColor: p.bg, padding: 12, minHeight: 48, borderRadius: 12, fontSize: 16, textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr' }}
      />
      <ProductActions>
        <Pill
          label={t.xIntelligenceAccept}
          testID={`watcher-proposal-accept-${id}`}
          disabled={decide.isPending || trimmed.length === 0}
          onPress={() => { if (trimmed.length > 0) answer({ decision: 'accept', title: trimmed }); }}
        />
        <Pill
          label={t.xIntelligenceDismiss}
          kind="outline"
          testID={`watcher-proposal-dismiss-${id}`}
          disabled={decide.isPending}
          onPress={() => answer({ decision: 'dismiss' })}
        />
      </ProductActions>
      <LiveRegion>
        {decide.error ? <Txt role="supporting" color={p.wm} testID={`watcher-proposal-error-${id}`}>{userFacingMessage(decide.error, t)}</Txt> : null}
      </LiveRegion>
      <Txt role="supporting" color={p.mu}>{t.suggestionNote}</Txt>
    </Card>
  );
}
