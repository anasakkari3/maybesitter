import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { fill } from '../../i18n/strings';
import { formatRelativeDay } from '../../i18n/format';
import { isolateAuto } from '../../i18n/bidi';
import { Btn, Txt } from '../../ui/primitives';
import { useCommitmentAction, useDismissUnhandled, useRefreshUnhandled } from '../../api/queries';
import { ConflictError } from '../../api/errors';
import { markErrorShown } from '../../api/ui/userFacingMessage';
import { PostponeSheetFor } from '../../screens/Sheets';
import type { ChatFollowUpState } from './captureMachine';

/**
 * The chat's gentle question about «ما اتصرّفت فيها» (owner decision
 * 2026-11-12, spec Part 1, design item 3, lane E3).
 *
 * The server chose the item (one, not asked twice before, not dismissed)
 * and counted the ask; the words are here, in the app's language. It says
 * when, never how late, and asks what came of it — no blame and no lateness
 * word (mobile/AGENTS.md: there is no "overdue").
 *
 * ── Few choices, one of them first (owner review 2026-11-19) ─────
 *
 *   - one primary answer: an appointment's «في إشي، رح احكيلك», which puts the
 *     person back in the field — what they say becomes a normal proposal
 *     they confirm as usual — and a deadline's «تمّ»;
 *   - «خيارات تانية» opens the rest: for an appointment «ما طلع منه إشي،
 *     تمّت» (closes it, done), a new date (the postpone sheet),
 *     «أسقطه بوعي» (a quiet surface, never the primary answer's look) and
 *     «لا تسألني عنها» (plain text, the dismiss route);
 *   - «تخطّى», plain text, closes the question and writes nothing.
 *
 * Every answer is the person's own tap through what the place itself uses.
 * Each target is at least 44 points and its label names the item.
 */

type FollowUpCopy = {
  chatFollowUpIntro: string;
  chatFollowUpEvent: string;
  chatFollowUpDeadline: string;
};

/** The question's words: the intro, then one line per item. Pure. */
export function followUpText(
  followUp: Pick<ChatFollowUpState, 'items'>,
  t: FollowUpCopy,
  lang: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const lines = followUp.items.map((item) => {
    const when = isolateAuto(formatRelativeDay(new Date(item.shownAt ?? item.since), { locale: lang as never, timeZone, now }));
    const title = isolateAuto(item.title);
    return fill(item.reason === 'event_ended' ? t.chatFollowUpEvent : t.chatFollowUpDeadline, { title, when });
  });
  return [t.chatFollowUpIntro, ...lines].join('\n');
}

