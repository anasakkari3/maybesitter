# 03 — Consent script

Issue #54. Read at the start of every interview, including rehearsals. Takes about two minutes.

Read it aloud rather than paraphrasing. Paraphrase drifts, and the drift always goes in the
direction of making consent easier to give.

Nothing is written into the trackers until C8 is answered yes. If the participant declines, close
the call politely, set `screener_outcome=declined`, and write nothing else.

---

## Script

> Before we start, a short statement. It takes two minutes and I'd rather over-explain it.
>
> **C1 — What this is.** I'm doing research on how people handle commitments that slip. I'm going to
> ask you about things that already happened in your last few weeks. There's nothing to try and
> nothing to buy, and I'm not going to show you a product or ask you to react to an idea.
>
> **C2 — What I'm not doing.** I'm not a clinician, this isn't a medical or psychological
> assessment, and nothing here is advice or treatment. I'm not asking about diagnoses, and if one
> comes up I won't write it down.
>
> **C3 — What I write down.** I take notes under a code, not your name. The notes describe what
> happened and what it cost — not your words verbatim, and no names of people, employers, or places.
> Your contact details are stored separately from your answers and are never published, shared, or
> put into the project's files. What eventually gets published is counts: how many of thirty-odd
> people reported a particular pattern.
>
> **C4 — No recording.** I'm not recording any audio or video. I'll be typing structured notes as
> we talk, so there will be some pauses while I catch up — that's me writing, not me judging.
>
> **C5 — How long I keep things.** Your contact details are deleted 30 days after I finish
> recruiting, unless you separately tell me I may contact you in future. The notes with any
> identifying detail are turned into codes and then deleted, at the latest 30 days after the project
> review this feeds into. The coded, de-identified counts are kept until a later market review plus
> 90 days. That's my own working policy for this study — I'm not making any legal claim about it.
>
> **C6 — Your control.** You can skip any question without saying why. You can stop the interview at
> any moment. You can withdraw afterwards and I'll delete your notes and the code that links them to
> you — up until the point where the data has been de-identified and locked for the aggregate
> analysis, after which there's no longer anything traceable to you that I could pull out. I'll tell
> you when that point is coming. You don't have to give a reason and nothing happens as a result.
>
> **C7 — Payment.** You get 75 shekels for completing the interview, however it goes. It doesn't
> depend on your answers, on whether you turn out to fit the study, or on anything you say about the
> idea. If you stop halfway I'll still pay you.
>
> **C8 — Two confirmations, please, out loud.**
>
> 1. Are you 18 or older?
> 2. Are you willing to be interviewed on those terms?
>
> **C9 — A separate question, at the end of the interview.** Later I'll ask whether I may contact
> you about a small closed test of an early tool. That's a different decision from this one. Saying
> no to it doesn't affect today, and saying yes today doesn't commit you to it.
>
> **C10 — Questions?** Anything you want to ask before we start?

---

## Pilot-contact consent — asked at the end, never here

Ask this **after** the last interview question, once the participant knows what they've actually
told you. Asking at the start turns the interview into a qualifying round for early access and
biases every answer that follows.

> That's everything. One separate question, and no is a perfectly good answer.
>
> We may run a small closed test — 25 to 40 people — of an early, deliberately narrow tool. It's not
> ready and it may never be. May I contact you once about it when it exists?
>
> This is a different permission from the interview. If you say no, nothing about today changes, and
> I still use what you told me today in the study — anonymously and as a count.
>
> [If yes:] Thank you. What's the best way to reach you? I'll store that separately from everything
> you told me today.

Record the answer in `pilot_contact_consent_recorded`. Never infer it from enthusiasm, from "sure,
sounds interesting", or from someone having asked what you're building.

---

## What gets recorded, and where

| Item | Tracker cell | Value if the participant says no |
| --- | --- | --- |
| C8.1 adult | `adult_confirmed` | `no` → stop, no interview |
| C8.2 research consent | `research_consent_recorded` | `no` → stop, no interview |
| C9 / closing pilot question | `pilot_contact_consent_recorded` | `no` → interview still counts fully |
| C7 payment | compensation log in the identity map, never a tracker cell | paid regardless |

An interview row cannot be coded unless `research_consent_recorded=yes` and `adult_confirmed=yes` —
the intake tool rejects the row, by design.

Contact details go in the identity↔pseudonym map on the research drive. Never in a tracker cell:
the intake tool rejects any cell containing an `@`, a long number sequence, or a URL.

---

## Withdrawal

Withdrawal is available until the dataset has been de-identified and locked for aggregate analysis.
Tell participants when that point is approaching rather than letting the window close silently.
After the lock there is no longer a link between a person and a row, so there is nothing to remove —
say that plainly instead of implying deletion is still possible.

If a participant withdraws, at any point before the lock, by any means:

1. Reply with **R8** in [02-recruitment-messages.md](02-recruitment-messages.md). Do not ask why and
   do not attempt to retain them.
2. Delete the interview note and the participant's row from the identity↔pseudonym map.
3. Delete the interview row from the interview evidence tracker. It leaves the denominator
   entirely — a withdrawn interview is not a "no" answer, and keeping it as one is falsification.
4. Set `pilot_status=withdrawn`, `withdrawn_at` to the UTC time, and `deletion_completed=yes` once
   the deletion has actually run. The intake tool requires the timestamp.
