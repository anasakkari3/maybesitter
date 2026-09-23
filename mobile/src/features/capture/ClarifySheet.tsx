import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import { CLARIFICATION_FREE_TEXT_MAX, optionLabel, questionText } from './clarificationCopy';
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
 */
export function ClarifySheet({
  item,
  position,
  total,
  busy,
  onAnswer,
  onSkip,
}: {
  item: CaptureProposalItem;
  /** "1 of 2" when several items are waiting. */
  position: number;
  total: number;
  busy: boolean;
  onAnswer(answer: { optionId?: string; freeText?: string }): void;
  onSkip(): void;
}) {
  const { t, tr, p, rtl, script } = useApp();
  const [freeText, setFreeText] = useState('');
  const strings = t as unknown as Record<string, string>;
  const question = item.clarification;
  if (!question) return null;

  const heading = questionText(question.questionKey, question.params, strings);
  // A key this build has no words for. Rendering the key, or the raw params,
  // would put an internal token in front of somebody.
  if (!heading) return null;

  const typed = freeText.trim();

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
          return (
            <Btn
              key={option.optionId}
              testID={`clarify-option-${option.optionId}`}
              label={label}
              disabled={busy}
              accessibilityRole="radio"
              onPress={() => onAnswer({ optionId: option.optionId })}
              style={{ backgroundColor: busy ? p.dis : p.sf2, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 18, minHeight: 48, justifyContent: 'center' }}
            >
              <Txt size={15} weight={600} color={busy ? p.disTx : p.tx}>{label}</Txt>
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
              maxLength={CLARIFICATION_FREE_TEXT_MAX}
              placeholder={t.orTypeTime}
              placeholderTextColor={p.mu}
              style={{ flex: 1, backgroundColor: p.sf2, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, fontSize: 14, minHeight: 48, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
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

      {/* Skipping is an answer too. Where the question offers "no specific
          time", the review screen sends that answer and the item is saved
          without one (#474); otherwise the item stays flagged and #164's edit
          sheet can still fix it — a question nobody wants to answer must not
          be a wall. */}
      <Pill testID="clarify-skip" label={t.skipNoTime} onPress={onSkip} kind="ghost" size={13} weight={400} pad={6} />
    </View>
  );
}
