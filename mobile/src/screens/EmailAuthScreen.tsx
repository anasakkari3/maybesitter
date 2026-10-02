import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { useSingleFlight } from '../auth/useSingleFlight';
import { authErrorKey, type AuthErrorKey } from '../auth/authErrors';
import {
  MIN_PASSWORD_LENGTH,
  emailError,
  normalizeEmail,
  passwordError,
  type FieldErrorKey,
} from '../auth/validation';
import { fill } from '../i18n/strings';
import { Btn, Pill, Txt } from '../ui/primitives';
import { TaskHeader } from '../ui/taskHeader';
import { AvoidKeyboard } from '../ui/keyboard';
import { LiveRegion } from '../ui/liveRegion';

export type EmailAuthMode = 'signIn' | 'signUp' | 'reset';

/** Every message this screen can show for a refused attempt. */
type AuthMessageKey = FieldErrorKey | AuthErrorKey;

/**
 * Sign in, create an account, or ask for a reset link — one screen, because
 * they are the same two fields and a person who picked the wrong one should
 * not have to go back to find out.
 *
 * Nothing here is logged. The address is in component state and in the request
 * the SDK makes; the password never leaves the `TextInput` and this module's
 * local variable, and the fake repository records only the address so a failing
 * test cannot print one either.
 */
