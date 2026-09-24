import React from 'react';
import { Switch, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Card, Txt } from '../ui/primitives';
import { useClarityConsent } from './ClarityProvider';

/** Shared by onboarding and Trust. Off is a complete, optional answer. */
export function ClarityConsent({ card = false }: { card?: boolean }) {
  const model = useClarityConsent();
  const { t, p } = useApp();
  if (!model?.enabled) return null;
  const content = <View testID="clarity-consent" style={{ padding: 18, gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
      <Txt size={15} style={{ flex: 1 }}>{t.clarityConsentTitle}</Txt>
      <Switch
        testID="clarity-consent-switch"
        accessibilityRole="switch"
        accessibilityLabel={t.clarityConsentTitle}
        accessibilityHint={t.clarityConsentBody}
        accessibilityState={{ checked: model.consent }}
        value={model.consent}
        onValueChange={model.setConsent}
        trackColor={{ false: p.ln, true: p.ac }}
      />
    </View>
    <Txt size={13} color={p.mu} lh={1.5}>{t.clarityConsentBody}</Txt>
    <Txt size={13} color={p.mu} lh={1.5}>{t.clarityConsentLifetime}</Txt>
  </View>;
  return card ? <Card pad={0}>{content}</Card> : content;
}
