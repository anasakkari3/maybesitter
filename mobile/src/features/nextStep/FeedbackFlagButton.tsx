import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAlphaFlag } from '../../api/queries';
import { ForbiddenError } from '../../api/errors';
import { family } from '../../theme/fonts';
import { Btn, Pill, Txt } from '../../ui/primitives';
import type { AlphaFeedbackCategory } from '../../api/schemas/feedback';

/** The five the route accepts. A sixth would be refused. */
const CATEGORIES: readonly AlphaFeedbackCategory[] = [
  'recommendation_wrong',
  'misunderstood_me',
  'not_useful',
  'invasive',
  'technical_problem',
];

const CATEGORY_KEY: Record<AlphaFeedbackCategory, string> = {
  recommendation_wrong: 'flagRecommendationWrong',
  misunderstood_me: 'flagMisunderstoodMe',
  not_useful: 'flagNotUseful',
  invasive: 'flagInvasive',
  technical_problem: 'flagTechnicalProblem',
};

/** The note the route reads. Longer is truncated server-side; refused here. */
const MAX_NOTE = 500;

/**
 * Saying a suggestion was wrong (UC-2.R3 #173 step 4).
 *
 * ── The categories are the server's, not a free-text box ─────────
 *
 * Five fixed reasons and an optional note. A bare text field would collect
 * whatever somebody typed about their own life and put it in an operator's
 * inbox; a category is a fact about the *suggestion*, which is the thing being
 * reported. The note is optional and never required to send.
 *
 * ── A 403 says so plainly ────────────────────────────────────────
 *
 * Feedback collection can be off. The button then says it is not being
 * collected rather than failing silently or pretending it was sent — telling
 * somebody "thanks" for something that went nowhere is the version of this
 * that costs trust.
 */
export function FeedbackFlagButton({ proposalId, commitmentId }: {
  proposalId: string;
  commitmentId?: string | undefined;
}) {
  const { t, p, rtl, script } = useApp();
  const flag = useAlphaFlag();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<'sent' | 'disabled' | null>(null);
  const strings = t as unknown as Record<string, string>;

  const send = (category: AlphaFeedbackCategory) => {
    if (flag.isPending) return;
    flag.mutate(
      { proposalId, category, ...(note.trim() ? { note: note.trim() } : {}), ...(commitmentId ? { commitmentId } : {}) },
      {
        onSuccess: () => { setOutcome('sent'); setOpen(false); },
        onError: (error) => {
          setOutcome(error instanceof ForbiddenError ? 'disabled' : null);
          setOpen(false);
        },
      },
    );
  };

  if (outcome) {
    return (
      <Txt size={12} color={p.mu} testID={`next-step-flag-${outcome}`}>
        {outcome === 'sent' ? t.flagSent : t.flagDisabled}
      </Txt>
    );
  }

  if (!open) {
    return (
      <Btn
        testID="next-step-flag"
        label={t.flagOpen}
        onPress={() => setOpen(true)}
        hitSlop={10}
        style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
      >
        <Txt size={12} color={p.mu}>{t.flagOpen}</Txt>
      </Btn>
    );
  }

  return (
    <View style={{ gap: 10 }} testID="next-step-flag-sheet">
      <Txt size={14} weight={600}>{t.flagTitle}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {CATEGORIES.map((category) => (
          <Btn
            key={category}
            testID={`next-step-flag-${category}`}
            label={strings[CATEGORY_KEY[category]]!}
            accessibilityRole="radio"
            disabled={flag.isPending}
            onPress={() => send(category)}
            style={{ backgroundColor: flag.isPending ? p.dis : p.sf2, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' }}
          >
            <Txt size={13}>{strings[CATEGORY_KEY[category]]}</Txt>
          </Btn>
        ))}
      </View>
      <TextInput
        testID="next-step-flag-note"
        value={note}
        onChangeText={setNote}
        maxLength={MAX_NOTE}
        placeholder={t.flagNote}
        placeholderTextColor={p.mu}
        multiline
        style={{ backgroundColor: p.sf2, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, fontSize: 13, minHeight: 44, color: p.tx, fontFamily: family(400, script), textAlign: rtl ? 'right' : 'left' }}
      />
      <Pill testID="next-step-flag-close" label={t.back} onPress={() => setOpen(false)} kind="ghost" size={13} weight={400} pad={6} />
    </View>
  );
}