export function EmailAuthScreen({ onBack, initialMode = 'signIn' }: { onBack: () => void; initialMode?: EmailAuthMode }) {
  const { t, p, rtl } = useApp();
  const { repository } = useAuth();
  const [mode, setMode] = useState<EmailAuthMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, run } = useSingleFlight();
  const [errorKey, setErrorKey] = useState<AuthMessageKey | null>(null);
  const [resetSent, setResetSent] = useState(false);
  /**
   * The account call succeeded, and this screen is on its way out.
   *
   * With `busy`, this makes the form inert: no pointer events and no editable
   * field while the call runs, and none after it succeeds. `busy` alone drops
   * back to false when the call returns — `createAccount` still waits on the
   * verification email — and the form would take edits and a second submit in
   * the moment before the gate swaps the screen out. A refused call hands the
   * form back.
   */
  const [signedIn, setSignedIn] = useState(false);
  const inert = busy || signedIn;
  const passwordRef = useRef<TextInput>(null);
  // Bumped by a refused call; acted on once the fields are editable again.
  const [refused, setRefused] = useState(0);
  const refocused = useRef(0);
  useEffect(() => {
    if (inert || refused === refocused.current) return;
    refocused.current = refused;
    passwordRef.current?.focus();
  }, [inert, refused]);

  const title = mode === 'reset' ? t.authResetTitle : mode === 'signUp' ? t.authModeSignUp : t.authModeSignIn;
  const submitLabel = busy
    ? mode === 'signUp'
      ? t.authBusyCreating
      : mode === 'reset'
        ? t.authBusySending
        : t.authBusySigningIn
    : mode === 'reset'
      ? t.authResetSend
      : title;

  const submit = useCallback(async () => {
    setResetSent(false);
    // Validated before any network call: a typo costs nothing, and a
    // rate-limited account does not spend an attempt on an obvious mistake.
    const emailProblem = emailError(email);
    if (emailProblem) {
      setErrorKey(emailProblem);
      return;
    }
    if (mode !== 'reset') {
      const passwordProblem = passwordError(password);
      if (passwordProblem) {
        setErrorKey(passwordProblem);
        return;
      }
    }
    setErrorKey(null);
    // `run` refuses a second submit while the first is in flight, so a double
    // tap is one account rather than two attempts.
    await run(async () => {
      try {
        const address = normalizeEmail(email);
        if (mode === 'reset') {
          await repository.sendPasswordReset(address);
          setResetSent(true);
        } else if (mode === 'signUp') {
          await repository.createAccount(address, password);
        } else {
          await repository.signInWithEmail(address, password);
        }
        // A success clears the password from state at once; the gate swaps
        // this screen out on the auth change that follows. Until it does —
        // and in whatever native view outlives it — the form stays inert.
        setPassword('');
        if (mode !== 'reset') setSignedIn(true);
      } catch (error) {
        setErrorKey(authErrorKey(error));
        // The fields were locked for the call; once they are editable again
        // the password takes the keyboard back, ready to retype.
        if (mode !== 'reset') setRefused(count => count + 1);
      }
    });
  }, [run, email, password, mode, repository]);

  // The only key that carries a placeholder; `fill` on a message without one
  // is a no-op, so this stays one line rather than a table.
  const errorText = errorKey ? fill(t[errorKey], { n: MIN_PASSWORD_LENGTH }) : null;

  // Which field the message is about, so that field — and only that one —
  // is outlined. A refused sign-in never says which half was wrong, so a
  // server answer outlines neither.
  const emailFlagged = errorKey === 'authFieldEmailRequired' || errorKey === 'authFieldEmailInvalid';
  const passwordFlagged = errorKey === 'authFieldPasswordRequired' || errorKey === 'authFieldPasswordShort';

  const inputStyle = (flagged: boolean) => ({
    backgroundColor: p.bg,
    borderWidth: 1,
    borderColor: flagged ? p.ac : p.lnStrong,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: p.tx,
    minHeight: 48,
    textAlign: (rtl ? 'right' : 'left') as 'left' | 'right',
  });

  return (
    <AvoidKeyboard testID="email-auth-root" pointerEvents={inert ? 'none' : 'auto'} style={{ flex: 1, backgroundColor: p.bg }}>
      <TaskHeader pill={t.back} onPill={onBack} title={t.authEmailTitle} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 32, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6, alignItems: 'flex-start' }}>
          <Txt role="page" size={26} weight={700}>{title}</Txt>
          {mode === 'reset' ? <Txt size={15} color={p.mu}>{t.authResetBody}</Txt> : null}
        </View>

        <View style={{ gap: 14, borderRadius: 24, borderWidth: 1, borderColor: p.ln, backgroundColor: p.sf, padding: 18 }}>
          <View style={{ gap: 6 }}>
            <Txt size={13} color={p.mu}>{t.authEmailLabel}</Txt>
            <TextInput
              // A stable handle for Maestro. The visible label is localised and
              // duplicated by the field's own caption, so matching on text is
              // both locale-dependent and ambiguous.
              testID="authEmailInput"
              accessibilityLabel={t.authEmailLabel}
              value={email}
              onChangeText={setEmail}
              placeholder={t.authEmailPlaceholder}
              placeholderTextColor={p.mu}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              // Lets the OS keychain offer a saved credential. On iOS the
              // password manager only fills it once the associated domain is
              // live (OWNER-A1 #137); until then this is simply inert.
              textContentType="username"
              autoComplete="email"
              editable={!inert}
              style={inputStyle(emailFlagged)}
            />
          </View>

          {mode !== 'reset' ? (
            <View style={{ gap: 6 }}>
              <Txt size={13} color={p.mu}>{t.authPasswordLabel}</Txt>
              <TextInput
                testID="authPasswordInput"
                ref={passwordRef}
                accessibilityLabel={t.authPasswordLabel}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType={mode === 'signUp' ? 'newPassword' : 'password'}
                autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                editable={!inert}
                style={inputStyle(passwordFlagged)}
              />
              <Txt size={13} color={p.mu}>{fill(t.authPasswordHint, { n: MIN_PASSWORD_LENGTH })}</Txt>
            </View>
          ) : null}

          {/* Inline, under the fields it is about, and announced when it appears. */}
          <LiveRegion alert>
            {errorText ? (
              <View testID="email-auth-error" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <View accessible={false} style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: p.acd, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                  <Txt latin size={12} weight={700} color={p.acd} align="center" lh={1.1}>!</Txt>
                </View>
                <Txt size={14} weight={600} color={p.acd} style={{ flex: 1 }}>{errorText}</Txt>
              </View>
            ) : null}
          </LiveRegion>
          {resetSent ? <Txt size={14} weight={600} color={p.success}>{t.authResetSent}</Txt> : null}

          {mode === 'signIn' ? (
            <Btn label={t.authForgotPassword} onPress={() => { setMode('reset'); setErrorKey(null); }} scaleTo={0.97}
              style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}>
              <Txt size={14} color={p.mu} style={{ textDecorationLine: 'underline' }}>{t.authForgotPassword}</Txt>
            </Btn>
          ) : null}

          <Pill label={submitLabel} kind="accent" radius={16} style={{ minHeight: 52 }} onPress={() => void submit()} disabled={busy} />
        </View>

        <View style={{ gap: 4, alignItems: 'center' }}>
          {mode === 'signIn' ? (
            <Pill label={t.authSwitchToSignUp} kind="ghost" size={15} pad={10} onPress={() => { setMode('signUp'); setErrorKey(null); }} />
          ) : (
            <Pill label={t.authSwitchToSignIn} kind="ghost" size={15} pad={10} onPress={() => { setMode('signIn'); setErrorKey(null); setResetSent(false); }} />
          )}
        </View>
      </ScrollView>
    </AvoidKeyboard>
  );
}
