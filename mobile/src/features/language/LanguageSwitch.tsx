import React from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { LANGUAGE_ENDONYM, type SelectableLocale } from '../../i18n/language';
import { scriptOfText } from '../../theme/fonts';
import { Txt } from '../../ui/primitives';

/** Arabic first, as the product is; each named in itself. */
const ORDER: readonly SelectableLocale[] = ['ar', 'en', 'he'];

/**
 * The compact language switch on the welcome and sign-in screens (Stitch
 * `07-onboarding`): three segments, each at least 44 × 44, each named in its
 * own language. A tap sets the app language at once — the same
 * `actions.setLang` the first-launch language screen and Settings use, so the
 * choice persists and the screen re-renders in it.
 *
 * `Pressable` rather than `Btn`: a radio group has to announce which entry is
 * selected, and `Btn` owns `accessibilityState` for its disabled flag.
 */
export function LanguageSwitch({ testID = 'language-switch' }: { testID?: string }) {
  const { t, p, lang, script, actions } = useApp();
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={t.langAppearanceLanguage}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 2, padding: 3, borderRadius: 999, backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, alignSelf: 'flex-start' }}
    >
      {ORDER.map(code => {
        const selected = code === lang;
        const name = LANGUAGE_ENDONYM[code];
        return (
          <Pressable
            key={code}
            testID={`${testID}-${code}`}
            accessibilityRole="radio"
            accessibilityLabel={name}
            accessibilityState={{ selected }}
            onPress={() => actions.setLang(code)}
            style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? p.sf2 : 'transparent' }}
          >
            <Txt size={13} weight={selected ? 700 : 400} color={selected ? p.tx : p.mu} align="center" latin={scriptOfText(name, script) === 'latin'}>{name}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}
