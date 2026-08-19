'use client';

/**
 * The module-level recommendation review surface (Sprint 08, issue #35).
 *
 * ── Why this is not an extension of `NextStepReview.tsx` ─────────────────
 *
 * Sprint 06's recorded lesson is that shipping two complete implementations of
 * one mechanism cost four review rounds, each finding a defect already fixed on
 * the other side. So this file needs to justify existing, and the justification
 * is required to be structural rather than stylistic.
 *
 * Three reasons, in order of how conclusive they are:
 *
 *  1. **`NextStepReview.tsx` cannot be modified by this issue.** It is on the
 *     `nextStep*` surface, which #35 is scoped out of. "Extend it" is not a
 *     choice available here; the only compositional option would be to *wrap*
 *     it unchanged.
 *
 *  2. **Wrapping it would require discarding the alternatives.** Its prop is a
 *     `NextStepRecommendationContract`, whose `primaryStep` is a single nullable
 *     `{ commitmentId, title }` and whose `explanation` is one pre-rendered
 *     English sentence. There is no field on that contract for a second option,
 *     a confidence band, a soleness verdict, or a per-reason evidence basis.
 *     Adapting a `Recommendation` into it means projecting an `OptionSet` down
 *     to its lead and dropping the rest — which is exactly the
 *     `{ primary, alternatives }` collapse #33's decision 2 exists to make
 *     unconstructible, and it is invisible because the result still renders
 *     correctly. Reusing the pilot component here would reintroduce, at the
 *     presentation layer, the defect the contract layer was built to remove.
 *
 *  3. **It would inherit the pilot's explanation strings as a data contract.**
 *     #33 states this directly at `EvidenceCategory`: the pilot's
 *     `evidenceLabels` are presentation — pre-rendered, English-only, lossy —
 *     and "#35 renders these; it must not consume the pilot's strings, or the
 *     module would inherit a presentation decision as a data contract."
 *
 * What is *not* duplicated: the verdict vocabulary, the verdict copy, the
 * confirm-before-saving notice and the confirmation rule are shared concepts,
 * and `lib/recommendation/review/copy.ts` deliberately spells the five verdicts
 * exactly as `NextStepReview.tsx` spells them. The duplication Sprint 06 paid
 * for was two implementations of one *mechanism*; this is one mechanism
 * (confirmation) with its rule stated once, in `CONFIRMING_VERDICTS`, and read
 * by both the presenter and this file through the view model.
 *
 * ── This component contains no decision logic ────────────────────────────
 *
 * That is a hard constraint, not an aspiration, and the reason is that this repo
 * has **no DOM test infrastructure** — no testing-library, no jsdom, no browser
 * driver — so anything decided in here is decided somewhere no test in this
 * sprint can reach. Concretely, this file:
 *
 *   - contains no copy: every string it renders arrives on the view model;
 *   - does not know which verdicts need confirming: it reads
 *     `action.requiresConfirmation`, which `present.ts` sets from
 *     `CONFIRMING_VERDICTS`;
 *   - does not build a submission: it reports a `ReviewIntent` — which control
 *     was pressed, at which position, at which stage — and the container
 *     assembles the request;
 *   - reads no clock and generates no id: `decidedAt`, `confirmedAt` and every
 *     element id come from outside;
 *   - holds exactly one piece of state, `staged`, which is the two-step
 *     confirmation the acceptance criterion requires. Nothing is sent to the
 *     server on the first press of a confirming verdict, and nothing the server
 *     will act on exists until the second.
 *
 * `tests/recommendation/reviewAccessibility.test.ts` asserts the structure of
 * this file by reading its source, and states plainly in its header what that
 * proves and what it does not.
 */

import { useState } from 'react';
import type {
  BlindReviewSlot,
  ReviewIntent,
  ReviewOptionCard,
  ReviewVerdictAction,
  ReviewView,
} from '../../lib/recommendation/review/reviewContract';

/**
 * The two card shapes reduced to what a renderer needs.
 *
 * `ReviewOptionCard` and `BlindReviewSlot` differ by exactly the fields blind
 * review redacts, so the renderer takes their intersection plus an optional
 * confidence label. There is one card renderer rather than two, which is what
 * keeps the redaction a property of `present.ts` — a second renderer is a second
 * place that could print a field the first one does not.
 */
interface RenderableCard {
  readonly position: number;
  readonly elementId: string;
  readonly actionLabel: string;
  readonly confidenceLabel: string | null;
  readonly whyThisNow: ReviewOptionCard['whyThisNow'];
}

function fromOption(card: ReviewOptionCard): RenderableCard {
  return {
    position: card.optionIndex,
    elementId: card.elementId,
    actionLabel: card.actionLabel,
    confidenceLabel: card.confidenceLabel,
    whyThisNow: card.whyThisNow,
  };
}

