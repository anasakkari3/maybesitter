import React, { useEffect } from 'react';
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Pill, Txt } from '../../ui/primitives';
import { forbiddenReason, userFacingMessage } from './userFacingMessage';

/**
 * Loading, failed, and the states that are not failures.
 *
 * A 403 carrying `revoked`, `deleted`, `consent_required`, `quiet_mode` or
 * `feature_disabled` is the product working as designed — the user withdrew
 * consent, or turned quiet mode on — and showing "something went wrong" for
 * any of them tells the user their own choice is a bug. Those render as a
 * plain statement with no Retry, because retrying cannot change them.
 */
export function QueryBoundary({
  isPending,
  error,
  onRetry,
  children,
}: {
  isPending: boolean;
  error: unknown;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  const { t, p } = useApp();
  const failure = !isPending && error ? userFacingMessage(error, t) : null;

  // The failure view mounts with its words, so no live region can carry it
  // (it would arrive in one step and TalkBack says nothing), and iOS has none:
  // both screen readers are told outright (de7fcb84 audit CX2.3).
  useEffect(() => {
    if (failure) AccessibilityInfo.announceForAccessibility(failure);
  }, [failure]);

  if (isPending) {
    return (
      <View testID="query-loading" style={{ padding: 32, alignItems: 'center' }}>
        <ActivityIndicator color={p.ac} />
      </View>
    );
  }

  if (error) {
    const reason = forbiddenReason(error);
    const unretryable = reason !== null;
    return (
      <View testID="query-error" accessibilityRole="alert" style={{ padding: 24, gap: 14, alignItems: 'center' }}>
        <Txt size={15} align="center">{failure}</Txt>
        {!unretryable && onRetry ? (
          <Pill label={t.errorsRetry} kind="outline" size={14} onPress={onRetry} />
        ) : null}
      </View>
    );
  }

  return <>{children}</>;
}
