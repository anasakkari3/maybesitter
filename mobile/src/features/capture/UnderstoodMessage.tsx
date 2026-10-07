import React from 'react';
import { Pressable, View } from 'react-native';
import type { CaptureCorrection, CaptureProposal, UnderstoodPoint } from '../../api/schemas/capture';
import type { CaptureItemEdit } from './captureMachine';
import { chatItemPresentation } from './chatPresentation';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { fill, type Strings } from '../../i18n/strings';
import { isolateAuto, stripIsolates } from '../../i18n/bidi';
import { Btn, Txt } from '../../ui/primitives';
import { useLayoutMode } from '../../theme/textScale';

/** What a line of the summary opens: an item's card, or a seed's row. */
export type UnderstoodTarget = { itemId: string } | { seedItemId: string };

interface Line {
  key: string; target: UnderstoodTarget; kind: string; text: string; when?: string; label: string;
  /** The item's dictation corrections (M2b), each undoable with «مش هيك». */
  corrections: readonly CaptureCorrection[];
}

function kindLabel(point: UnderstoodPoint, t: Strings): string {
  switch (point.kind) {
    case 'commitment': return t.understoodKindCommitment;
    case 'possible_goal': return t.seedKindPossibleGoal;
    case 'consideration': return t.seedKindConsideration;
    case 'idea': return t.seedKindIdea;
    case 'waiting_for': return t.understoodKindWaitingFor;
  }
}

