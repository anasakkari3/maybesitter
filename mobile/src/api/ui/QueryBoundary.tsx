import React from 'react';
import { ActivityIndicator, View } from 'react-native';
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
      <View testID="query-error" style={{ padding: 24, gap: 14, alignItems: 'center' }}>
        <Txt size={15} align="center">{userFacingMessage(error, t)}</Txt>
        {!unretryable && onRetry ? (
          <Pill label={t.errorsRetry} kind="outline" size={14} onPress={onRetry} />
        ) : null}
      </View>
    );
  }

  return <>{children}</>;
}
