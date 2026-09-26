import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { chipSeparator, hasChip, toggleChip } from '../../ui/chipText';
import { CLARIFICATION_FREE_TEXT_MAX, optionLabel, questionText } from './clarificationCopy';
import { CIVIL_ZONE, civilDate, formatDate } from '../../i18n/format';
import type { CaptureProposalItem } from '../../api/schemas/capture';

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
 *
 * ── Options are one slot each; free text can combine them ────────
 *
 * By contract an option is one mutually exclusive value (one `optionId`, one
 * time). So where the question takes no free text (am/pm), a tap is the answer
 * and the options are radios. Where it does take free text, a tap writes the
 * option's words into the field instead of sending it (closure CL2b, complaint
 * #3), so somebody can say «الصبح، المسا»; a second tap takes it back out, and
 * «تمام» sends. A field holding exactly one option's words is sent as that
 * `optionId`, so the structured answer is kept whenever it is what was picked;
 * anything else is free text for the server to read. An option with no value
 * ("no specific time") is not a slot and cannot be combined with one: it is
 * still answered on tap.
 */
type ClarificationOption = NonNullable<CaptureProposalItem['clarification']>['options'][number];

/** A real time slot, as opposed to "no specific time", which carries no value. */
function isSlot(option: ClarificationOption): boolean {
  return Boolean(option.value.localTime || option.value.localDate);
}

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
  const [freeText, setFreeText] = useState('');
  const strings = t as unknown as Record<string, string>;
  const question = item.clarification;
  if (!question) return null;

  const heading = questionText(question.questionKey, question.params, strings, (key) => formatDate(civilDate(key), 'weekday', { locale: lang, timeZone: CIVIL_ZONE }));
  // A key this build has no words for. Rendering the key, or the raw params,
  // would put an internal token in front of somebody.
  if (!heading) return null;

  const typed = freeText.trim();
  // «تمام» with exactly one option's words in the field is that option.
  const answerFor = (text: string): { optionId: string } | { freeText: string } => {
    const only = question.options.find((option) =>
      isSlot(option) && optionLabel(option.labelKey, option.labelParams, strings) === text);
    return only ? { optionId: only.optionId } : { freeText: text };
  };
  // Only a question that offers "no specific time" can be skipped *into* an
  // answer (#474); anywhere else skipping just sets the question aside, and a
  // pill promising "without a time" there would be a promise the tap breaks.
  const skipsToNoTime = question.options.some((option) => !isSlot(option));

  return (
    <View style={{ gap: 14 }} testID="clarify-sheet">
      <View style={{ gap: 4, borderStartWidth: 3, borderStartColor: p.prop, paddingStart: 12 }} testID="capture-understanding">
        <Txt role="supporting" color={p.mu}>{t.captureUnderstood}</Txt>
        <Txt role="body">{item.title}</Txt>
      </View>
      <Txt role="supporting" color={p.mu} testID="clarify-position">
        {tr('clarifyRemaining', { n: Math.max(1, total - position + 1) })}
      </Txt>
      <Txt role="section" testID="clarify-question">{heading}</Txt>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {question.options.map((option) => {
          const label = optionLabel(option.labelKey, option.labelParams, strings);
          if (!label) return null;
          const combines = question.allowFreeText && isSlot(option);
          const checked = combines && hasChip(freeText, label);
          return (
            <Btn
              key={option.optionId}
              testID={`clarify-option-${option.optionId}`}
              label={label}
              disabled={busy}
              accessibilityRole={combines ? 'checkbox' : 'radio'}
              {...(combines ? { accessibilityState: { checked } } : {})}
              onPress={combines
                ? () => setFreeText((current) => toggleChip(current, label, chipSeparator(lang)))
                : () => onAnswer({ optionId: option.optionId })}
              style={{
                backgroundColor: busy ? p.dis : checked ? p.acs : p.sf2,
                borderRadius: 16, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: 'center',
              }}
            >
              <Txt size={15} weight={600} color={busy ? p.disTx : checked ? p.ac : p.tx}>{label}</Txt>
            </Btn>
          );
        })}
      </View>

      {question.allowFreeText ? (
        <View style={{ gap: 8 }}>
          <Txt size={12} color={p.mu}>{t.clarifyOwnWords}</Txt>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput
              testID="clarify-free-text"
              value={freeText}
              onChangeText={setFreeText}
              // Never below what the field holds: option taps are not cut.
              maxLength={Math.max(CLARIFICATION_FREE_TEXT_MAX, Array.from(freeText).length)}
              placeholder={t.orTypeTime}
              placeholderTextColor={p.mu}
              style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, fontSize: 14, minHeight: 48, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
            />
            <Pill
              testID="clarify-send"
              label={t.ok}
              disabled={busy || typed.length === 0 || Array.from(typed).length > CLARIFICATION_FREE_TEXT_MAX}
              onPress={() => onAnswer(answerFor(typed))}
              size={14}
              pad={12}
            />
          </View>
        </View>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="polite">
          <Txt role="supporting" color={p.wm} testID="clarify-error">{error}</Txt>
        </View>
      ) : null}

      {/* Skipping is an answer too. Where the question offers "no specific
          time", the review screen sends that answer and the item is saved
          without one (#474); otherwise the item stays flagged and #164's edit
          sheet can still fix it — a question nobody wants to answer must not
          be a wall. */}
      <Pill testID="clarify-skip" label={skipsToNoTime ? t.skipNoTime : t.clarifySkip} onPress={onSkip} kind="ghost" size={13} weight={400} pad={6} />
    </View>
  );
}
