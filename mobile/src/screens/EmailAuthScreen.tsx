import React, { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
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
import { FlowHeader, Pill, Txt } from '../ui/primitives';

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
  const { t, p, ar } = useApp();
  const { repository } = useAuth();
  const [mode, setMode] = useState<EmailAuthMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, run } = useSingleFlight();
  const [errorKey, setErrorKey] = useState<AuthMessageKey | null>(null);
  const [resetSent, setResetSent] = useState(false);

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
        // this screen out on the auth change that follows.
        setPassword('');
      } catch (error) {
        setErrorKey(authErrorKey(error));
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
    textAlign: (ar ? 'right' : 'left') as 'left' | 'right',
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlowHeader pill={t.back} onPill={onBack} title={t.authEmailTitle} />
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
            editable={!busy}
            style={inputStyle}
          />
        </View>

        {mode !== 'reset' ? (
          <View style={{ gap: 8 }}>
            <Txt size={13} color={p.mu}>{t.authPasswordLabel}</Txt>
            <TextInput
              testID="authPasswordInput"
              accessibilityLabel={t.authPasswordLabel}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType={mode === 'signUp' ? 'newPassword' : 'password'}
              autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
              editable={!busy}
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
    </KeyboardAvoidingView>
  );
}