export function ChatFollowUpActions({ followUp, onSkip, onAnswered, onTell }: {
  followUp: ChatFollowUpState;
  onSkip(): void;
  onAnswered(commitmentId: string): void;
  /** «في إشي، رح احكيلك»: back to the field, to say what came of it. */
  onTell(): void;
}) {
  const { t, p, actions } = useApp();
  const act = useCommitmentAction();
  const dismiss = useDismissUnhandled();
  const refresh = useRefreshUnhandled();
  const [postponing, setPostponing] = useState<{ id: string; title: string } | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Held synchronously: two taps in one frame both see `isPending` false.
  const inFlight = useRef(false);
  const busy = act.isPending || dismiss.isPending;

  const run = (id: string, work: () => Promise<unknown>, toast: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailed(null);
    void work().then(() => { actions.toast(toast); onAnswered(id); }).catch((error: unknown) => {
      // Already answered somewhere else: nothing left to ask about it.
      if (error instanceof ConflictError) { onAnswered(id); return; }
      markErrorShown(error);
      setFailed(id);
    }).finally(() => {
      inFlight.current = false;
      refresh();
    });
  };

  const open = followUp.items.filter((item) => !followUp.answered.includes(item.commitmentId));
  return (
    <View testID="chat-follow-up-answers" style={{ gap: 8, alignSelf: 'stretch', alignItems: 'flex-start' }}>
      {open.map((item) => {
        const id = item.commitmentId;
        return (
          <View key={id} testID={`chat-follow-up-item-${id}`} style={{ gap: 8, alignItems: 'flex-start' }}>
            {failed === id ? <Txt size={13} color={p.wm} testID={`chat-follow-up-failed-${id}`}>{t.errorsGeneric}</Txt> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {item.reason === 'event_ended'
                ? <FollowUpAction kind="primary" testID={`chat-follow-up-tell-${id}`} label={t.chatFollowUpTell} item={item.title} disabled={busy}
                  onPress={() => { onAnswered(id); onTell(); }} />
                : <FollowUpAction kind="primary" testID={`chat-follow-up-done-${id}`} label={t.chatFollowUpDone} item={item.title} disabled={busy}
                  onPress={() => run(id, () => act.mutateAsync({ id, action: 'complete' }), t.toastDone)} />}
              <FollowUpAction kind="secondary" testID={`chat-follow-up-more-${id}`} label={t.chatFollowUpMore} item={item.title} disabled={busy}
                expanded={more} onPress={() => setMore((open) => !open)} />
            </View>
            {more ? <View testID={`chat-follow-up-options-${id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {item.reason === 'event_ended'
                ? <FollowUpAction kind="secondary" testID={`chat-follow-up-nothing-came-${id}`} label={t.chatFollowUpNothingCame} item={item.title} disabled={busy}
                  onPress={() => run(id, () => act.mutateAsync({ id, action: 'complete' }), t.toastDone)} />
                : null}
              <FollowUpAction kind="secondary" testID={`chat-follow-up-new-date-${id}`} label={t.unhandledNewDate} item={item.title} disabled={busy}
                onPress={() => setPostponing({ id, title: item.title })} />
              <FollowUpAction kind="secondary" testID={`chat-follow-up-drop-${id}`} label={t.dropIt} item={item.title} disabled={busy}
                onPress={() => run(id, () => act.mutateAsync({ id, action: 'cancel' }), t.toastDrop)} />
              <FollowUpAction kind="text" testID={`chat-follow-up-dont-ask-${id}`} label={t.unhandledDontAsk} item={item.title} disabled={busy}
                onPress={() => run(id, () => dismiss.mutateAsync(id), t.toastUnhandledDismissed)} />
            </View> : null}
          </View>
        );
      })}
      <Btn testID="chat-follow-up-skip" label={t.chatFollowUpSkipLabel} onPress={busy ? undefined : onSkip}
        disabled={busy} accessibilityState={{ disabled: busy }} scaleTo={0.97}
        style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 4, opacity: busy ? 0.5 : 1 }}>
        <Txt size={13} color={p.mu} style={{ textDecorationLine: 'underline', textDecorationColor: p.lnStrong }}>{t.chatFollowUpSkip}</Txt>
      </Btn>
      <PostponeSheetFor
        commitmentId={postponing?.id ?? null}
        title={postponing?.title}
        onClose={() => setPostponing(null)}
        onMoved={() => { if (postponing) onAnswered(postponing.id); refresh(); }}
      />
    </View>
  );
}

/**
 * `primary`: the accent, for the one answer the question expects. `secondary`:
 * the quiet surface. `text`: no surface at all. Every one is 44 points.
 */
function FollowUpAction({ label, item, onPress, disabled, testID, kind, expanded }: {
  label: string;
  /** Named in the accessibility label, so a screen reader says which item this answers. */
  item: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
  kind: 'primary' | 'secondary' | 'text';
  /** «خيارات تانية»: whether the other answers are open. */
  expanded?: boolean;
}) {
  const { p } = useApp();
  const surface = kind === 'primary' ? { backgroundColor: p.ac, borderRadius: 14, paddingHorizontal: 16 }
    : kind === 'secondary' ? { backgroundColor: p.sf2, borderRadius: 14, paddingHorizontal: 14 }
      : { paddingHorizontal: 4 };
  return (
    <Btn
      testID={testID}
      label={`${label}: ${item}`}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityState={{ disabled, ...(expanded === undefined ? {} : { expanded }) }}
      scaleTo={0.97}
      style={{
        minHeight: 44, minWidth: 44, justifyContent: 'center', paddingVertical: 10,
        opacity: disabled ? 0.5 : 1, alignItems: 'flex-start', ...surface,
      }}
    >
      <Txt size={13} weight={kind === 'primary' ? 600 : 400} color={kind === 'primary' ? p.onAccent : kind === 'text' ? p.mu : undefined}
        style={kind === 'text' ? { textDecorationLine: 'underline', textDecorationColor: p.lnStrong } : undefined}>{label}</Txt>
    </Btn>
  );
}
