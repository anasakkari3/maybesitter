/**
 * «حضّرني» — the notes sheet for one meeting (closure lane CL5a).
 *
 * One question, «شو الاجتماع وشو بدك تحضّر؟», one field, one button. What
 * the person types goes to `/api/mobile/meetings/prepare` once, and what comes
 * back is an ordinary capture proposal: the sheet hands it to the capture flow
 * with `adoptProposal`, exactly as the share screen does, so the review, the
 * edit sheet, the confirm and Undo are the ones the product already has — and
 * nothing is saved until the person confirms it there.
 *
 * ── The notes live in this sheet and nowhere else ────────────────
 *
 * Component state, not the app store and not the capture draft: closing the
 * sheet forgets them, and a failure keeps them so «جرّب كمان مرّة» does not
 * mean typing it all again.
 *
 * ── Only the meeting's times go with them ───────────────────────
 *
 * The target is a busy block's start and end, or a commitment's. A calendar
 * event's title is never read (`busyBlocks.ts`), so there is none to send.
 */
import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import { family, LINE_HEIGHT } from '../../theme/fonts';
import { usePrepareMeeting } from '../../api/queries';
import { ValidationError } from '../../api/errors';
import { userFacingMessage } from '../../api/ui/userFacingMessage';
import { useCaptureFlow } from '../capture/CaptureProvider';
import { MAX_CAPTURE_LENGTH } from '../capture/captureMachine';
import { Pill, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { useKeyboardInset } from '../../ui/keyboard';

export function MeetingPrepSheet() {
  const { s, t, p, lang, rtl, script, actions } = useApp();
  const timezone = useTimeZone();
  const flow = useCaptureFlow();
  const prepare = usePrepareMeeting();
  const insets = useSafeAreaInsets();
  // Lifted onto the keyboard (the host is an AvoidKeyboard): the keyboard
  // covers the home indicator, so its clearance is room the notes need.
  const keyboardUp = useKeyboardInset() > 0;
  const [notes, setNotes] = useState('');
  const target = s.meetingPrep;
  if (!target) return null;

  const trimmed = notes.trim();
  const tooLong = notes.length > MAX_CAPTURE_LENGTH;
  const start = new Date(target.startAt);
  const when = `${formatRelativeDay(start, { locale: lang, timeZone: timezone })} · ${ltr(formatTime(start, { locale: lang, timeZone: timezone }))}`;
  // A dentist or an exam is «الموعد», not «الاجتماع» (the target says which).
  const appointment = target.appointment === true;
  const question = appointment ? t.xPrepareQuestionAppointment : t.xPrepareQuestion;
  // The one refusal with a sentence of its own: the meeting started while the
  // sheet was open. Everything else is the shared copy table's.
  const problem = prepare.error
    ? (prepare.error instanceof ValidationError && prepare.error.reason === 'meeting_too_soon'
      ? (appointment ? t.xPrepareTooSoonAppointment : t.xPrepareTooSoon)
      : userFacingMessage(prepare.error, t))
    : null;

  const submit = () => {
    if (!trimmed || tooLong || prepare.isPending) return;
    prepare.mutate({ notes: trimmed, startAt: target.startAt, endAt: target.endAt }, {
      onSuccess: (result) => {
        // Into review, as a share arrives there: the flow is reset and holds
        // this proposal before the capture task opens, so it does not start
        // on an empty composer.
        flow.adoptProposal(result.proposal, 'meeting', {
          remindAt: result.prep.remindAt,
          silentBecause: result.prep.silentBecause,
          adjustment: result.prep.adjustment,
          appointment,
          itemId: result.prep.itemId,
          startAt: result.prep.startAt,
        });
        actions.go('capture');
      },
    });
  };

  return (
    // The body scrolls and shrinks to the room above the keyboard; «اقترح
    // خطوة» is pinned under it, so it stays in sight while they type (N2).
    <View style={{ flexShrink: 1 }} testID="meeting-prep-sheet">
      <ScrollView
        testID="meeting-prep-scroll"
        style={{ flexGrow: 0 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, gap: 14 }}
      >
      <View style={{ gap: 4, alignItems: 'flex-start' }}>
        <View accessibilityRole="header"><Txt role="section" testID="meeting-prep-question">{question}</Txt></View>
        <Txt size={14} color={p.mu} testID="meeting-prep-when">{fill(appointment ? t.xPrepareWhenAppointment : t.xPrepareWhen, { time: when })}</Txt>
      </View>

      <View>
        <TextInput
          testID="meeting-prep-notes"
          value={notes}
          onChangeText={setNotes}
          placeholder={t.xPreparePlaceholder}
          placeholderTextColor={p.mu}
          accessibilityLabel={question}
          multiline
          scrollEnabled
          autoFocus
          textAlignVertical="top"
          editable={!prepare.isPending}
          style={{
            // With the keyboard up the room is what is left above it — ~118pt
            // of scroller on an SE with the banner (FY3 review I2) — so the
            // box asks for less and scrolls inside itself past 110.
            minHeight: keyboardUp ? 88 : 120, maxHeight: keyboardUp ? 110 : 220, backgroundColor: p.bg, borderWidth: 1,
            borderColor: tooLong ? p.wm : p.lnStrong, borderRadius: 20,
            paddingTop: 14, paddingHorizontal: 16, paddingBottom: 28,
            fontSize: 17, lineHeight: Math.round(17 * LINE_HEIGHT[script]), color: p.tx, fontFamily: family(400, script),
            textAlign: rtl ? 'right' : 'left', writingDirection: rtl ? 'rtl' : 'ltr',
          }}
        />
        {notes.length > MAX_CAPTURE_LENGTH - 200 ? (
          <Txt size={11} color={tooLong ? p.wm : p.mu} latin testID="meeting-prep-counter" style={{ position: 'absolute', bottom: 10, end: 16 }}>
            {fill(t.captureCounter, { n: String(notes.length) })}
          </Txt>
        ) : null}
      </View>

      {/* Announced when it appears: the field keeps focus, and a refusal
          nobody hears reads as a button that did nothing. The region is
          mounted first, so TalkBack hears the line arrive (review I1). */}
      <LiveRegion alert>
        {problem ? <Txt size={13} color={p.wm} testID="meeting-prep-problem">{problem}</Txt> : null}
      </LiveRegion>
      </ScrollView>

      <View testID="meeting-prep-footer" style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: keyboardUp ? 12 : insets.bottom + 24 }}>
        <Pill
          testID="meeting-prep-submit"
          label={prepare.isPending ? t.xPrepareWorking : t.xPrepareSubmit}
          onPress={submit}
          disabled={!trimmed || tooLong || prepare.isPending}
          size={16}
          pad={14}
        />
      </View>
    </View>
  );
}
