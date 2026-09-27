import React, { useState } from 'react';
import { ActivityIndicator, Switch, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { useLayoutMode } from '../../theme/textScale';

/**
 * A switch whose position is the server's answer, never this component's
 * (UC-2.R4, #174).
 *
 * ── No optimistic update, on purpose ─────────────────────────────
 *
 * Everywhere else in this app an optimistic update is the right call. Not
 * here. These switches say what MaybeSitter is allowed to do with somebody's
 * words, and a switch that flips to "on" before the server has agreed tells
 * them a thing about their own privacy that is not yet true — and may never
 * become true, if the write fails.
 *
 * So: the rendered value is always `value`, which the caller reads from the
 * server. While a write is in flight the control is disabled and shows a
 * spinner. If it fails, nothing moved, and the row says so.
 *
 * ── Why the failure message lives in the row ─────────────────────
 *
 * Not a toast. A toast for "analytics could not be turned off" disappears
 * while the switch is still sitting in the position the user did not choose.
 * The message stays under the control it is about until the next attempt.
 *
 * ── On, but blocked by the phone ─────────────────────────────────
 *
 * A setting can be on while the OS will not deliver it (notifications denied,
 * closure CL2b #18). The position stays the server's answer — allowing it in
 * phone settings later then simply works — but an on switch drawn in the
 * accent would claim it is working. So with `blockedNote` the on track is
 * warm (attention, per the design rules) and the note sits under the body,
 * also announced as the switch's hint.
 */
export function ServerToggle({
  title,
  body,
  value,
  disabled = false,
  onChange,
  testID,
  blockedNote,
}: {
  title: string;
  body?: string | undefined;
  value: boolean;
  disabled?: boolean;
  /** Shown, and the track turned warm, while the switch is on but the phone blocks it. */
  blockedNote?: string | undefined;
  onChange: (next: boolean) => Promise<boolean>;
  testID?: string;
}) {
  const { t, p } = useApp();
  const stacked = useLayoutMode() === 'xl';
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const blocked = value && blockedNote ? blockedNote : null;

  return (
    <View style={{ paddingVertical: 18, paddingHorizontal: 18, gap: 8, borderBottomWidth: 1, borderBottomColor: p.ln }}>
      <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', gap: 12 }}>
        <Txt role="action" style={stacked ? undefined : { flex: 1 }}>{title}</Txt>
        {busy ? <ActivityIndicator testID={`${testID ?? 'toggle'}-busy`} color={p.ac} /> : null}
        <Switch
          testID={testID}
          accessibilityRole="switch"
          accessibilityLabel={title}
          {...(blocked ? { accessibilityHint: blocked } : {})}
          accessibilityState={{ checked: value, disabled: disabled || busy }}
          value={value}
          disabled={disabled || busy}
          trackColor={{ false: p.ln, true: blocked ? p.wm : p.ac }}
          onValueChange={next => {
            // Guarded here as well as through `disabled`. The native control
            // blocks a tap while disabled, but that is the platform's promise,
            // not this component's — and the promise being kept is that one
            // tap sends at most one write. A second write racing the first
            // would land in an order nobody chose.
            if (disabled || busy) return;
            setBusy(true);
            setFailed(false);
            void onChange(next)
              .then(ok => setFailed(!ok))
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        />
      </View>
      {body ? <Txt role="supporting" color={p.mu}>{body}</Txt> : null}
      {blocked ? (
        <Txt size={13} color={p.wm} weight={600} testID={`${testID ?? 'toggle'}-blocked`}>{blocked}</Txt>
      ) : null}
      {failed ? (
        <Txt size={13} color={p.wm} testID={`${testID ?? 'toggle'}-failed`}>{t.trustActionFailed}</Txt>
      ) : null}
    </View>
  );
}
