import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { formatNumber } from '../i18n/format';
import { Txt } from './primitives';

/**
 * A short numbered how-to: "1 · open it, 2 · tap Share, 3 · choose us".
 *
 * Each step is one accessibility element whose label carries its number, so a
 * screen reader reads "1. Open the chat" rather than a stray "1" and then the
 * sentence. The number sits in a coral chip (`acs` / `ac`, the pair the tokens
 * contrast-test) that grows with the text rather than clipping it.
 */
export function NumberedSteps({ steps, testID }: { steps: readonly string[]; testID?: string }) {
  const { p, lang } = useApp();
  return <View testID={testID} style={{ gap: 12 }}>
    {steps.map((step, index) => {
      const n = formatNumber(index + 1, { locale: lang });
      return <View key={index} accessible accessibilityLabel={`${n}. ${step}`} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <View style={{ minWidth: 28, minHeight: 28, paddingHorizontal: 6, borderRadius: 14, backgroundColor: p.acs, alignItems: 'center', justifyContent: 'center' }}>
          <Txt role="label" color={p.ac} latin>{n}</Txt>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-start' }}><Txt role="body">{step}</Txt></View>
      </View>;
    })}
  </View>;
}