5. If they were already in the closed pilot, follow the deletion path in
   [../../operations/V03_CLOSED_PILOT_RUNBOOK.md](../../operations/V03_CLOSED_PILOT_RUNBOOK.md).
6. Note the withdrawal count in the #54 comment. A high withdrawal rate is itself a finding.

---

## Short forms for the bilingual cohort

Read in the participant's chosen language, then confirm C8 in that language. Full English text above
remains the reference; these cover C1–C8 compactly.

### العربية

> قبل أن نبدأ: هذا بحث عن كيفية تعامل الناس مع التزامات تفوتهم. سأسألك عن أمور حدثت فعلًا خلال
> الأسابيع الماضية. لا يوجد منتج لتجربته ولا شيء للشراء.
>
> لستُ مختصًا طبيًا، وهذه ليست جلسة تقييم أو علاج، ولن أسأل عن تشخيص ولن أدوّنه إن ذُكر.
>
> ملاحظاتي مكتوبة برمز بدل اسمك، دون اقتباس حرفي ودون أسماء أشخاص أو أماكن أو جهات عمل. معلومات
> التواصل تُحفظ منفصلة عن إجاباتك. ما يُنشَر لاحقًا هو أعداد فقط.
>
> لا يوجد أي تسجيل صوتي أو مرئي. سأكتب ملاحظات منظَّمة أثناء حديثك، لذلك ستكون هناك وقفات قصيرة
> ريثما أُنهي الكتابة.
>
> مدّة الحفظ: تُحذف معلومات التواصل بعد ٣٠ يومًا من انتهاء التجنيد، إلا إذا وافقت صراحةً على
> التواصل مستقبلًا. الملاحظات التي تحتوي تفاصيل تعريفية تُحوَّل إلى رموز ثم تُحذف خلال ٣٠ يومًا على
> الأكثر بعد قرار المراجعة. الأعداد المرمَّزة وغير المعرِّفة تُحفَظ حتى مراجعة السوق اللاحقة زائد ٩٠
> يومًا. هذه سياسة عملي في هذه الدراسة، وليست ادّعاءً قانونيًا.
>
> يمكنك تخطّي أي سؤال، أو التوقّف في أي لحظة، أو الانسحاب لاحقًا فأحذف ملاحظاتك — دون إبداء أي سبب —
> وذلك حتى اللحظة التي تُجرَّد فيها البيانات من التعريف وتُقفَل للتحليل التجميعي، وعندها لا يبقى شيء
> يمكن ربطه بك لإزالته. سأُعلمك قبل اقتراب هذه اللحظة.
>
> التعويض: ٧٥ شيكل مقابل إتمام المقابلة، بغضّ النظر عن إجاباتك أو عن ملاءمتك للدراسة. وإذا توقّفت
> في منتصفها فسأدفع لك أيضًا.
>
> سؤالان بصوت واضح: هل عمرك ١٨ سنة أو أكثر؟ وهل توافق على إجراء المقابلة بهذه الشروط؟

### עברית

> לפני שנתחיל: זהו מחקר על האופן שבו אנשים מתמודדים עם התחייבויות שנשמטות. אשאל אותך על דברים שקרו
> בפועל בשבועות האחרונים. אין מוצר לנסות ואין מה לקנות.
>
> אינני איש מקצוע רפואי, זו אינה הערכה או טיפול, לא אשאל על אבחנה ולא ארשום אותה אם תעלה.
>
> הרישומים שלי נכתבים תחת קוד ולא תחת שמך, בלי ציטוט מילולי ובלי שמות של אנשים, מקומות או מקומות
> עבודה. פרטי הקשר נשמרים בנפרד מהתשובות. מה שיפורסם בהמשך הוא מספרים בלבד.
>
> אין שום הקלטת אודיו או וידאו. אכתוב רישומים מובנים תוך כדי השיחה, ולכן יהיו הפסקות קצרות בזמן
> שאני משלים את הכתיבה.
>
> משך השמירה: פרטי הקשר נמחקים 30 יום לאחר סיום הגיוס, אלא אם אישרת במפורש פנייה עתידית. רישומים
> שמכילים פרטים מזהים מומרים לקודים ואז נמחקים, לכל המאוחר 30 יום לאחר החלטת הביקורת. הספירות
> המקודדות והבלתי-מזהות נשמרות עד לביקורת השוק המאוחרת יותר ועוד 90 יום. זו מדיניות העבודה שלי
> במחקר הזה, ואינה טענה משפטית.
>
> אפשר לדלג על כל שאלה, להפסיק בכל רגע, או לחזור בך בהמשך ואמחק את הרישומים — בלי לתת שום סיבה —
> וזאת עד לרגע שבו הנתונים עוברים דה-זיהוי וננעלים לניתוח מצרפי, שממנו והלאה לא נותר דבר שניתן
> לקשר אליך ולהסיר. אודיע לך לפני שהרגע הזה מתקרב.
>
> תגמול: 75 ש"ח על השלמת הריאיון, ללא תלות בתשובות שלך או בהתאמתך למחקר. גם אם תפסיק/י באמצע,
> אשלם.
>
> שתי שאלות, בקול: האם את/ה בן/בת 18 ומעלה? והאם את/ה מסכים/ה להתראיין בתנאים האלה?
