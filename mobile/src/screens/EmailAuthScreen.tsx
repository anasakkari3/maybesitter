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
import { Pill, Txt } from '../ui/primitives';
import { TaskHeader } from '../ui/taskHeader';
import { AvoidKeyboard } from '../ui/keyboard';

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

  const inputStyle = {
    backgroundColor: p.sf,
    borderWidth: 1,
    borderColor: p.ln,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 16,
    color: p.tx,
    minHeight: 52,
    textAlign: (rtl ? 'right' : 'left') as 'left' | 'right',
  };

  return (
    <AvoidKeyboard testID="email-auth-root" pointerEvents={inert ? 'none' : 'auto'} style={{ flex: 1, backgroundColor: p.bg }}>
      <TaskHeader pill={t.back} onPill={onBack} title={t.authEmailTitle} />
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <Txt size={22} weight={600}>{title}</Txt>
        {mode === 'reset' ? <Txt size={14} color={p.mu}>{t.authResetBody}</Txt> : null}

        <View style={{ gap: 8 }}>
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
            style={inputStyle}
          />
        </View>

        {mode !== 'reset' ? (
          <View style={{ gap: 8 }}>
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
              style={inputStyle}
            />
            <Txt size={12} color={p.mu}>{fill(t.authPasswordHint, { n: MIN_PASSWORD_LENGTH })}</Txt>
          </View>
        ) : null}

        {errorText ? <Txt size={13} color={p.wm}>{errorText}</Txt> : null}
        {resetSent ? <Txt size={13} color={p.ac}>{t.authResetSent}</Txt> : null}

        <Pill label={submitLabel} kind="accent" onPress={() => void submit()} disabled={busy} />

        <View style={{ gap: 12, marginTop: 4, alignItems: 'center' }}>
          {mode === 'signIn' ? (
            <>
              <Pill label={t.authForgotPassword} kind="ghost" size={14} pad={6} onPress={() => { setMode('reset'); setErrorKey(null); }} />
              <Pill label={t.authSwitchToSignUp} kind="ghost" size={14} pad={6} onPress={() => { setMode('signUp'); setErrorKey(null); }} />
            </>
          ) : (
            <Pill label={t.authSwitchToSignIn} kind="ghost" size={14} pad={6} onPress={() => { setMode('signIn'); setErrorKey(null); setResetSent(false); }} />
          )}
        </View>
      </ScrollView>
    </AvoidKeyboard>
  );
}
