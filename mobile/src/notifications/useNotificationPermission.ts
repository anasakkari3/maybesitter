import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { getNotificationPermission, type NotificationPermission } from './permission';

/**
 * What the phone currently allows, for a screen that only reads it
 * (closure CL2b round 2).
 *
 * Read on mount and again on every return to the foreground, the same rule as
 * the reminders screen (#475): someone who has just allowed notifications in
 * phone settings sees it the moment they come back. `null` until the first
 * read lands — the caller must not claim anything in that window. A read that
 * resolves after a newer one started is dropped, so an old answer can never
 * overwrite a new one. Asks nothing: the one OS prompt stays where
 * `permission.ts` says it is spent.
 */
export function useNotificationPermission(): NotificationPermission | null {
  const [status, setStatus] = useState<NotificationPermission | null>(null);
  const [foregrounded, setForegrounded] = useState(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForegrounded((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let current = true;
    void getNotificationPermission().then((answer) => {
      if (current) setStatus(answer);
    });
    return () => {
      current = false;
    };
  }, [foregrounded]);

  return status;
}
