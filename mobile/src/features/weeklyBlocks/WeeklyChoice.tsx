import React from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useLayoutMode } from '../../theme/textScale';
import { Btn, Txt } from '../../ui/primitives';
import type { WeeklyBlockOffer } from '../../api/schemas/weeklyBlocks';
import { weeklyA11yLabel, weeklyLine } from './weeklyText';
import { isolateAuto } from '../../i18n/bidi';

/**
 * «كل أسبوع» or «مرة وحدة بس», on a Review card whose words said "every
 * Saturday" (weekly fixed blocks).
 *
 * The block itself — «تدريب · كل سبت · 10:00–16:00» — is read off the
 * server's offer, never re-derived from the sentence here. Choosing is not
 * saving: the choice travels with the existing confirm as
 * `weeklyBlockItemIds`, and until that button is pressed nothing exists.
 *
 * Two radios rather than a switch, because both answers are real outcomes
 * with their own sentence under them, and a switch labelled "weekly" says
 * nothing about what "off" does. At the large text sizes they stack, so
 * neither label is cut.
 *
 * When an edit has moved the item (a new time, a place reminder), the server
 * would refuse the weekly block with it; the choice is then shown as "once",
 * «كل أسبوع» is disabled, and the line says why and where weekly hours are
 * changed instead.
 */
export function WeeklyChoice({ itemId, offer, title, choice, locked, onChoose }: {
  itemId: string;
  offer: WeeklyBlockOffer;
  /** The block's title: the offer's, or the card's edited title, which carries onto the block. */
  title: string;
  choice: 'weekly' | 'once';
  locked: boolean;
  onChoose: (weekly: boolean) => void;
}) {
  const { t, p, lang } = useApp();
  const stacked = useLayoutMode() !== 'normal';
  const shape = { ...offer, title };
  const option = (weekly: boolean) => {
    const selected = (choice === 'weekly') === weekly;
    const disabled = weekly && locked;
    const label = weekly ? t.wbReviewWeekly : t.wbReviewOnce;
    return (
      <Btn
        testID={`review-weekly-${weekly ? 'every' : 'once'}-${itemId}`}
        accessibilityRole="radio"
        accessibilityState={{ selected, disabled }}
        label={label}
        disabled={disabled}
        onPress={disabled ? undefined : () => onChoose(weekly)}
        scaleTo={0.97}
        style={{
          minHeight: 44, justifyContent: 'center', alignItems: 'center',
          paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999,
          backgroundColor: selected ? p.acs : p.sf,
          borderWidth: selected ? 2 : 1, borderColor: selected ? p.acd : p.ln,
          ...(stacked ? { alignSelf: 'stretch' } : {}),
        }}
      >
        <Txt size={14} weight={selected ? 600 : 400} color={disabled ? p.mu : selected ? p.acd : p.tx}>{label}</Txt>
      </Btn>
    );
  };
  return (
    <View
      testID={`review-weekly-${itemId}`}
      style={{ alignSelf: 'stretch', gap: 8, backgroundColor: p.sf2, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'flex-start' }}
    >
      {/* Read aloud as words — «كل سبت، من 10:00 لـ 16:00» — not as a dash.
          The person's title is a line of its own: in one line with the days,
          a Latin title wrapped «كل» away from «سبت» and read as
          «كل · I have an internship / 10:00–16:00 · سبت» (UAT 2026-09-30, u37). */}
      <View accessible accessibilityLabel={weeklyA11yLabel(shape, lang)} testID={`review-weekly-spoken-${itemId}`} style={{ gap: 2 }}>
        <Txt size={14} weight={600} testID={`review-weekly-title-${itemId}`}>{isolateAuto(shape.title)}</Txt>
        <Txt size={13} testID={`review-weekly-line-${itemId}`}>{weeklyLine(shape, lang, { withTitle: false })}</Txt>
      </View>
      <Txt size={13} color={p.mu}>{t.wbReviewQuestion}</Txt>
      <View accessibilityRole="radiogroup" accessibilityLabel={t.wbReviewQuestion} style={{ flexDirection: stacked ? 'column' : 'row', flexWrap: 'wrap', gap: 8, alignSelf: 'stretch' }}>
        {option(true)}
        {option(false)}
      </View>
      <Txt size={12} color={p.mu} lh={1.5} testID={`review-weekly-note-${itemId}`}>
        {locked ? t.wbReviewLocked : choice === 'weekly' ? t.wbReviewWeeklyNote : t.wbReviewOnceNote}
      </Txt>
    </View>
  );
}
