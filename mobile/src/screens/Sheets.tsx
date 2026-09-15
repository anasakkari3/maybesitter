import React, { useState } from 'react';
import { Animated, Platform, Pressable, Switch, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { ltr } from '../i18n/strings';
import { useTimeZone } from '../i18n/timezone';
import { formatDate, formatRelativeDay, formatTime } from '../i18n/format';
import { useCommitment, useCommitmentAction, useDeleteCommitment, usePatchCommitment } from '../api/queries';
import { userFacingMessage } from '../api/ui/userFacingMessage';
import { POSTPONE_PRESETS, isPostponable, postponeTo, type PostponePreset } from '../features/commitments/postpone';
import { buildTimePatch } from '../features/commitments/timePatch';
import { instantForLocalDateTime, localDateTimeFor } from '../features/capture/localInstant';
import type { CommitmentPatch } from '../api/endpoints/commitments';
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
 * "Not now" — the four presets and "some other time" (UC-2.R3, #173; #337).
 *
 * This replaces the prototype's Rearrange sheet. Three of that sheet's four
 * choices — "Intensify: same content, shorter time", "Do less of it", "Move
 * the deadline" — operated on a duration and a scope the domain does not have,
 * and picking any of them only ever showed a toast. Postpone is the transition
 * `/api/mobile/commitments/[id]/actions` actually implements.
 *
 * Each preset shows the instant it resolves to, because "next week" is a
 * promise and 09:00 next Tuesday is the thing the user is actually agreeing to.
 *
 * ── The custom picker ────────────────────────────────────────────
 *
 * "Some other time" opens the same two pieces the edit sheet below runs on —
 * `@react-native-community/datetimepicker` and `localInstant.ts` — rather than
 * a second date UI. The wall-clock string is the state and the conversion to an
 * instant happens in the user's zone, so nothing here parses a local string in
 * whatever zone the host happens to be in. That is the same rule `postpone.ts`
 * states for the presets, and the arithmetic is not repeated: a preset is
 * `postponeTo`, a custom time is `instantForLocalDateTime`, and this sheet
 * computes neither itself.
 *
 * ── A past time is refused ───────────────────────────────────────
 *
 * The presets need no guard: each is `now` plus something, so none can resolve
 * into the past. The custom picker can, and `postponeCommitment` on the server
 * answers a past `postponedUntil` with a 400 before the state machine sees it.
 * `isPostponable` says the same thing here first — checked when the button is
 * pressed, because reading the clock in a render body is an impure call the
 * compiler rules refuse, and because pressing it is the moment the answer
 * matters. The refusal is visible and localised; nothing is sent.
 *
 * `minimumDate` is the other half of that: the wheel itself does not offer a
 * time that has gone, so the refusal is the belt to that pair of braces rather
 * than the only thing standing between the user and a 400. `postpone.ts` says
 * it plainly — a picker that lets somebody choose yesterday and then fails is a
 * worse version of a picker that does not.
 *
 * ── A failure is said out loud ───────────────────────────────────
 *
 * The presets cannot draw the server's past-time 400, so until this picker
 * existed a postpone had no realistic failure to render. It does now, and a
 * write that fails silently reads as a write that worked. The refusal slot
 * shows either — the client's own complaint first, then whatever the request
 * came back with, through `userFacingMessage`, which is the only copy table a
 * failure is allowed to use.
 */
function PostponeSheet() {
  const { s, t, p, lang, scheme, actions } = useApp();
  const timezone = useTimeZone();
  const query = useCommitment(s.detailId);
  const act = useCommitmentAction();
  const now = new Date();

  // `''` is "the custom picker is closed". The same representation the edit
  // sheet uses for "no time": a wall-clock `YYYY-MM-DDTHH:mm` in `timezone`.
  const [local, setLocal] = useState('');
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);
  const [pastTime, setPastTime] = useState(false);
  const custom = local !== '';
  // Memoised on the two things it reads. It is the only zone conversion on this
  // screen, and while the picker is open the sheet re-renders on every turn of
  // the wheel.
  const instant = React.useMemo(
    () => (local === '' ? null : instantForLocalDateTime(local, timezone)),
    [local, timezone],
  );

  // Read when the picker opens rather than on every render: a `minimumDate`
  // whose milliseconds move each frame is a new native prop on every turn of
  // the wheel.
  const notBefore = React.useMemo(() => (picking === null ? null : new Date()), [picking]);

  // The client's own refusal wins: it is about the time still on the wheel,
  // while `act.error` is about a request that has already gone. Derived rather
  // than stored, so switching language re-reads both in the new one.
  const problem = pastTime ? t.editItemPast : act.error ? userFacingMessage(act.error, t) : null;

  const send = (until: string) => {
    const id = query.data?.id;
    if (!id) return;
    act.mutate({ id, action: 'postpone', postponedUntil: until }, {
      onSuccess: () => actions.toast(t.toastPostponed),
    });
  };

  const choose = (preset: PostponePreset) => {
    // No past-instant guard here, and none is needed: every preset is `now`
    // plus something, so none can resolve into the past.
    send(postponeTo(preset, new Date(), timezone));
  };

  const confirmCustom = () => {
    if (!instant) return;
    // The one branch the presets cannot reach: the user really can pick
    // yesterday. Judged against the clock at the press, not at the render.
    if (!isPostponable(instant.toISOString(), new Date())) {
      setPastTime(true);
      return;
    }
    setPastTime(false);
    send(instant.toISOString());
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

      {custom ? (
        <View style={{ gap: 10 }}>
          <Txt size={13} color={p.mu}>{t.postponeCustomWhen}</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn
              testID="postpone-pick-date"
              label={t.editItemDate}
              onPress={() => setPicking('date')}
              style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
            >
              <Txt size={14} testID="postpone-custom-date">{instant ? formatDate(instant, 'short', { locale: lang, timeZone: timezone }) : t.editItemDate}</Txt>
            </Btn>
            <Btn
              testID="postpone-pick-time"
              label={t.editItemTime}
              onPress={() => setPicking('time')}
              style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
            >
              {/* `latin` and `ltr()`: a time in a tight box, kept left-to-right
                  inside an Arabic or Hebrew line. Latin digits come from
                  `intlLocale` (`ar-u-nu-latn`), not from anything decided here. */}
              <Txt size={14} latin testID="postpone-custom-time">{instant ? ltr(formatTime(instant, { locale: lang, timeZone: timezone })) : t.editItemTime}</Txt>
            </Btn>
          </View>

          {/* `notBefore` is set with `picking` and narrowed with it, so the
              picker never takes a `minimumDate` of `undefined`. */}
          {picking && notBefore ? (
            <DateTimePicker
              testID="postpone-picker"
              value={instant ?? new Date()}
              mode={picking}
              // Always 24-hour, because `formatTime` is always 24-hour: it sets
              // `hourCycle: 'h23'` unconditionally, in all three languages, so
              // the button beside this wheel reads "18:00" whatever the locale
              // would have preferred. A wheel that asked the locale disagreed
              // with that button in `ar` and `en`, which are the two locales
              // `Intl` answers `h12` for — and Arabic is the default.
              is24Hour
              // Without it the native picker draws its own light chrome inside
              // a dark sheet, which is unreadable. `scheme` is what the rest of
              // the app is painted from, so it is what this follows.
              themeVariant={scheme}
              // The wheel does not offer a time that has gone.
              minimumDate={notBefore}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event, picked) => {
                setPicking(Platform.OS === 'ios' ? picking : null);
                // Android hands a dismiss the value the picker opened with, so
                // a truthy `picked` is not an answer. Clearing the complaint on
                // a cancel would drop it while the time it named is still set.
                if (event.type === 'dismissed' || !picked) return;
                setLocal(localDateTimeFor(picked, timezone));
                // Their answer to the complaint; judged again on confirm.
                setPastTime(false);
              }}
            />
          ) : null}

          {problem ? <Txt size={13} color={p.wm} testID="postpone-problem">{problem}</Txt> : null}

          <Pill
            testID="postpone-custom-confirm"
            label={t.postponeCustomConfirm}
            onPress={confirmCustom}
            disabled={act.isPending || instant === null}
          />
        </View>
      ) : (
        <Btn
          testID="postpone-custom"
          label={t.postponeCustom}
          disabled={act.isPending}
          // An hour from now is the offer, not a default that gets sent: the
          // same starting point the edit sheet gives an item that never had a
          // time, and the same instant `oneHour` would have resolved to.
          onPress={() => {
            setLocal(localDateTimeFor(new Date(Date.now() + 3600_000), timezone));
            setPastTime(false);
          }}
          style={{ backgroundColor: p.sf2, borderRadius: 20, padding: 16, minHeight: 56, alignItems: 'flex-start', justifyContent: 'center', opacity: act.isPending ? 0.4 : 1 }}
        >
          <Txt size={16} weight={600}>{t.postponeCustom}</Txt>
        </Btn>
      )}
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
 * Title, importance, and when. The time half runs on the same two pieces the
 * capture review sheet runs on — `@react-native-community/datetimepicker` and
 * `localInstant.ts` — rather than a second date UI: the pickers work in the
 * device's zone and the conversion to an instant happens once, at save, so
 * nothing here ever parses a wall-clock string in whatever zone the host
 * happens to be in.
 *
 * ── Three answers about the time, not two ────────────────────────
 *
 * Untouched, moved, and removed. `buildTimePatch` is the one place that turns
 * them into fields: `undefined` sends nothing, an instant sends `dueDate` (or
 * `reminderTime` for an item that only ever had a reminder), and `null` sends
 * both as null. This sheet decides *which* of the three happened and nothing
 * else — duplicating the field rules here is how the two would drift.
 *
 * ── A past time is refused ───────────────────────────────────────
 *
 * The same rule, the same copy and the same moment as the capture edit sheet:
 * checked when Save is pressed, because `Date.now()` in a render body is an
 * impure call the compiler rules refuse — and because pressing Save is the
 * moment the answer matters. A reminder in the past is one that will never
 * fire, which is exactly why `applyEdits.ts` refuses it on the capture path.
 *
 * It judges a time the user *picked*, never one that was already there. This
 * product has no "overdue": an item whose hour has gone is still active, and a
 * sheet that refused to save it would mean a typo in yesterday's title could
 * never be fixed.
 *
 * The server enforces it too, since #352: `PATCH /api/mobile/commitments/:id`
 * answers 400 `dueDate must not be in the past` for a past `dueDate` or
 * `reminderTime`, through the same rule `applyEdits.ts` uses
 * (`lib/services/commitments/timeRules.ts`). The check here is not the
 * protection, then — it is the message, shown at the moment of the tap instead
 * of after a round trip.
 *
 * The two are not the same comparison, and deliberately so. `timeRules` uses
 * `<`, so an instant of exactly `now` is allowed; the `<=` below refuses it.
 * The difference is one millisecond, in the direction where the client is the
 * stricter of the two, which is the only direction that is safe: everything
 * this sheet lets through, the boundary also accepts. The reverse would be a
 * save that fails with a generic error after the round trip. Do not "fix" this
 * by loosening the client to `<` — a time the user picked at this exact
 * millisecond is already gone by the time the request lands.
 *
 * Only changed fields are sent. `usePatchCommitment` makes the write
 * conditional on the validator it remembered, so an edit from a screen another
 * device has already moved past is refused rather than silently winning.
 */
function EditSheet() {
  const { s, t, p, ar, lang, scheme, actions } = useApp();
  const timezone = useTimeZone();
  const query = useCommitment(s.detailId);
  const patch = usePatchCommitment();
  const commitment = query.data;
  const shownAt = commitment?.timeSpec.dueAt ?? commitment?.timeSpec.remindAt ?? null;
  const originalLocal = shownAt ? localDateTimeFor(new Date(shownAt), timezone) : '';

  const [title, setTitle] = useState(commitment?.title ?? '');
  const [level, setLevel] = useState<PriorityLevel>(commitment?.priority.level ?? 'normal');
  const [local, setLocal] = useState(originalLocal);
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);
  const [pastTime, setPastTime] = useState(false);

  const trimmed = title.trim();
  const hasTime = local !== '';
  const instant = hasTime ? instantForLocalDateTime(local, timezone) : null;
  const titleChanged = commitment !== undefined && trimmed !== commitment.title && trimmed.length > 0;
  const levelChanged = commitment !== undefined && level !== commitment.priority.level;
  const timeChanged = local !== originalLocal;

  // `useCallback` rather than a plain closure, and above the `commitment`
  // guard rather than below it: reading the clock has to happen in an event,
  // and a hook cannot sit after an early return.
  const save = React.useCallback(() => {
    if (!commitment || trimmed.length === 0) return;
    // Only a time the user just *chose*. An item whose hour has already gone is
    // ordinary here — there is no "overdue" in this product — and judging its
    // untouched time would mean a typo in the title could never be fixed again.
    if (timeChanged && instant !== null && instant.getTime() <= Date.now()) {
      setPastTime(true);
      return;
    }
    setPastTime(false);

    // `undefined` when the time was not touched, `null` when it was cleared.
    const edited = !timeChanged ? undefined : instant === null ? null : instant.toISOString();
    const body: CommitmentPatch = {
      ...buildTimePatch({ dueAt: commitment.timeSpec.dueAt, remindAt: commitment.timeSpec.remindAt }, edited),
    };
    if (trimmed !== commitment.title) body.title = trimmed;
    if (level !== commitment.priority.level) body.priority = level;
    if (Object.keys(body).length === 0) return;
    patch.mutate({ id: commitment.id, patch: body }, { onSuccess: actions.closeSheet });
  }, [actions, commitment, instant, level, patch, timeChanged, trimmed]);

  if (!commitment) return null;

  const changed = titleChanged || levelChanged || timeChanged;
  const problem = trimmed.length === 0 ? t.editItemEmpty : pastTime ? t.editItemPast : null;

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

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Txt size={13} color={p.mu}>{t.editItemWhen}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Txt size={13}>{t.editItemNoTime}</Txt>
          <Switch
            testID="edit-no-time"
            value={!hasTime}
            onValueChange={(off) => {
              // Turning it back on offers the time the item had, or an hour
              // from now for an item that never had one.
              setLocal(off ? '' : (originalLocal || localDateTimeFor(new Date(Date.now() + 3600_000), timezone)));
              setPastTime(false);
            }}
          />
        </View>
      </View>

      {hasTime ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn
            testID="edit-pick-date"
            label={t.editItemDate}
            onPress={() => setPicking('date')}
            style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
          >
            <Txt size={14}>{instant ? formatDate(instant, 'short', { locale: lang, timeZone: timezone }) : t.editItemDate}</Txt>
          </Btn>
          <Btn
            testID="edit-pick-time"
            label={t.editItemTime}
            onPress={() => setPicking('time')}
            style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 12, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}
          >
            <Txt size={14} latin>{instant ? ltr(formatTime(instant, { locale: lang, timeZone: timezone })) : t.editItemTime}</Txt>
          </Btn>
        </View>
      ) : null}

      {picking ? (
        <DateTimePicker
          testID="edit-picker"
          value={instant ?? new Date()}
          mode={picking}
          // Always 24-hour, for the reason the postpone sheet above gives:
          // `formatTime` sets `hourCycle: 'h23'` unconditionally, so the button
          // beside this wheel reads "18:00" in every language.
          is24Hour
          // The native picker's own chrome is light unless told otherwise, and
          // unreadable inside a dark sheet.
          themeVariant={scheme}
          // No `minimumDate` here, deliberately. This sheet edits an item that
          // may already have a time in the past, and the date it opens on would
          // then be below its own minimum. The past is refused on Save, where
          // the sheet can tell a time the user picked from one that was there.
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(event, picked) => {
            setPicking(Platform.OS === 'ios' ? picking : null);
            // A dismiss on Android carries the value the picker opened with.
            if (event.type === 'dismissed' || !picked) return;
            setLocal(localDateTimeFor(picked, timezone));
            // Their answer to the complaint; judged again on Save.
            setPastTime(false);
          }}
        />
      ) : null}

      {problem ? <Txt size={13} color={p.wm} testID="edit-problem">{problem}</Txt> : null}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pill testID="edit-save" label={t.editSave} onPress={save} disabled={!changed || trimmed.length === 0 || patch.isPending} style={{ flex: 1 }} />
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
