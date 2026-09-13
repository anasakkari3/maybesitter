import React, { useRef } from 'react';
import { View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useApp } from '../../state/AppContext';
import { Btn, Txt } from '../../ui/primitives';
import type { CommitmentView } from './model';

/**
 * Done and "not now", without opening the commitment (UC-2.R3 #173 steps 3, 8).
 *
 * ── The swipe and the assistive action are the same action ───────
 *
 * A swipe is invisible to a screen reader and impossible with a switch
 * control, so each one is also an `accessibilityAction` on the row. They are
 * declared together here, from one list, because two declarations drift: the
 * failure is a row that can be completed by swiping and not by VoiceOver, and
 * nobody sees it until somebody who needs it does.
 *
 * ── Direction follows the language ───────────────────────────────
 *
 * `direction: 'rtl'` on the root view mirrors layout but not gestures. In
 * Arabic the actions are on the opposite side, so which renderer gets them is
 * chosen from `ar` rather than fixed — otherwise "done" would sit under the
 * thumb that means "not now".
 */
export interface RowAction {
  name: 'complete' | 'postpone';
  label: string;
  run(): void;
}

export function useRowActions(view: CommitmentView, run: {
  complete(): void;
  postpone(): void;
}): RowAction[] {
  const { t } = useApp();
  // A finished commitment has nothing to complete or postpone. Offering either
  // would be a control that fails.
  if (view.status !== 'active') return [];
  return [
    { name: 'complete', label: t.rowComplete, run: run.complete },
    { name: 'postpone', label: t.rowPostpone, run: run.postpone },
  ];
}

export function SwipeableRow({
  actions,
  children,
  testID,
}: {
  actions: RowAction[];
  children: React.ReactNode;
  testID: string;
}) {
  const { p, ar } = useApp();
  const swipe = useRef<Swipeable>(null);

  if (actions.length === 0) return <>{children}</>;

  const panel = () => (
    <View style={{ flexDirection: 'row' }}>
      {actions.map((action) => (
        <Btn
          key={action.name}
          testID={`${testID}-${action.name}`}
          label={action.label}
          onPress={() => { swipe.current?.close(); action.run(); }}
          style={{
            justifyContent: 'center', paddingHorizontal: 20,
            backgroundColor: action.name === 'complete' ? p.acs : p.sf2,
          }}
        >
          <Txt size={13} weight={600} color={action.name === 'complete' ? p.ac : p.tx}>{action.label}</Txt>
        </Btn>
      ))}
    </View>
  );

  return (
    <Swipeable
      ref={swipe}
      // One side only, chosen by direction. Both sides would put "done" under
      // the thumb that means "not now" in one of the two languages.
      {...(ar ? { renderLeftActions: panel } : { renderRightActions: panel })}
      overshootLeft={false}
      overshootRight={false}
    >
      {children}
    </Swipeable>
  );
}
