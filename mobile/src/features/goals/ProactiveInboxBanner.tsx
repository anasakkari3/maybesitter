import React from 'react';
import { generateIntelligenceSuggestions, getIntelligenceInbox } from '../../api/endpoints/intelligence';
import { forbiddenReason } from '../../api/ui/userFacingMessage';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { claimVisit, recordVisitAnswer, recordVisitFailure } from '../../lib/deviceSettings/visitThrottle';
import type { IntelligenceSuggestion } from '../../api/schemas/intelligence';
import { isolateAuto } from '../../i18n/bidi';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { TextLink } from '../../ui/chrome';
import { ReferenceCard, useReferencePalette } from '../../ui/referenceDesign';

/**
 * A quiet entry on Today, in every environment: whether the loop is on is the
 * server's answer (its gate and kill switch), not the build's. Opening Today
 * asks for suggestions as a visit when the visit throttle allows
 * (`visitThrottle.ts`) and otherwise reads what is already waiting; a
 * loop that is off, or any failure, shows nothing — never an error, never a
 * claim that something was suggested. Review happens on «يتابع لك».
 */
export function ProactiveInboxBanner() {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const uid = useOptionalAuth()?.user?.uid ?? '';
  const [items, setItems] = React.useState<IntelligenceSuggestion[]>([]);
  React.useEffect(() => {
    // Nobody known yet (the session is still being read): nothing to ask for.
    if (!uid) return undefined;
    let alive = true;
    const controller = new AbortController();
    const show = (suggestions: IntelligenceSuggestion[]) => {
      if (alive) setItems(suggestions.filter(item => item.status === 'pending'));
    };
    void (async () => {
      // Asked as a visit only when the throttle allows; every other mount
      // reads what is already waiting, which never runs the model.
      if (await claimVisit(uid)) {
        try {
          const answer = await generateIntelligenceSuggestions({ signal: controller.signal, visit: true });
          recordVisitAnswer(uid, answer.nextVisitAt);
          show(answer.suggestions);
        } catch (cause) {
          recordVisitFailure(uid, forbiddenReason(cause) !== null);
        }
        return;
      }
      try { show((await getIntelligenceInbox()).suggestions); }
      catch { /* Off, refused or offline: Today shows nothing here. */ }
    })();
    return () => { alive = false; controller.abort(); };
  }, [uid]);
  const first = items[0];
  if (!first) return null;
  return <ReferenceCard pad={18} testID="today-proactive-suggestion">
    <Txt size={15} weight={600}>{t.xIntelligenceTitle}</Txt>
    <Txt size={16}>{isolateAuto(first.title)}</Txt>
    <Txt size={13} color={p.mu}>{isolateAuto(first.reason)}</Txt>
    <Txt size={13} color={p.mu}>{t.suggestionNote}</Txt>
    <TextLink label={t.xIntelligenceReview} onPress={() => actions.switchTab('watching')} testID="today-proactive-review" />
  </ReferenceCard>;
}