/**
 * «هيك فهمت» (audit 2026-10-06 #5, #6): what the assistant understood from the
 * message, one numbered line per point in the order it was said, before any
 * card or question. Each line says its kind in words — «التزام», «يمكن هدف»,
 * «عم تفكّر فيه», «فكرة», «مستني عليه» — never by colour alone, and a commitment's
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
export function UnderstoodMessage(props: Parameters<typeof UnderstoodLines>[0] & {
  /**
   * Protected points a later message took off the list (M2b, contract v5):
   * shown under the lines, muted, each with «رجّعها» — never gone silently.
   */
  onRestore?(target: UnderstoodTarget): void;
}) {
  const { t, p } = useApp();
  // From the large layout on, «رجّعها» goes under its line, as «عدّل» does.
  const stacked = useLayoutMode() !== 'normal';
  const { onRestore, ...rest } = props;
  const removed = props.editable ? props.proposal.removedItems ?? [] : [];
  const lines = <UnderstoodLines {...rest} />;
  if (removed.length === 0) return lines;
  return <View style={{ alignSelf: 'stretch', gap: 6 }}>
    {lines}
    {removed.map((entry) => {
      const id = entry.itemId ?? entry.seedItemId!;
      const target: UnderstoodTarget = entry.itemId ? { itemId: entry.itemId } : { seedItemId: entry.seedItemId! };
      return <View key={`removed-${id}`} testID={`understood-removed-${id}`} style={stacked ? { alignItems: 'flex-start', gap: 2 } : { flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Txt size={13} color={p.mu} style={stacked ? undefined : { flex: 1 }}>{fill(t.understoodRemoved, { text: isolateAuto(entry.text) })}</Txt>
        {onRestore ? <Btn testID={`understood-restore-${id}`} label={stripIsolates(fill(t.understoodRestoreLabel, { text: entry.text }))}
          onPress={() => onRestore(target)} disabled={props.busy} scaleTo={0.97}
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={13} weight={600} color={props.busy ? p.mu : p.ac}>{t.understoodRestore}</Txt>
        </Btn> : null}
      </View>;
    })}
  </View>;
}

function UnderstoodLines({ proposal, points, edits, onOpen, editable = false, onEdit, onRejectCorrection, busy = false, editRef }: {
  proposal: CaptureProposal;
  points: readonly UnderstoodPoint[];
  edits: Record<string, CaptureItemEdit>;
  onOpen(target: UnderstoodTarget): void;
  /**
   * Whether each line offers «عدّل» and each correction «مش هيك» (M2b): only
   * for a proposal the server versions — an older server's has no revision to
   * edit against, and then the summary is read-only as before.
   */
  editable?: boolean;
  /** «عدّل» on line `n` (1-based). */
  onEdit?(n: number): void;
  onRejectCorrection?(itemId: string, correctionId: string): void;
  /** An edit is on its way: the controls wait for its answer. */
  busy?: boolean;
  /** Each «عدّل», so a screen reader can come back to it after the sheet closes. */
  editRef?(n: number, node: View | null): void;
}) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  // Beside a line, «عدّل» leaves the words a column one or two words wide at
  // large text, and an Arabic word broke inside itself («المدي/ر», simulator
  // AX5 under load); from the large layout on it sits under the line instead.
  const stacked = useLayoutMode() !== 'normal';
  const lines: Line[] = points.map((point, index) => {
    const kind = kindLabel(point, t);
    const item = point.kind === 'commitment' ? proposal.items.find((candidate) => candidate.itemId === point.itemId) : undefined;
    // A title changed on the card is what the summary says when the person
    // comes back to it (M2b): the staged words, until the confirm or an edit.
    const text = (item ? edits[item.itemId]?.title : undefined) ?? point.text;
    const shown = item ? chatItemPresentation(item, edits[item.itemId], lang, timezone, t) : undefined;
    const when = shown?.instant ? shown.subtitle : undefined;
    const spoken = points.length === 1 ? `${kind}: ${text}`
      : fill(t.understoodLineLabel, { n: index + 1, total: points.length, kind, text });
    return {
      key: point.kind === 'commitment' ? `i:${point.itemId}` : `s:${point.seedItemId}`,
      target: point.kind === 'commitment' ? { itemId: point.itemId } : { seedItemId: point.seedItemId },
      kind, text, ...(when ? { when } : {}),
      label: stripIsolates(when ? `${spoken}, ${when}` : spoken),
      corrections: item?.corrections ?? [],
    };
  });

  const words = (line: Line) => <View style={{ flex: 1, alignItems: 'flex-start', gap: 2 }}>
    <Txt size={13} weight={600} color={p.wm} testID={`understood-kind-${line.key}`}>{line.kind}</Txt>
    <Txt size={15} testID={`understood-text-${line.key}`}>{line.text}</Txt>
    {line.when ? <Txt size={13} color={p.mu} testID={`understood-when-${line.key}`}>{line.when}</Txt> : null}
  </View>;

  /**
   * A line's number. With `spacerID` it is the unseen copy that indents a
   * stacked «عدّل» — the same box, so the same width at every text size.
   */
  const badge = (n: number, spacerID?: string) => <View testID={spacerID}
    {...(spacerID ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const } : {})}
    style={[{ minWidth: 26, minHeight: 26, paddingHorizontal: 6, borderRadius: 13, backgroundColor: p.sf2, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
      spacerID ? { opacity: 0 } : null]}>
    <Txt size={13} weight={600} latin>{String(n)}</Txt>
  </View>;

  /**
   * The line's own controls, beside it and never inside it: a line is one
   * button to a screen reader, and a control inside an accessible button is
   * unreachable on iOS (M2a REV-002). «عدّل» names the line it edits; a
   * correction line says what was heard and offers «مش هيك».
   */
  const controls = (line: Line, n: number, lineElement: React.ReactNode) => {
    const edit = editable && onEdit ? <Pressable testID={`understood-edit-${n}`} ref={(node) => editRef?.(n, node)}
      accessibilityRole="button" accessibilityLabel={stripIsolates(fill(t.understoodEditLabel, { text: line.text }))}
      accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => onEdit(n)}
      style={({ pressed }) => [{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
        pressed && { backgroundColor: p.sf2 }]}>
      <Txt size={13} weight={600} color={busy ? p.mu : p.ac}>{t.understoodEdit}</Txt>
    </Pressable> : null;
    return <View key={line.key} style={{ alignSelf: 'stretch', gap: 2 }}>
      <View style={stacked ? { alignItems: 'flex-start', gap: 2 } : { flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
        <View style={stacked ? { alignSelf: 'stretch' } : { flex: 1 }}>{lineElement}</View>
        {/* Under a numbered line, «عدّل» starts where the line's words do: after
            an unseen copy of the line's own number badge, which grows with the
            text exactly as the badge does (a fixed indent fell short at AX5).
            The button's own padding stands in for the line's gap. */}
        {edit && stacked && lines.length > 1 ? <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          {badge(n, `understood-edit-indent-${n}`)}
          {edit}
        </View> : edit}
      </View>
    {editable && 'itemId' in line.target ? line.corrections.map((correction) => {
      const itemId = (line.target as { itemId: string }).itemId;
      return <View key={correction.id} testID={`understood-correction-${correction.id}`}
        style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingStart: lines.length > 1 ? 36 : 0 }}>
        <Txt size={13} color={p.mu} style={{ flexShrink: 1 }}>{fill(t.understoodCorrection, { from: isolateAuto(correction.from), to: isolateAuto(correction.to) })}</Txt>
        {onRejectCorrection ? <Btn testID={`understood-correction-reject-${correction.id}`}
          label={stripIsolates(fill(t.understoodCorrectionRejectLabel, { from: correction.from, text: line.text }))}
          onPress={() => onRejectCorrection(itemId, correction.id)} disabled={busy} scaleTo={0.97}
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={13} weight={600} color={busy ? p.mu : p.ac}>{t.understoodCorrectionReject}</Txt>
        </Btn> : null}
      </View>;
    }) : null}
    </View>;
  };

  if (lines.length === 1) {
    const line = lines[0]!;
    return controls(line, 1, <Btn testID="understood-line-1" label={line.label} hint={t.understoodLineHint} scaleTo={1}
      onPress={() => onOpen(line.target)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', alignSelf: 'stretch', paddingVertical: 4 }}>
      {words(line)}
    </Btn>);
  }

  return <View testID="understood-list" accessibilityRole="list" accessible={false} style={{ alignSelf: 'stretch', gap: 4 }}>
    {lines.map((line, index) => controls(line, index + 1, <Pressable testID={`understood-line-${index + 1}`}
      accessibilityRole="button" accessibilityLabel={line.label} accessibilityHint={t.understoodLineHint}
      onPress={() => onOpen(line.target)}
      style={({ pressed }) => [{
        minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', gap: 10,
        paddingVertical: 8, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 12,
      }, pressed && { backgroundColor: p.sf2 }]}>
      {badge(index + 1)}
      {words(line)}
    </Pressable>))}
  </View>;
}
