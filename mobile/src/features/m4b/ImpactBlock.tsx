import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useTimeZone } from '../../i18n/timezone';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { isolateAuto, stripIsolates } from '../../i18n/bidi';
import { fill, ltr } from '../../i18n/strings';
import type { CaptureProposalItem } from '../../api/schemas/capture';
import type { EveningImpact, Readiness } from '../../api/schemas/m4b';
import { Btn, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { useAnnounceOnIos } from '../../ui/announce';

const ANSWERS: readonly Readiness[] = ['ready', 'not_ready', 'unsure'];

/**
 * An evening that can hurt the next morning, on the capture card (M4b R2.3,
 * owner decision D6): the fact and the risk in one line — never an order —
 * then «حاضر؟» as one radio group with one accessible heading. «لسا لا» and
 * «مش متأكد» bring a preparation card into the list (nothing is saved before
 * «احفظ»); with no free time before the evening, one line says so.
 */
export function ImpactBlock({ itemId, impact, itemTitle, disabled, error, onAnswer }: {
  itemId: string;
  impact: EveningImpact;
  itemTitle: string;
  disabled: boolean;
  /** Why the last answer did not go through, already in the person's language. */
  error: string | null;
  onAnswer: (readiness: Readiness) => void;
}) {
  const { t, p, lang } = useApp();
  const timezone = useTimeZone();
  const format = { locale: lang, timeZone: timezone };
  const start = new Date(impact.otherStartsAt);
  const when = `${isolateAuto(formatRelativeDay(start, { ...format, now: new Date() }))} ${ltr(formatTime(start, format))}`;
  const line = fill(impact.role === 'evening' ? t.zImpactEvening : t.zImpactImportant, { title: isolateAuto(impact.otherTitle), when });
  // The question is about the important item: the other one on the evening
  // card, this one on the exam card.
  const importantTitle = impact.role === 'evening' ? impact.otherTitle : itemTitle;
  const ask = fill(t.zReadyAsk, { title: isolateAuto(importantTitle) });
  const label: Record<Readiness, string> = { ready: t.zReadyYes, not_ready: t.zReadyNo, unsure: t.zReadyUnsure };
  // The result of the person's answer, said where it lands (TalkBack via the
  // live region, VoiceOver via the announcement).
  const noSlot = impact.prep?.state === 'no_slot';
  const result = noSlot ? t.zPrepNoSlot : impact.readiness === 'ready' ? t.zReadyOk : null;
  useAnnounceOnIos(error ?? result);

  return (
    <View style={{ alignSelf: 'stretch', gap: 8 }}>
      <View testID={`impact-line-${itemId}`} accessible accessibilityLabel={stripIsolates(line)}
        style={{ backgroundColor: p.wms, borderStartWidth: 4, borderStartColor: p.wm, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 }}>
        <Txt size={13} weight={500} color={p.wm}>{line}</Txt>
      </View>
      <View testID={`impact-ready-group-${itemId}`} accessibilityRole="radiogroup" accessibilityLabel={stripIsolates(ask)} style={{ gap: 6 }}>
        <Txt size={13} weight={600} color={p.tx}>{ask}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {ANSWERS.map((answer) => {
            const checked = impact.readiness === answer;
            return (
              <Btn
                key={answer}
                testID={`impact-ready-${itemId}-${answer}`}
                accessibilityRole="radio"
                accessibilityState={{ checked, disabled }}
                label={label[answer]}
                disabled={disabled}
                onPress={() => { if (!checked) onAnswer(answer); }}
                scaleTo={0.97}
                style={{
                  minHeight: 44, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, justifyContent: 'center',
                  borderWidth: 1, borderColor: checked ? p.ac : p.ln, backgroundColor: checked ? p.ac : p.sf,
                }}
              >
                <Txt size={13} weight={600} color={checked ? p.onAccent : p.tx}>{label[answer]}</Txt>
              </Btn>
            );
          })}
        </View>
        <LiveRegion>
          {error ? <Txt size={13} color={p.wm} testID={`impact-ready-error-${itemId}`}>{error}</Txt>
            : noSlot ? <Txt size={13} color={p.mu} testID={`impact-prep-noslot-${itemId}`}>{t.zPrepNoSlot}</Txt>
              : impact.readiness === 'ready' ? <Txt size={13} color={p.mu} testID={`impact-ready-ok-${itemId}`}>{t.zReadyOk}</Txt> : null}
        </LiveRegion>
      </View>
    </View>
  );
}

/**
 * Says once, when a preparation card arrives, that it was added and when —
 * one speech event, on both platforms (the A11Y-002 lesson: a focus move and
 * an announcement compete).
 */
export function useAnnounceNewPrep(items: readonly CaptureProposalItem[]): void {
  const { t, lang } = useApp();
  const timezone = useTimeZone();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prep = items.filter((item) => item.generated?.kind === 'evening_impact_prep');
    if (seen.current === null) {
      // What was there when the screen opened is not news.
      seen.current = new Set(prep.map((item) => item.itemId));
      return;
    }
    for (const item of prep) {
      if (seen.current.has(item.itemId)) continue;
      seen.current.add(item.itemId);
      const at = item.resolvedTime ? new Date(item.resolvedTime) : null;
      const when = at ? `${formatRelativeDay(at, { locale: lang, timeZone: timezone, now: new Date() })} ${formatTime(at, { locale: lang, timeZone: timezone })}` : '';
      AccessibilityInfo.announceForAccessibility(stripIsolates(fill(t.zPrepAdded, { when })).trim());
    }
  }, [items, lang, t, timezone]);
}
