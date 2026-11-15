import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { NotFoundError } from '../../api/errors';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import type { WatcherProposal } from '../../api/schemas/watchers';
import { useAnnounceOnIos } from '../../ui/announce';
import { HubHeading } from '../../ui/hub';
import { Card, Pill, Txt } from '../../ui/primitives';
import { ProductActions } from '../../ui/product';
import { LiveRegion } from '../../ui/liveRegion';
import { useDecideWatcherProposal, useWatcherProposals } from '../product/useWatchers';

type Strings = ReturnType<typeof useApp>['t'];
type Outcome = 'added' | 'dismissed' | 'gone';

const isFootball = (signalKind: string) => signalKind === 'football_team' || signalKind === 'fixture';

/** Where a proposal came from, in words; the server sends only the watch kind. */
function originOf(t: Strings, signalKind: string): string {
  if (signalKind === 'readiness') return t.xProposalFromReadiness;
  if (isFootball(signalKind)) return t.xProposalFromFootball;
  return t.xProposalFromWatch;
}

/**
 * The title the field starts with. General to the kind of watch — never the
 * team, the match or the reading — and the person's own words are what is saved.
 */
function suggestedTitle(t: Strings, signalKind: string): string {
  if (signalKind === 'readiness') return t.xProposalTitleReadiness;
  if (isFootball(signalKind)) return t.xProposalTitleFootball;
  return t.xProposalTitleOther;
}

function outcomeText(t: Strings, outcome: Outcome): string {
  return outcome === 'added' ? t.xProposalAdded : outcome === 'dismissed' ? t.xProposalDismissed : t.xProposalGone;
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
 *
 * What happened is said in the card's place — «انضافت لخطتك», «تمام، ما
 * انضافت», or that the proposal is gone (a 404: decided elsewhere, or its
 * watch deleted) — announced on both platforms and given focus, so a screen
 * reader is not dropped when the buttons go. The outcome is kept here, above
 * the list, so the re-read list that no longer holds the proposal does not
 * take the line away with it.
 */
export function WatcherProposalsCard() {
  const { t } = useApp();
  const proposals = useWatcherProposals();
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, { outcome: Outcome; proposal: WatcherProposal }>>>({});
  const open = (proposals.data?.proposals ?? []).filter(proposal => proposal.state === 'proposed' && !outcomes[proposal.proposalId]);
  const settled = Object.values(outcomes);
  if (open.length === 0 && settled.length === 0) return null;
  const record = (proposal: WatcherProposal, outcome: Outcome) =>
    setOutcomes(current => ({ ...current, [proposal.proposalId]: { outcome, proposal } }));
  return (
    <View testID="watcher-proposals" style={{ gap: 10 }}>
      <HubHeading title={t.xProposalsTitle} icon="spark" count={open.length} testID="watcher-proposals-heading" />
      {settled.map(({ proposal, outcome }) => <SettledCard key={proposal.proposalId} id={proposal.proposalId} text={outcomeText(t, outcome)} />)}
      {open.map(proposal => <ProposalCard key={proposal.proposalId} proposal={proposal} onSettled={outcome => record(proposal, outcome)} />)}
    </View>
  );
}

function SettledCard({ id, text }: { id: string; text: string }) {
  const { p } = useApp();
  const line = useRef<View>(null);
  useAnnounceOnIos(text);
  useEffect(() => {
    // The buttons the person pressed are gone; the focus moves to what they did.
    const node = line.current ? findNodeHandle(line.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);
  return (
    <Card testID={`watcher-proposal-settled-${id}`}>
      <LiveRegion>
        <View ref={line} accessible accessibilityRole="text" accessibilityLabel={text}>
          <Txt role="supporting" color={p.mu} testID={`watcher-proposal-done-${id}`}>{text}</Txt>
        </View>
      </LiveRegion>
    </Card>
  );
}

function ProposalCard({ proposal, onSettled }: { proposal: WatcherProposal; onSettled: (outcome: Outcome) => void }) {
  const { t, p, rtl } = useApp();
  const decide = useDecideWatcherProposal();
  const [title, setTitle] = useState(() => suggestedTitle(t, proposal.signalKind));
  const sending = useRef(false);
  const id = proposal.proposalId;
  const answer = (input: { decision: 'accept'; title: string } | { decision: 'dismiss' }) => {
    if (sending.current) return;
    sending.current = true;
    // Released only by a failure that can be retried: an answered card never
    // sends again, even while the list that still holds it is being re-read.
    decide.mutate({ id, answer: input }, {
      onSuccess: () => onSettled(input.decision === 'accept' ? 'added' : 'dismissed'),
      onError: error => {
        if (error instanceof NotFoundError) onSettled('gone');
        else sending.current = false;
      },
    });
  };
  const trimmed = title.trim();
  const failure = decide.error && !(decide.error instanceof NotFoundError) ? userFacingMessage(decide.error, t) : null;
  useAnnounceOnIos(failure);
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
        {failure ? <Txt role="supporting" color={p.wm} testID={`watcher-proposal-error-${id}`}>{failure}</Txt> : null}
      </LiveRegion>
      <Txt role="supporting" color={p.mu}>{t.suggestionNote}</Txt>
    </Card>
  );
}
