import React from 'react';
import { generateIntelligenceSuggestions, getIntelligenceInbox } from '../../api/endpoints/intelligence';
import { forbiddenReason } from '../../api/ui/userFacingMessage';
import { useOptionalAuth } from '../../auth/AuthProvider';
import { claimVisit, recordVisitAnswer, recordVisitFailure } from '../../lib/deviceSettings/visitThrottle';
import type { BasisMode, IntelligenceSuggestion } from '../../api/schemas/intelligence';
import { isolateAuto } from '../../i18n/bidi';
import { useApp } from '../../state/AppContext';
import { Txt } from '../../ui/primitives';
import { TextLink } from '../../ui/chrome';
import { ReferenceCard, useReferencePalette } from '../../ui/referenceDesign';
import { basisClassVisible, useBasisStamp, useSuggestionBasisSignals, type BasisClass, type BasisReadStamp } from '../m5b/suggestionBasis';

type Held = { uid: string; items: IntelligenceSuggestion[]; basis: BasisClass | null };

/**
 * A quiet entry on Today, in every environment: whether the loop is on is the
 * server's answer (its gate and kill switch), not the build's. Opening Today
 * asks for suggestions as a visit when the visit throttle allows
 * (`visitThrottle.ts`) and otherwise reads what is already waiting; a
 * loop that is off, or any failure, shows nothing — never an error, never a
 * claim that something was suggested. Review happens on «يتابع لك».
 *
 * M5b-2b-1 (R9-001): what it holds is classified like the panel's (the mode
 * the server filtered under, the capability it was read under), and read
 * again on the same signals — a memory write, the memory list settling, a
 * capability transition. A failed reread clears it.
 */
export function ProactiveInboxBanner() {
  const { t, actions } = useApp();
  const p = useReferencePalette();
  const uid = useOptionalAuth()?.user?.uid ?? '';
  // Held with the account it was read for, and drawn only for that account
  // (M5B2A-R15-001): after a switch, the previous account's suggestion is gone
  // at once, whatever the new account's own read answers.
  const [held, setHeld] = React.useState<Held>({ uid: '', items: [], basis: null });
  const mine = held.uid === uid && uid !== '';
  const { stamp, classify } = useBasisStamp();
  // Only the newest read lands (as the panel's `readSeq`).
  const readSeq = React.useRef(0);
  const lastReadStart = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  React.useEffect(() => {
    // Nobody known yet (the session is still being read): nothing to ask for.
    if (!uid) return undefined;
    let alive = true;
    const controller = new AbortController();
    const seq = ++readSeq.current;
    const show = (answer: { suggestions: IntelligenceSuggestion[]; basisMode?: BasisMode | undefined }, at: BasisReadStamp) => {
      if (!alive || seq !== readSeq.current) return;
      setHeld({ uid, items: answer.suggestions.filter(item => item.status === 'pending'), basis: classify(answer, at) });
    };
    void (async () => {
      // Asked as a visit only when the throttle allows; every other mount
      // reads what is already waiting, which never runs the model.
      if (await claimVisit(uid)) {
        const at = stamp();
        lastReadStart.current = Math.max(lastReadStart.current, at.startedAt);
        try {
          const answer = await generateIntelligenceSuggestions({ signal: controller.signal, visit: true, asUid: uid });
          recordVisitAnswer(uid, answer.nextVisitAt);
          show(answer, at);
        } catch (cause) {
          recordVisitFailure(uid, forbiddenReason(cause) !== null);
        }
        return;
      }
      const at = stamp();
      lastReadStart.current = Math.max(lastReadStart.current, at.startedAt);
      try { show(await getIntelligenceInbox({ asUid: uid }), at); }
      catch { /* Off, refused or offline: Today shows nothing here. */ }
    })();
    return () => { alive = false; controller.abort(); };
  }, [uid, stamp, classify]);
  // A signal's reread: what is already waiting, never a model run.
  const reread = React.useCallback(() => {
    if (!uid) return;
    const seq = ++readSeq.current;
    const at = stamp();
    lastReadStart.current = Math.max(lastReadStart.current, at.startedAt);
    void (async () => {
      try {
        const answer = await getIntelligenceInbox({ asUid: uid });
        if (!mounted.current || seq !== readSeq.current) return;
        setHeld({ uid, items: answer.suggestions.filter(item => item.status === 'pending'), basis: classify(answer, at) });
      } catch {
        if (!mounted.current || seq !== readSeq.current) return;
        setHeld(current => (current.uid === uid ? { ...current, items: [] } : current));
      }
    })();
  }, [uid, stamp, classify]);
  const heldBasis = mine ? held.basis : null;
  const signals = useSuggestionBasisSignals({
    held: heldBasis,
    ready: heldBasis !== null,
    holding: held.items.length > 0,
    watchList: heldBasis?.mode === 'on_basis',
    lastReadStart: () => lastReadStart.current,
    reread,
  });
  const items = mine && basisClassVisible(heldBasis, signals.capNow) ? held.items : [];
  const first = items[0];
  if (!first) return null;
  return <ReferenceCard pad={18} testID="today-proactive-suggestion">
    <Txt size={15} weight={600}>{t.xIntelligenceTitle}</Txt>
    <Txt size={16}>{isolateAuto(first.title)}</Txt>
    <Txt size={13} color={p.mu}>{isolateAuto(first.reason)}</Txt>
    <Txt size={13} color={p.mu}>{t.suggestionNote}</Txt>
    <TextLink label={t.xIntelligenceReview} onPress={() => actions.switchTab('watching')} testID="today-proactive-review" />
  </ReferenceCard>;
}
