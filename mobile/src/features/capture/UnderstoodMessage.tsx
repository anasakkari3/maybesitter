import React from 'react';
import { Pressable, View } from 'react-native';
import type { CaptureProposal, UnderstoodPoint } from '../../api/schemas/capture';
import type { CaptureItemEdit } from './captureMachine';
import { chatItemPresentation } from './chatPresentation';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { fill, type Strings } from '../../i18n/strings';
import { stripIsolates } from '../../i18n/bidi';
import { Btn, Txt } from '../../ui/primitives';

/** What a line of the summary opens: an item's card, or a seed's row. */
export type UnderstoodTarget = { itemId: string } | { seedItemId: string };

interface Line {
  key: string; target: UnderstoodTarget; kind: string; text: string; when?: string; label: string;
}

function kindLabel(point: UnderstoodPoint, t: Strings): string {
  switch (point.kind) {
    case 'commitment': return t.understoodKindCommitment;
    case 'possible_goal': return t.seedKindPossibleGoal;
    case 'consideration': return t.seedKindConsideration;
    case 'idea': return t.seedKindIdea;
    case 'waiting_for': return t.seedKindWaitingFor;
  }
}

/**
 * «هيك فهمت» (audit 2026-10-06 #5, #6): what the assistant understood from the
 * message, one numbered line per point in the order it was said, before any
 * card or question. Each line says its kind in words — «التزام», «يمكن هدف»,
 * «عم تفكّر فيه», «فكرة», «مستني» — never by colour alone, and a commitment's
 * line carries the time its card shows, the range included («16:00–20:00»).
 * Tapping a line shows its card; «هيك صح» (the bubble's action) shows them all.
 *
 * ── How a screen reader meets it ─────────────────────────────────
 *
 * Each line is its own button, said as its place in the list, its kind, its
 * words and its time — «2 من 5. عم تفكّر فيه: …» — with a hint that it shows
 * the card. The wrapper carries the `list` role for TalkBack and is not itself
 * an accessibility element: on iOS that would hide the lines inside it, and
 * React Native gives `list` no meaning there (M2A-REV-002), so the position in
 * each line's label is what says "a list of five". One point is a single
 * tappable line, without list chrome.
 */
export function UnderstoodMessage({ proposal, points, edits, onOpen }: {
  proposal: CaptureProposal;
  points: readonly UnderstoodPoint[];
  edits: Record<string, CaptureItemEdit>;
  onOpen(target: UnderstoodTarget): void;
}) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  const lines: Line[] = points.map((point, index) => {
    const kind = kindLabel(point, t);
    const item = point.kind === 'commitment' ? proposal.items.find((candidate) => candidate.itemId === point.itemId) : undefined;
    const shown = item ? chatItemPresentation(item, edits[item.itemId], lang, timezone, t) : undefined;
    const when = shown?.instant ? shown.subtitle : undefined;
    const spoken = points.length === 1 ? `${kind}: ${point.text}`
      : fill(t.understoodLineLabel, { n: index + 1, total: points.length, kind, text: point.text });
    return {
      key: point.kind === 'commitment' ? `i:${point.itemId}` : `s:${point.seedItemId}`,
      target: point.kind === 'commitment' ? { itemId: point.itemId } : { seedItemId: point.seedItemId },
      kind, text: point.text, ...(when ? { when } : {}),
      label: stripIsolates(when ? `${spoken}, ${when}` : spoken),
    };
  });

  const words = (line: Line) => <View style={{ flex: 1, alignItems: 'flex-start', gap: 2 }}>
    <Txt size={13} weight={600} color={p.wm} testID={`understood-kind-${line.key}`}>{line.kind}</Txt>
    <Txt size={15} testID={`understood-text-${line.key}`}>{line.text}</Txt>
    {line.when ? <Txt size={13} color={p.mu} testID={`understood-when-${line.key}`}>{line.when}</Txt> : null}
  </View>;

  if (lines.length === 1) {
    const line = lines[0]!;
    return <Btn testID="understood-line-1" label={line.label} hint={t.understoodLineHint} scaleTo={1}
      onPress={() => onOpen(line.target)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', alignSelf: 'stretch', paddingVertical: 4 }}>
      {words(line)}
    </Btn>;
  }

  return <View testID="understood-list" accessibilityRole="list" style={{ alignSelf: 'stretch', gap: 4 }}>
    {lines.map((line, index) => <Pressable key={line.key} testID={`understood-line-${index + 1}`}
      accessibilityRole="button" accessibilityLabel={line.label} accessibilityHint={t.understoodLineHint}
      onPress={() => onOpen(line.target)}
      style={({ pressed }) => [{
        minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', gap: 10,
        paddingVertical: 8, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 12,
      }, pressed && { backgroundColor: p.sf2 }]}>
      <View style={{ minWidth: 26, minHeight: 26, paddingHorizontal: 6, borderRadius: 13, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
        <Txt size={13} weight={600} latin>{String(index + 1)}</Txt>
      </View>
      {words(line)}
    </Pressable>)}
  </View>;
}
