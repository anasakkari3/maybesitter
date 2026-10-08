import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { CLARIFICATION_FREE_TEXT_MAX, freeSlotWords, optionLabel, questionText } from './clarificationCopy';
import { CIVIL_ZONE, civilDate, formatDate, formatRelativeDay } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { fill } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import type { CaptureProposalItem } from '../../api/schemas/capture';
import { instantForLocalDateTime } from './localInstant';

/**
 * The one question, rendered from keys (UC-2.5, #165).
 *
 * ── No server text reaches the screen ────────────────────────────
 *
 * The response carries `questionKey`, `params`, and per option a `labelKey` and
 * `labelParams`. Every word shown here comes from the locale files. A model
 * asked to phrase a clarification will eventually phrase one that is long, or
 * leading, or wrong in Arabic — and the answer is applied to somebody's
 * commitment, so a question they cannot trust is worse than no question.
 *
 * An unrecognised `questionKey` renders nothing and the caller opens #164's
 * edit sheet instead, which can express anything a fixed question cannot.
 *
 * The caller keys it by item id, so what was typed for one question never
 * carries into the next one's box.
 */
/** The day-part chips, whose time lands on a day the chip itself does not show. */
const DAY_PARTS: ReadonlySet<string> = new Set(['morning', 'afternoon', 'evening']);

export function ClarifySheet({
  item,
  position,
  total,
  busy,
  error,
  onAnswer,
  onSkip,
}: {
  item: CaptureProposalItem;
  /** "1 of 2" when several items are waiting. */
  position: number;
  total: number;
  busy: boolean;
  /** Why the last answer did not land, already in words. The question stays up. */
  error?: string | null;
  onAnswer(answer: { optionId?: string; freeText?: string }): void;
  onSkip(): void;
}) {
  const { t, tr, p, rtl, script, lang } = useApp();
  const timeZone = useTimeZone();
  const [freeText, setFreeText] = useState('');
  const strings = t as unknown as Record<string, string>;
  const question = item.clarification;
  if (!question) return null;

  // A day as the rows say it: «اليوم», «بكرا», a weekday, or a date past a week.
  const relativeDay = (localDate: string) => {
    const instant = instantForLocalDateTime(`${localDate}T12:00`, timeZone);
    return instant ? formatRelativeDay(instant, { locale: lang, timeZone }) : null;
  };
  // Free times (M4a R002): the question says these are times the person is
  // free, and each chip names its day and its hour.
  const offersFreeSlots = question.options.some((option) => option.labelKey === 'freeSlot');
  const heading = offersFreeSlots
    ? fill(t.yFreeSlotsAsk, { title: isolateAuto(question.params.title ?? item.title) })
    : questionText(question.questionKey, question.params, strings, (key) => formatDate(civilDate(key), 'weekday', { locale: lang, timeZone: CIVIL_ZONE }));
  // A key this build has no words for. Rendering the key, or the raw params,
  // would put an internal token in front of somebody.
  if (!heading) return null;

  const typed = freeText.trim();
  // The box asks for what the question asks for: «أي يوم؟» is answered with a
  // day, not «أو اكتب وقت» (chat UAT 2026-09-30).
  // Only a question that offers "no specific time" can be skipped *into* an
  // answer (#474); anywhere else skipping just sets the question aside, and a
  // pill promising "without a time" there would be a promise the tap breaks.
  const skipsToNoTime = question.options.some((option) => !option.value.localTime && !option.value.localDate);

  return (
    <View style={{ gap: 14 }} testID="clarify-sheet">
      <View style={{ gap: 4, borderStartWidth: 3, borderStartColor: p.prop, paddingStart: 12 }} testID="capture-understanding">
        <Txt role="supporting" color={p.mu}>{t.captureUnderstood}</Txt>
        <Txt role="body">{item.title}</Txt>
      </View>
      <Txt role="supporting" color={p.mu} testID="clarify-position">
        {tr('clarifyRemaining', { n: Math.max(1, total - position + 1) })}
      </Txt>
      <Txt role="section" size={17} testID="clarify-question">{heading}</Txt>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {question.options.map((option) => {
          const slot = option.labelKey === 'freeSlot' ? freeSlotWords(option.value, relativeDay, strings) : null;
          const label = option.labelKey === 'freeSlot' ? slot?.label ?? null : optionLabel(option.labelKey, option.labelParams, strings);
          // A chip with a date or a time this build cannot read is left out:
          // a time nobody can name is not one to offer.
          if (!label) return null;
          // A day-part chip applies a time on a day; its label says which day,
          // so «الصبح» is not heard as tomorrow's when it is today's (M4A-R9-003).
          const day = DAY_PARTS.has(option.labelKey) && option.value.localDate ? relativeDay(option.value.localDate) : null;
          return (
            <Btn
              key={option.optionId}
              testID={`clarify-option-${option.optionId}`}
              label={slot ? slot.a11y : day ? `${label}, ${day}` : label}
              disabled={busy}
              accessibilityRole="radio"
              onPress={() => onAnswer({ optionId: option.optionId })}
              // Quick replies, drawn as the Stitch chips (03b): 44 tall, round, outlined.
              style={{ backgroundColor: busy ? p.dis : p.sf2, borderRadius: 999, borderWidth: 1, borderColor: busy ? p.dis : p.lnStrong, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' }}
            >
              <Txt size={13} weight={600} color={busy ? p.disTx : p.tx}>{label}</Txt>
            </Btn>
          );
        })}
      </View>

      {question.allowFreeText ? (
        <View style={{ gap: 8 }}>
          <Txt size={13} color={p.mu}>{t.clarifyOwnWords}</Txt>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput
              testID="clarify-free-text"
              value={freeText}
              onChangeText={setFreeText}
              editable={!busy}
              maxLength={CLARIFICATION_FREE_TEXT_MAX}
              placeholder={question.questionKey === 'ask_day' ? t.orTypeDay : t.orTypeTime}
              placeholderTextColor={p.mu}
              style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 999, borderWidth: 1, borderColor: p.lnStrong, paddingVertical: 12, paddingHorizontal: 16, fontSize: 15, minHeight: 48, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
            />
            <Pill
              testID="clarify-send"
              label={t.ok}
              disabled={busy || typed.length === 0}
              onPress={() => onAnswer({ freeText: typed })}
              size={14}
              pad={12}
            />
          </View>
        </View>
      ) : null}

      <LiveRegion>
        {error ? <Txt role="supporting" color={p.wm} testID="clarify-error">{error}</Txt> : null}
      </LiveRegion>

      {/* Skipping is an answer too. Where the question offers "no specific
          time", the review screen sends that answer and the item is saved
          without one (#474); otherwise the item stays flagged and #164's edit
          sheet can still fix it — a question nobody wants to answer must not
          be a wall. */}
      <Pill testID="clarify-skip" label={skipsToNoTime ? t.skipNoTime : t.clarifySkip} onPress={onSkip} disabled={busy} kind="ghost" size={13} weight={500} pad={6} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}
