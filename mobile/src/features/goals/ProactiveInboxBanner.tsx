import React from 'react';
import { generateIntelligenceSuggestions } from '../../api/endpoints/intelligence';
import type { IntelligenceSuggestion } from '../../api/schemas/intelligence';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { TextLink } from '../../ui/chrome';
import { ReferenceCard, useReferencePalette } from '../../ui/referenceDesign';
import { appEnv } from '../../config/env';

/** A quiet entry on Today. Generation is cached server side and stays review only. */
export function ProactiveInboxBanner() {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const [items, setItems] = React.useState<IntelligenceSuggestion[]>([]);
  React.useEffect(() => {
    if (appEnv() !== 'staging') return undefined;
    let alive = true;
    const controller = new AbortController();
    generateIntelligenceSuggestions(controller.signal)
      .then(result => { if (alive) setItems(result.suggestions.filter(item => item.status === 'pending')); })
      .catch(() => undefined);
    return () => { alive = false; controller.abort(); };
  }, []);
  const first = items[0];
  if (!first) return null;
  return <ReferenceCard pad={18} testID="today-proactive-suggestion">
    <Txt size={15} weight={600}>{t.xIntelligenceTitle}</Txt>
    <Txt size={16}>{first.title}</Txt>
    <Txt size={13} color={p.mu}>{first.reason}</Txt>
    <TextLink label={t.xIntelligenceReview} onPress={() => actions.go('goalExecution')} testID="today-proactive-review" />
  </ReferenceCard>;
}
