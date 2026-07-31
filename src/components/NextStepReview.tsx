'use client';

import { useState } from 'react';
import type { NextStepDecision, NextStepRecommendationContract } from '@/contracts/v1/nextStepContracts';

const COPY = {
  en: { heading: 'One possible next step', why: 'Why this one', empty: 'No next step yet.', insufficient: 'There is not enough evidence to suggest a next step.', accept: 'Choose', edit: 'Edit', defer: 'Later', dismiss: 'Dismiss', done: 'Already done', confirm: 'Confirm before anything is saved.' },
  ar: { heading: 'خطوة تالية محتملة', why: 'لماذا هذه الخطوة', empty: 'لا توجد خطوة تالية الآن.', insufficient: 'لا توجد معلومات كافية لاقتراح خطوة تالية.', accept: 'اختيار', edit: 'تعديل', defer: 'لاحقاً', dismiss: 'تجاهل', done: 'تمت بالفعل', confirm: 'يلزم التأكيد قبل حفظ أي شيء.' },
  he: { heading: 'צעד הבא אפשרי', why: 'למה הצעד הזה', empty: 'אין כרגע צעד הבא.', insufficient: 'אין מספיק מידע כדי להציע צעד הבא.', accept: 'בחירה', edit: 'עריכה', defer: 'אחר כך', dismiss: 'סגירה', done: 'כבר בוצע', confirm: 'נדרש אישור לפני שמירה.' },
} as const;

export default function NextStepReview({ proposal, onDecision }: { proposal: NextStepRecommendationContract; onDecision: (decision: NextStepDecision) => void }) {
  const [announced, setAnnounced] = useState('');
  const copy = COPY[proposal.locale];
  const direction = proposal.locale === 'en' ? 'ltr' : 'rtl';
  if (proposal.state !== 'ready' || !proposal.primaryStep || !proposal.explanation) {
    return <section aria-labelledby="next-step-title" dir={direction}><h2 id="next-step-title">{copy.heading}</h2><p>{proposal.state === 'empty' ? copy.empty : copy.insufficient}</p></section>;
  }
  const choose = (decision: NextStepDecision) => {
    onDecision(decision);
    setAnnounced(decision === 'defer' || decision === 'dismiss' ? copy.empty : copy.confirm);
  };
  return (
    <section aria-labelledby="next-step-title" dir={direction} className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 id="next-step-title" className="font-semibold">{copy.heading}</h2>
      <p className="mt-2 text-lg">{proposal.primaryStep.title}</p>
      <h3 className="mt-3 text-sm font-semibold">{copy.why}</h3>
      <p className="text-sm text-gray-600">{proposal.explanation.summary}</p>
      <p className="mt-2 text-xs text-gray-500">{copy.confirm}</p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={copy.heading}>
        {proposal.availableActions.map((action) => <button key={action} type="button" onClick={() => choose(action)} className="rounded-md border border-gray-300 px-3 py-2">{copy[action]}</button>)}
      </div>
      <p className="sr-only" aria-live="polite">{announced}</p>
    </section>
  );
}
