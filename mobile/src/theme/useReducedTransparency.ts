import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/** One subscription at the app provider, not one for every glass card. */
export function useReducedTransparency() {
  const [reduced, setReduced] = useState(Platform.OS !== 'ios');
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let active = true;
    // Optional call also supports test/native hosts without this iOS API.
    void AccessibilityInfo.isReduceTransparencyEnabled?.().then(value => {
      if (active) setReduced(value);
    }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}
