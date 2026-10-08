import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { useKeepSeed } from '../../api/queries';
import type { CaptureProposal, CaptureSeedProposal } from '../../api/schemas/capture';
import { ProposalChangedError } from '../../api/errors';
import { seedKindLabel } from './seedDisplay';

/**
 * What the capture read as unresolved intent, offered in Review (#519).
 *
 * ── Nothing here is saved, and the screen says so twice ──────────
 *
 * Review's `suggestionNote` already says nothing has changed yet. This section
 * adds "this is not a commitment yet", because the two claims are different:
 * the first is about *when* something is written, the second is about *what*
 * it would be. Somebody keeping a maybe inside a reminders app will otherwise
 * reasonably expect to be reminded about it.
 *
 * ── Keep is its own call, not part of the confirm ────────────────
 *
 * A seed is not an item on the capture confirm, and it deliberately does not
 * ride on its selection. `POST /api/mobile/seeds` carries the proposal id and
 * the seed's id and nothing else: the server reads the sentence back out of
 * its own stored proposal, so what is kept is what the person typed rather
 * than what this client re-sent. It is also safe to press twice — the server
 * derives the document id from the request and replays.
 *
 * ── "Not now" writes nothing at all ──────────────────────────────
 *
 * There is no "declined seed" record. A maybe the person did not keep is a
 * maybe that never existed, and storing the fact that they said no would be
 * the one thing a proposal is not allowed to do: persist.
 */
export function SeedProposalSection({
  proposalId, seeds, onAnchor, revision, onProposalChanged, writing = false, guardWrite, renderAction,
}: {
  proposalId: string;
  seeds: readonly CaptureSeedProposal[];
  /** The proposal revision on screen (M2b): the seed kept is the one shown. */
  revision?: number;
  /**
   * A 409: the proposal moved on elsewhere. Nothing was kept; the current
   * version goes back to the review to be looked at again.
   */
  onProposalChanged?: (proposal: CaptureProposal, confirmed: boolean) => void;
  /** Another proposal write is on its way (M2b): a keep waits for it. */
  writing?: boolean;
  /** Runs the keep as the host's one proposal write; `undefined` back means another write held it. */
  guardWrite?: <T>(run: () => Promise<T>) => Promise<T | undefined>;
  /**
   * Each seed's card and its words, for a host that brings one seed into view
   * and to the screen reader — a line of the chat's «هيك فهمت» (M2a).
   */
  onAnchor?: (seedItemId: string, part: 'card' | 'focus', node: View | null) => void;
  /** One more action under a seed's words — «حطّها التزام» on a timed thought (M3b, D3). */
  renderAction?: ((seed: CaptureSeedProposal) => React.ReactNode) | undefined;
}) {
  const { t, p } = useApp();
  const keep = useKeepSeed();
  const strings = t as unknown as Record<string, string>;
  const [kept, setKept] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);

  const offered = seeds.filter((seed) => !hidden.includes(seed.seedItemId));
  if (offered.length === 0) return null;

  return (
    <View style={{ gap: 10 }} testID="review-seeds">
      <Txt size={13} weight={600}>{t.seedReviewTitle}</Txt>
      <Txt size={12} color={p.mu} testID="review-seeds-not-commitment">{t.seedsNotCommitment}</Txt>

      {offered.map((seed) => (
        <View
          key={seed.seedItemId}
          testID={`review-seed-${seed.seedItemId}`}
          ref={onAnchor ? (node) => onAnchor(seed.seedItemId, 'card', node) : undefined}
          style={{ backgroundColor: p.sf, borderRadius: 18, padding: 14, gap: 8 }}
        >
          {/* The kind and the words read as one ("Considering: …"), and are
              where a screen reader lands when the chat brings this seed up. */}
          <View accessible accessibilityLabel={`${seedKindLabel(seed.kind, strings)}: ${seed.summary}`}
            ref={onAnchor ? (node) => onAnchor(seed.seedItemId, 'focus', node) : undefined}
            style={{ gap: 8, alignItems: 'flex-start' }}>
            <Txt size={12} color={p.mu}>{seedKindLabel(seed.kind, strings)}</Txt>
            {/* Verbatim: the segment the person wrote, which is the only thing
                this card may show. */}
            <Txt size={15} lh={1.45} testID={`review-seed-summary-${seed.seedItemId}`}>{seed.summary}</Txt>
          </View>
          {renderAction ? renderAction(seed) : null}
          {failed.includes(seed.seedItemId) ? (
            <Txt size={12} color={p.wm} testID={`review-seed-failed-${seed.seedItemId}`}>{t.errorsGeneric}</Txt>
          ) : null}

          {kept.includes(seed.seedItemId) ? (
            <Txt size={13} color={p.ac} testID={`review-seed-kept-${seed.seedItemId}`}>{t.seedKept}</Txt>
          ) : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn
                testID={`review-seed-keep-${seed.seedItemId}`}
                label={t.seedKeep}
                disabled={keep.isPending || writing}
                onPress={() => {
                  setFailed((current) => current.filter((id) => id !== seed.seedItemId));
                  const run = () => keep.mutateAsync({ proposalId, seedItemId: seed.seedItemId, ...(revision !== undefined ? { revision } : {}) });
                  void (guardWrite ? guardWrite(run) : run())
                    .then((result) => { if (result !== undefined) setKept((current) => [...current, seed.seedItemId]); })
                    .catch((error: unknown) => {
                      if (error instanceof ProposalChangedError && error.current.kind === 'proposal' && onProposalChanged) {
                        onProposalChanged(error.current.proposal, error.current.state === 'confirmed');
                        return;
                      }
                      setFailed((current) => [...current, seed.seedItemId]);
                    });
                }}
                scaleTo={0.97}
                style={{ backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 9, paddingHorizontal: 16, alignItems: 'flex-start', opacity: keep.isPending ? 0.5 : 1 }}
              >
                <Txt size={13}>{t.seedKeep}</Txt>
              </Btn>
              <Btn
                testID={`review-seed-skip-${seed.seedItemId}`}
                label={t.seedNotNow}
                // Not while its keep is on its way: that keep may still save it (M2B-A-R4-REVIEW-002).
                disabled={keep.isPending || writing}
                onPress={() => setHidden((current) => [...current, seed.seedItemId])}
                scaleTo={0.97}
                style={{ borderRadius: 14, paddingVertical: 9, paddingHorizontal: 16, alignItems: 'flex-start' }}
              >
                <Txt size={13} color={p.mu}>{t.seedNotNow}</Txt>
              </Btn>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}
