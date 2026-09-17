import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { LANGUAGE_ENDONYM, type SelectableLocale } from '../../i18n/language';
import { SELECTABLE_LOCALES } from '../../i18n/locale';
import { Btn, Txt } from '../../ui/primitives';

/**
 * The first screen a fresh install sees (#469).
 *
 * Three options named in themselves — someone looking for their language
 * finds it by its own name, not by what the current UI calls it — and one
 * primary button. Tapping an option sets the app language at once, so the
 * title, hint and button re-render in that language before Continue is
 * pressed; that live flip is how the screen shows what the choice means.
 *
 * ── Why this view sets `direction` itself ────────────────────────
 *
 * `Root` is the one place that flips `direction` for Arabic and Hebrew, and
 * this screen renders above `Root` (and above sign-in). Without its own
 * `direction` a Hebrew title would sit on a left-to-right page.
 *
 * The option rows are `Pressable`s rather than `Btn`s because `Btn` owns
 * `accessibilityState` for its disabled flag, and a radio group has to
 * announce which entry is selected.
 */
export function LanguageStep({ onContinue }: { onContinue: () => void }) {
  const { t, p, lang, rtl, actions } = useApp();
  const insets = useSafeAreaInsets();

  const choose = (locale: SelectableLocale) => actions.setLang(locale);
  // `setLang` persists the key, which is what makes the choice durable: the
  // next launch finds it stored and the gate does not ask again. Continue
  // writes the language currently shown, so a device whose system language
  // was preselected and never tapped still ends up with an explicit choice.
  const cont = () => {
    actions.setLang(lang);
    onContinue();
  };

  return (
    <ScrollView
      testID="language-step"
      style={{ flex: 1, backgroundColor: p.bg, direction: rtl ? 'rtl' : 'ltr' }}
      contentContainerStyle={{
        paddingTop: insets.top + 48,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 24,
        flexGrow: 1,
        justifyContent: 'center',
        gap: 28,
      }}
    >
      <Txt size={26} weight={600} align="center">{t.langTitle}</Txt>

      <View style={{ gap: 12 }} accessibilityRole="radiogroup">
        {SELECTABLE_LOCALES.map((code) => {
          const selected = code === lang;
          return (
            <Pressable
              key={code}
              testID={`language-option-${code}`}
              accessibilityRole="radio"
              accessibilityLabel={LANGUAGE_ENDONYM[code]}
              accessibilityState={{ selected }}
              onPress={() => choose(code)}
              style={{
                backgroundColor: selected ? p.acs : p.sf,
                borderRadius: 18, borderWidth: 1, borderColor: selected ? p.ac : p.ln,
                paddingVertical: 18, paddingHorizontal: 20,
                minHeight: 60, alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Txt size={18} weight={600} color={selected ? p.ac : p.tx} align="center">{LANGUAGE_ENDONYM[code]}</Txt>
            </Pressable>
          );
        })}
      </View>

      <View style={{ gap: 12 }}>
        <Btn
          testID="language-continue"
          label={t.langContinue}
          onPress={cont}
          style={{ backgroundColor: p.ac, borderRadius: 999, paddingVertical: 16, alignItems: 'center', justifyContent: 'center', minHeight: 52 }}
        >
          <Txt size={16} weight={600} color={p.onAccent} align="center">{t.langContinue}</Txt>
        </Btn>
        <Txt size={13} color={p.mu} align="center">{t.langHint}</Txt>
      </View>
    </ScrollView>
  );
}
