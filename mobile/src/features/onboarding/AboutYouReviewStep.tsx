import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { isolate } from '../../i18n/bidi';
import { Btn, Card, Txt } from '../../ui/primitives';
import { OnboardingChrome } from './OnboardingChrome';
import { acceptedFrom, initialChoices, type AcceptedSuggestion, type ReviewChoice } from './aboutYou';
import type { ProfileSuggestion } from '../../api/schemas/profile';

/**
 * "Is any of this right?" (UC-2.7b, #168).
 *
 * ── Every box starts unticked ────────────────────────────────────
 *
 * These are guesses a model made about a person from a paragraph they wrote.
 * A pre-ticked box would make "nothing persists without explicit
 * confirmation" false while still looking like a choice — the user would be
 * *unticking* to prevent something, which is the opposite of consenting to it.
 *
 * ── The label says who said it ───────────────────────────────────
 *
 * Each row is marked "Suggested by AI" until the user edits it. That is not
 * decoration: it is the difference between a sentence they wrote and one a
 * model wrote about them, and after an edit the stored fact really does change
 * provenance, so the label stops being true and stops being shown.
 *
 * ── Saving nothing is a first-class outcome ──────────────────────
 *
 * The primary button reads "Save nothing" when nothing is ticked, rather than
 * being disabled. Somebody who read four guesses about themselves and agreed
 * with none of them has given a clear answer, and the screen should let them
 * give it rather than making them find the Skip.
 */
export function AboutYouReviewStep({
  suggestions,
  onSave,
  onBack,
  saving = false,
}: {
  suggestions: readonly ProfileSuggestion[];
  onSave: (accepted: AcceptedSuggestion[]) => void;
  onBack: () => void;
  saving?: boolean;
}) {
  const { t, p, rtl } = useApp();
  const [choices, setChoices] = useState<ReviewChoice[]>(() => initialChoices(suggestions.length));
  const [editing, setEditing] = useState<number | null>(null);

  const ticked = choices.filter((choice) => choice.accepted).length;

  const update = (index: number, patch: Partial<ReviewChoice>) => {
    setChoices((previous) => previous.map((choice, i) => (i === index ? { ...choice, ...patch } : choice)));
  };

  if (suggestions.length === 0) {
    return (
      <OnboardingChrome
        step="about"
        title={t.obAboutReviewTitle}
        testID="onboarding-about-review-empty"
        primary={{ label: t.obContinue, onPress: () => onSave([]) }}
      >
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5} testID="about-review-none">{t.obAboutReviewNone}</Txt>
        </Card>
      </OnboardingChrome>
    );
  }

  return (
    <OnboardingChrome
      step="about"
      title={t.obAboutReviewTitle}
      testID="onboarding-about-review"
      primary={{
        label: ticked === 0 ? t.obAboutSaveNone : t.obAboutSaveSelected,
        onPress: () => onSave(acceptedFrom(choices, suggestions)),
        disabled: saving,
      }}
      secondary={{ label: t.obBack, onPress: onBack }}
    >
      <Txt size={15} color={p.mu} lh={1.5}>{t.obAboutReviewLede}</Txt>

      {suggestions.map((suggestion, index) => {
        const choice = choices[index]!;
        const edited = choice.edited !== null;
        return (
          <Card key={`${suggestion.content}-${index}`} pad={16} style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <Btn
                testID={`about-review-tick-${index}`}
                label={suggestion.content}
                onPress={() => update(index, { accepted: !choice.accepted })}
                scaleTo={0.9}
                hitSlop={8}
                style={{
                  width: 26, height: 26, borderRadius: 13, marginTop: 2,
                  borderWidth: 2, borderColor: choice.accepted ? p.ac : p.ln,
                  backgroundColor: choice.accepted ? p.ac : 'transparent',
                }}
              >
                <View />
              </Btn>
              <View style={{ flex: 1, gap: 6 }}>
                {editing === index ? (
                  <TextInput
                    testID={`about-review-edit-${index}`}
                    accessibilityLabel={t.memoryEdit}
                    value={choice.edited ?? suggestion.content}
                    onChangeText={(value) => update(index, { edited: value })}
                    maxLength={80}
                    multiline
                    style={{ color: p.tx, fontSize: 15, textAlign: rtl ? 'right' : 'left' }}
                  />
                ) : (
                  <Txt size={15} lh={1.5} testID={`about-review-content-${index}`}>
                    {isolate(choice.edited ?? suggestion.content)}
                  </Txt>
                )}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {/* Once they have rewritten it, it is theirs — and the stored
                      fact really does change provenance, so the label goes. */}
                  {edited ? null : (
                    <View style={{ backgroundColor: p.sf2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                      <Txt size={12} color={p.mu} testID={`about-review-label-${index}`}>{t.obAboutSuggested}</Txt>
                    </View>
                  )}
                  <View style={{ flex: 1 }} />
                  <Btn
                    testID={`about-review-edit-open-${index}`}
                    label={t.memoryEdit}
                    onPress={() => setEditing(editing === index ? null : index)}
                    hitSlop={8}
                    style={{ minHeight: 32, justifyContent: 'center' }}
                  >
                    <Txt size={14} color={p.ac}>{t.memoryEdit}</Txt>
                  </Btn>
                </View>
              </View>
            </View>
          </Card>
        );
      })}
    </OnboardingChrome>
  );
}