function fromSlot(slot: BlindReviewSlot): RenderableCard {
  return {
    position: slot.slotIndex,
    elementId: slot.elementId,
    actionLabel: slot.actionLabel,
    // Blind slots carry no confidence, because `BlindReviewSlot` has no such
    // field to carry. Nothing here decides to hide it.
    confidenceLabel: null,
    whyThisNow: slot.whyThisNow,
  };
}

export interface RecommendationReviewProps {
  readonly view: ReviewView;
  readonly onIntent: (intent: ReviewIntent) => void;
  /** A notice from the server's last outcome, announced in the live region. */
  readonly notice?: string;
}

export default function RecommendationReview({ view, onIntent, notice }: RecommendationReviewProps) {
  const [staged, setStaged] = useState<{ verdict: ReviewVerdictAction['verdict']; position: number } | null>(null);

  if (view.mode === 'none') {
    return (
      <section aria-labelledby={view.headingElementId} dir={view.direction} className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 id={view.headingElementId} className="font-semibold">{view.heading}</h2>
        <p className="mt-2 text-sm text-gray-600">{view.message}</p>
      </section>
    );
  }

  // Grouped rather than flattened, because in an attributed review the
  // lead/alternatives split is information the reviewer needs: it is what tells
  // them the second card is an alternative rather than a second instruction. A
  // blind review has one unlabelled group, because a group heading that said
  // "other options" would say which one was not other.
  const groups: readonly { readonly heading: string | null; readonly cards: readonly RenderableCard[] }[] =
    view.mode === 'blind'
      ? [{ heading: null, cards: view.slots.map(fromSlot) }]
      : [
          { heading: null, cards: [fromOption(view.lead)] },
          { heading: view.alternativesHeading, cards: view.alternatives.map(fromOption) },
        ];

  // The live region text. `staged` is local, so the first press announces the
  // standing "nothing is saved" notice; everything else is the server's word.
  const announcement = notice ?? (staged === null ? '' : view.confirmNotice);

  const press = (action: ReviewVerdictAction, position: number) => {
    if (action.requiresConfirmation) {
      setStaged({ verdict: action.verdict, position });
      return;
    }
    setStaged(null);
    onIntent({ verdict: action.verdict, position, stage: 'unconfirmed' });
  };

  const confirm = () => {
    if (staged === null) return;
    onIntent({ verdict: staged.verdict, position: staged.position, stage: 'confirmed' });
    setStaged(null);
  };

  return (
    <section aria-labelledby={view.headingElementId} dir={view.direction} className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 id={view.headingElementId} className="font-semibold">{view.heading}</h2>
      {view.mode === 'attributed' && <p className="mt-1 text-sm text-gray-600">{view.solenessNotice}</p>}
      <p className="mt-2 text-xs text-gray-500">{view.confirmNotice}</p>

      {groups.map((group, groupIndex) => group.cards.length === 0 ? null : (
        <div key={`group-${groupIndex}`}>
        {group.heading !== null && <h3 className="mt-4 text-sm font-semibold">{group.heading}</h3>}
        {group.cards.map((card) => (
        <article key={card.elementId} aria-labelledby={card.elementId} className="mt-4 border-t border-gray-100 pt-3">
          <h3 id={card.elementId} className="text-lg">{card.actionLabel}</h3>
          {card.confidenceLabel !== null && <p className="text-xs text-gray-500">{card.confidenceLabel}</p>}
          <h4 className="mt-2 text-sm font-semibold">{view.whyHeading}</h4>
          <ul className="text-sm text-gray-600">
            {card.whyThisNow.map((line, lineIndex) => (
              <li key={`${card.elementId}-reason-${lineIndex}`}>
                {line.text} {line.basisText}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-labelledby={card.elementId}>
            {view.verdicts.map((action) => (
              <button
                key={action.verdict}
                type="button"
                onClick={() => press(action, card.position)}
                className="rounded-md border border-gray-300 px-3 py-2"
              >
                {action.label}
              </button>
            ))}
          </div>
          {staged !== null && staged.position === card.position && (
            <div className="mt-3 rounded-md bg-gray-50 p-3" role="group" aria-labelledby={card.elementId}>
              <p className="text-sm text-gray-700">{view.confirmPrompt}</p>
              <button type="button" onClick={confirm} className="mt-2 rounded-md bg-gray-800 px-3 py-2 text-sm text-white">
                {view.confirmLabel}
              </button>
              <button type="button" onClick={() => setStaged(null)} className="mt-2 rounded-md border border-gray-300 px-3 py-2 text-sm">
                {view.cancelLabel}
              </button>
            </div>
          )}
        </article>
        ))}
        </div>
      ))}

      {view.mode === 'attributed' && view.excluded.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <h3 className="text-sm font-semibold">{view.excludedHeading}</h3>
          <ul className="text-sm text-gray-600">
            {view.excluded.map((candidate, index) => (
              <li key={`${candidate.actionKind}-${index}`}>
                {candidate.actionLabel}
                {candidate.reasons.map((reason) => ` ${reason.text}`).join('')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="sr-only" aria-live="polite">{announcement}</p>
    </section>
  );
}
