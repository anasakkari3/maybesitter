import React from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import i18next from 'i18next';
import { tFor } from '../i18n';
import { apiLocale, isRtl, scriptFor } from '../i18n/locale';
import { family, LINE_HEIGHT, type Script } from '../theme/fonts';
import { palettes, radius, space, typeScale } from '../theme/tokens';
import { recordError } from '../lib/crash';

/**
 * The app-wide error boundary (UC-4.4, #180 step 4).
 *
 * React Native Firebase's global JS handler already sends an *unhandled* error
 * to Crashlytics, and it also means the screen goes blank or the app exits.
 * This is the other half: a render error is caught, reported as a non-fatal,
 * and the person is shown something calm with a way back in — instead of a
 * white rectangle they can only fix by force-quitting.
 *
 * ── Why it is outside every provider ─────────────────────────────
 *
 * `App.tsx` mounts it around the whole tree, above `SafeAreaProvider` and
 * `AppProvider`. A boundary that sat inside them could not catch the failure
 * that is most likely to blank the app: a provider's own first render. That is
 * also why nothing here calls `useApp()` — the context it reads may be exactly
 * what threw — so the fallback resolves its own language, palette and fonts.
 *
 * ── What it must not do ──────────────────────────────────────────
 *
 * It never shows the error, and it never logs it. `error.message` on screen is
 * a stack trace shown to somebody who cannot act on it, and `console.error`
 * with it in a release build is that same text in the device log, next to
 * whatever else was on screen. The message goes to Crashlytics and nowhere
 * else. (React itself still logs a caught error in a *development* bundle;
 * that is React's, it does not happen in release, and this adds none of its
 * own.)
 */

interface Props {
  children: React.ReactNode;
  /** Injected in tests. Production reports through `src/lib/crash.ts`. */
  onError?: (error: unknown) => void;
}

interface State {
  failed: boolean;
  /** Bumped on retry so the children remount rather than resume mid-failure. */
  attempt: number;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    // A breadcrumb name, not a sentence: "the app showed the retry screen".
    // The component stack React also hands us is deliberately not sent — the
    // wrapper's contract is a stack and the build's own facts, and widening it
    // here is how that contract stops being one.
    const report = this.props.onError ?? ((caught: unknown) => recordError(caught, 'render_failed'));
    try {
      report(error);
    } catch {
      // Reporting a failure must not become one.
    }
  }

  private readonly retry = (): void => {
    this.setState(previous => ({ failed: false, attempt: previous.attempt + 1 }));
  };

  override render(): React.ReactNode {
    if (this.state.failed) return <CrashFallback onRetry={this.retry} />;
    // Keyed so "try again" is a real retry: the subtree is rebuilt from
    // scratch, not resumed from the half-built state that threw.
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

/**
 * The retry screen.
 *
 * Two lines and one button, vertically centred — no safe-area insets, because
 * `SafeAreaProvider` is below this boundary and may be what failed; centred
 * content never reaches a notch or a home indicator anyway.
 *
 * Colours come from `src/theme/tokens.ts`, and nothing here is red: the
 * product has no danger role, and a red screen tells somebody their day is
 * broken when it is not.
 */
/**
 * Large type is set tighter than body copy, so the title has its own map rather
 * than reading LINE_HEIGHT. The two RTL faces keep the boxes their own metrics
 * ask for; only Outfit is squeezed, and only here.
 */
const TITLE_LINE: Record<Script, number> = { latin: 1.3, arabic: 1.6, hebrew: 1.5 };

export function CrashFallback({ onRetry }: { onRetry: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const p = palettes[scheme];
  // The language the app was being read in. i18next holds it whether or not
  // AppProvider survived; it falls back to English rather than to nothing.
  const locale = apiLocale(i18next.language);
  const t = tFor(locale);
  const rtl = isRtl(locale);
  // Not `locale === 'ar'`: this screen already read Hebrew as RTL, and drew it
  // in a face with no Hebrew glyphs in it. A crash screen nobody can read is
  // the one screen where that is least affordable.
  const script = scriptFor(locale);

  return (
    <View
      testID="crash-fallback"
      style={{
        flex: 1,
        backgroundColor: p.bg,
        direction: rtl ? 'rtl' : 'ltr',
        justifyContent: 'center',
        alignItems: 'stretch',
        paddingHorizontal: space.screen,
        gap: space.wide,
      }}
    >
      <View style={{ gap: space.xl }}>
        <Text
          testID="crash-title"
          style={{
            fontFamily: family(600, script),
            fontSize: typeScale.title2,
            lineHeight: Math.round(typeScale.title2 * TITLE_LINE[script]),
            color: p.tx,
            textAlign: rtl ? 'right' : 'left',
            writingDirection: rtl ? 'rtl' : 'ltr',
          }}
        >
          {t('crashTitle')}
        </Text>
        <Text
          testID="crash-body"
          style={{
            fontFamily: family(400, script),
            fontSize: typeScale.bodyLarge,
            lineHeight: Math.round(typeScale.bodyLarge * LINE_HEIGHT[script]),
            color: p.mu,
            textAlign: rtl ? 'right' : 'left',
            writingDirection: rtl ? 'rtl' : 'ltr',
          }}
        >
          {t('crashBody')}
        </Text>
      </View>
      <Pressable
        testID="crash-retry"
        accessibilityRole="button"
        accessibilityLabel={t('errorsRetry')}
        onPress={onRetry}
        style={{
          alignSelf: 'flex-start',
          backgroundColor: p.ac,
          borderRadius: radius.pill,
          paddingVertical: space.xxl,
          paddingHorizontal: space.page,
          minHeight: 48,
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontFamily: family(600, script),
            fontSize: typeScale.body,
            lineHeight: Math.round(typeScale.body * LINE_HEIGHT[script]),
            color: p.onAccent,
            writingDirection: rtl ? 'rtl' : 'ltr',
          }}
        >
          {t('errorsRetry')}
        </Text>
      </Pressable>
    </View>
  );
}
