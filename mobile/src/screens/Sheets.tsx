import React, { useState } from 'react';
import { Animated, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { ltr } from '../i18n/strings';
import { useTimeZone } from '../i18n/timezone';
import { formatRelativeDay, formatTime } from '../i18n/format';
import { useCommitment, useCommitmentAction, useDeleteCommitment, usePatchCommitment } from '../api/queries';
import { POSTPONE_PRESETS, postponeTo, type PostponePreset } from '../features/commitments/postpone';
import type { Strings } from '../i18n/strings';
import { family } from '../theme/fonts';
import { Btn, Pill, Txt } from '../ui/primitives';
import { CheckIcon } from '../ui/icons';
import { useSheetMotion } from '../ui/motion';

/*
 * The design's ClarifySheet and ReadingsSheet were here.
 *
 * Both drove `src/services/mockCapture.ts`: the clarify sheet set an hour on a
 * mock proposal, the readings sheet picked between two hard-coded Thursdays.
 * Neither ever reached the server, and both are now the parallel duplicate of
 * a real thing — UC-2.5 (#165) renders the server's own `clarification`
 * question, from its `questionKey` and options, against the live proposal.
 *
 * They are removed rather than left dormant: a second clarify UI is exactly
 * what a later change would wire up by mistake.
 */

/**
 * "Not now" — the four presets (UC-2.R3, #173).
 *
 * This replaces the prototype's Rearrange sheet. Three of that sheet's four
 * choices — "Intensify: same content, shorter time", "Do less of it", "Move
 * the deadline" — operated on a duration and a scope the domain does not have,
 * and picking any of them only ever showed a toast. Postpone is the transition
 * `/api/mobile/commitments/[id]/actions` actually implements.
 *
 * Each preset shows the instant it resolves to, because "next week" is a
 * promise and 09:00 next Tuesday is the thing the user is actually agreeing to.
 */
function PostponeSheet() {
  const { s, t, p, lang, actions } = useApp();
  const timezone = useTimeZone();
  const query = useCommitment(s.detailId);
  const act = useCommitmentAction();
  const now = new Date();

  const choose = (preset: PostponePreset) => {
    const id = query.data?.id;
    if (!id) return;
    // No past-instant guard here, and none is needed: every preset is `now`
    // plus something, so none can resolve into the past. `isPostponable` is
    // for the custom picker, where the user really can choose yesterday — it
    // lands with that picker rather than as an unreachable branch here.
    const until = postponeTo(preset, new Date(), timezone);
    act.mutate({ id, action: 'postpone', postponedUntil: until }, {
      onSuccess: () => actions.toast(t.toastPostponed),
    });
  };

  return (
    <View style={{ gap: 14 }}>
      <Txt size={22} weight={600} lh={1.5}>{t.postponeTitle}</Txt>
      <Txt size={15} color={p.mu}>{t.postponeBody}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {POSTPONE_PRESETS.map(preset => {
          const until = new Date(postponeTo(preset, now, timezone));
          return (
            <Btn
              key={preset}
              testID={`postpone-${preset}`}
              label={PRESET_LABEL(t)[preset]}
              disabled={act.isPending}
              onPress={() => choose(preset)}
              style={{ width: '48%', flexGrow: 1, backgroundColor: p.sf2, borderRadius: 20, padding: 16, gap: 4, minHeight: 92, alignItems: 'flex-start', opacity: act.isPending ? 0.4 : 1 }}
            >
              <Txt size={16} weight={600}>{PRESET_LABEL(t)[preset]}</Txt>
              <Txt size={12} color={p.mu} testID={`postpone-when-${preset}`}>
                {`${formatRelativeDay(until, { locale: lang, timeZone: timezone, now })} · ${ltr(formatTime(until, { locale: lang, timeZone: timezone }))}`}
              </Txt>
            </Btn>
          );
        })}
      </View>
    </View>
  );
}

const PRESET_LABEL = (t: Strings): Record<PostponePreset, string> => ({
  oneHour: t.postponeOneHour,
  threeHours: t.postponeThreeHours,
  thisEvening: t.postponeThisEvening,
  tomorrowMorning: t.postponeTomorrowMorning,
  nextWeek: t.postponeNextWeek,
});

/**
 * Editing what a commitment is (UC-2.R3, #173).
 *
 * Title and importance. Editing the date and time needs a real date-time
 * picker; that lands with the native dependency rather than with a text field
 * a user can type an invalid date into.
 *
 * Only changed fields are sent. `usePatchCommitment` makes the write
 * conditional on the validator it remembered, so an edit from a screen another
 * device has already moved past is refused rather than silently winning.
 */
function EditSheet() {
  const { s, t, p, ar, actions } = useApp();
  const query = useCommitment(s.detailId);
  const patch = usePatchCommitment();
  const commitment = query.data;
  const [title, setTitle] = useState(commitment?.title ?? '');
  const [level, setLevel] = useState<PriorityLevel>(commitment?.priority.level ?? 'normal');

  if (!commitment) return null;

  const trimmed = title.trim();
  const changed = (trimmed !== commitment.title && trimmed.length > 0) || level !== commitment.priority.level;

  const save = () => {
    const body: { title?: string; priority?: PriorityLevel } = {};
    if (trimmed !== commitment.title && trimmed.length > 0) body.title = trimmed;
    if (level !== commitment.priority.level) body.priority = level;
    if (Object.keys(body).length === 0) return;
    patch.mutate({ id: commitment.id, patch: body }, { onSuccess: actions.closeSheet });
  };

  return (
    <View style={{ gap: 14 }}>
      <Txt size={22} weight={600} lh={1.5}>{t.editSheetTitle}</Txt>

      <Txt size={13} color={p.mu}>{t.editFieldTitle}</Txt>
      <TextInput
        testID="edit-title"
        value={title}
        onChangeText={setTitle}
        multiline
        style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 56, color: p.tx, fontFamily: family(400, ar), textAlign: ar ? 'right' : 'left' }}
      />

      <Txt size={13} color={p.mu}>{t.editFieldPriority}</Txt>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {LEVELS.map(option => (
          <Btn
            key={option}
            testID={`edit-priority-${option}`}
            label={LEVEL_LABEL(t)[option]}
            onPress={() => setLevel(option)}
            style={{ flex: 1, backgroundColor: option === level ? p.acs : p.sf2, borderRadius: 999, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
          >
            <Txt size={14} weight={600} color={option === level ? p.ac : p.tx}>{LEVEL_LABEL(t)[option]}</Txt>
          </Btn>
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill testID="edit-save" label={t.editSave} onPress={save} disabled={!changed || patch.isPending} style={{ flex: 1 }} />
        <Pill testID="edit-close" label={t.editClose} onPress={actions.closeSheet} kind="outline" style={{ flex: 1 }} />
      </View>
    </View>
  );
}

type PriorityLevel = 'low' | 'normal' | 'high';
const LEVELS: readonly PriorityLevel[] = ['high', 'normal', 'low'];
const LEVEL_LABEL = (t: Strings): Record<PriorityLevel, string> => ({
  high: t.todayGroupMust,
  normal: t.todayGroupShould,
  low: t.todayGroupNice,
});

/**
 * The two destructive answers, each asked before it happens.
 *
 * Dropping on purpose and deleting are deliberately not the same button and
 * not the same sentence: one keeps the commitment in the user's history and
 * the other does not, and that difference is the whole reason «أسقطه بوعي»
 * exists in this product.
 */
function ConfirmSheet({ intent }: { intent: 'drop' | 'delete' }) {
  const { s, t, p, actions } = useApp();
  const query = useCommitment(s.detailId);
  const act = useCommitmentAction();
  const remove = useDeleteCommitment();
  const id = query.data?.id;
  const pending = act.isPending || remove.isPending;

  const confirm = () => {
    if (!id) return;
    if (intent === 'drop') {
      act.mutate({ id, action: 'cancel' }, { onSuccess: () => actions.toast(t.toastDrop) });
    } else {
      remove.mutate(id, { onSuccess: () => actions.toast(t.toastDeleted) });
    }
  };

  return (
    <View style={{ gap: 14 }}>
      <Txt size={22} weight={600} lh={1.5}>{intent === 'drop' ? t.confirmDropTitle : t.confirmDeleteTitle}</Txt>
      <Txt size={15} color={p.mu} lh={1.5}>{intent === 'drop' ? t.confirmDropBody : t.confirmDeleteBody}</Txt>
      <View style={{ gap: 10 }}>
        <Pill
          testID={`confirm-${intent}`}
          label={intent === 'drop' ? t.dropIt : t.detailsDelete}
          onPress={confirm}
          disabled={pending}
          kind="warm"
          radius={20}
          pad={16}
        />
        <Pill testID="confirm-keep" label={t.confirmKeep} onPress={actions.closeSheet} kind="outline" radius={20} pad={16} />
      </View>
    </View>
  );
}

function ToastSheet() {
  const { s, t, p, actions } = useApp();
  return (
    <View style={{ gap: 14, alignItems: 'center', paddingVertical: 10 }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: p.acs, alignItems: 'center', justifyContent: 'center' }}>
        <CheckIcon size={22} color={p.ac} weight={1.25} />
      </View>
      <Txt size={20} weight={600} align="center">{s.toast}</Txt>
      <Pill label={t.ok} onPress={actions.closeSheetHome} size={15} style={{ paddingHorizontal: 30 }} />
    </View>
  );
}

export function SheetHost() {
  const { s, p, actions } = useApp();
  const insets = useSafeAreaInsets();
  const m = useSheetMotion();
  if (!s.sheet) return null;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30, justifyContent: 'flex-end' }}>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.scrim }, m.scrim]}>
        <Pressable style={{ flex: 1 }} onPress={actions.closeSheet} accessibilityLabel="close" />
      </Animated.View>
      <Animated.View
        style={[
          { backgroundColor: p.sf, borderTopLeftRadius: 36, borderTopRightRadius: 36, paddingTop: 14, paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 14, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: -10 }, elevation: 12 },
          m.panel,
        ]}
      >
        <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: p.ln, alignSelf: 'center', marginBottom: 4 }} />
        {s.sheet === 'postpone' && <PostponeSheet />}
        {s.sheet === 'edit' && <EditSheet />}
        {s.sheet === 'confirmDrop' && <ConfirmSheet intent="drop" />}
        {s.sheet === 'confirmDelete' && <ConfirmSheet intent="delete" />}
        {s.sheet === 'toast' && <ToastSheet />}
      </Animated.View>
    </View>
  );
}
