import React from 'react';
import { generateIntelligenceSuggestions } from '../../api/endpoints/intelligence';
import type { IntelligenceSuggestion } from '../../api/schemas/intelligence';
import { isolateAuto } from '../../i18n/bidi';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { TextLink } from '../../ui/chrome';
import { ReferenceCard, useReferencePalette } from '../../ui/referenceDesign';

/**
 * A quiet entry on Today, in every environment: whether the loop is on is the
 * server's answer (its gate and kill switch), not the build's. Opening Today
 * asks for suggestions as a visit, which the server holds to its floor; a
 * loop that is off, or any failure, shows nothing — never an error, never a
 * claim that something was suggested. Review happens on «يتابع لك».
 */
export function ProactiveInboxBanner() {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const [items, setItems] = React.useState<IntelligenceSuggestion[]>([]);
  React.useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    generateIntelligenceSuggestions({ signal: controller.signal, visit: true })
      .then(result => { if (alive) setItems(result.suggestions.filter(item => item.status === 'pending')); })
      .catch(() => undefined);
    return () => { alive = false; controller.abort(); };
  }, []);
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
