import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import { useKeepSeed } from '../../api/queries';
import type { CaptureSeedProposal } from '../../api/schemas/capture';
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
  proposalId, seeds,
}: {
  proposalId: string;
  seeds: readonly CaptureSeedProposal[];
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
          style={{ backgroundColor: p.sf, borderRadius: 18, padding: 14, gap: 8 }}
        >
          <Txt size={11} color={p.mu}>{seedKindLabel(seed.kind, strings)}</Txt>
          {/* Verbatim: the segment the person wrote, which is the only thing
              this card may show. */}
          <Txt size={15} lh={1.45} testID={`review-seed-summary-${seed.seedItemId}`}>{seed.summary}</Txt>
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
                disabled={keep.isPending}
                onPress={() => {
                  setFailed((current) => current.filter((id) => id !== seed.seedItemId));
                  void keep
                    .mutateAsync({ proposalId, seedItemId: seed.seedItemId })
                    .then(() => setKept((current) => [...current, seed.seedItemId]))
                    .catch(() => setFailed((current) => [...current, seed.seedItemId]));
                }}
                scaleTo={0.97}
                style={{ backgroundColor: p.sf2, borderRadius: 14, paddingVertical: 9, paddingHorizontal: 16, alignItems: 'flex-start', opacity: keep.isPending ? 0.5 : 1 }}
              >
                <Txt size={13}>{t.seedKeep}</Txt>
              </Btn>
              <Btn
                testID={`review-seed-skip-${seed.seedItemId}`}
                label={t.seedNotNow}
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
