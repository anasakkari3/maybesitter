# Closed-test interview kit

For the closed test that starts around 2026-10-28. Five short instruments, all about
**what people actually did with the build**, never what they say they would do. This
follows the principle of the v03 study
([`../v03/05-interview-guide.md`](../v03/05-interview-guide.md)): only past behaviour is
evidence.

What changed since v03: people now have a real build in their hands, so the interviews
observe use of the build. The v03 guide's "one next step" closing and its fixed
ChatGPT baselines are **not** used here.

## Before any interview

- **Interview consent** follows the existing script,
  [`../v03/03-consent-script.md`](../v03/03-consent-script.md). Consent to talk is not
  consent to be recorded; ask about recording separately.
- **Usage measurement is not interview consent.** Looking at a tester's usage data from
  the build needs the closed-test research consent (X9 option C), which is
  **BLOCKED ON COUNSEL**. Until counsel approves it, interviews use only what the person
  tells and shows you on their own screen, with their permission, in the moment.
- Notes use the v03 template ([`../v03/08-interview-note-template.md`](../v03/08-interview-note-template.md)).
  No names in notes. Quotes are kept word for word in the person's language. Translate
  beside them, never instead of them.
- Nothing here is shown to anyone outside the team without explicit, per-quote consent.

## Banned questions (all instruments)

Do not ask these, in any wording:

- "Would you use this?" / "Would you pay for this?" / "How much would you pay?"
- "Do you like the AI?" / "Do you like this?" / "What do you think of the idea?"
- "Do you have ADHD?" or anything that asks for a diagnosis or health information.
- "What features should we add?" / "What's missing?" (the wish list).
- Anything with "imagine", "suppose", "would it help if", or "in the future".

If you slip, write it in the note. A leading question contaminates the answers after it.

The four probes, repeated everywhere:
1. "Tell me about the last time…"
2. "What did you do?"
3. "What happened then?"
4. "Can you show me?"

## Who gets which instrument

| Person | When | Instrument | Length |
|---|---|---|---|
| Tester with 3 or more confirmed commitments | day 3–5, and day 14 | A. Activation | 15 min |
| Tester with fewer than 2 captures, or 5 days without opening the app | as soon as that's true | B. Non-activation | 10 min |
| Every tester | day 14 (with A or B) | C. Trust & privacy | 5–8 min |
| Every tester, and anyone at a recruitment table | first contact | D. 5-second positioning test | 2 min |
| Every interview | woven in | E. Language mining | — |

Report every result with its denominator ("4 of 9"), split by language and by the
outside-network flag. Don't round a small sample into a percentage.

---

## A. Activation interview (the tester is using it)

The product's activation hypothesis (X6) is the **first kept commitment**: something
captured and confirmed, then resolved on purpose (done, moved or dropped) on a later day.
This interview checks whether that moment is real and what it felt like.

1. "Open MaybeSitter and show me the last thing you put in." *(watch; don't help)*
2. "Before you had this, where would that have gone? Notes, a message to yourself, your
   head, somewhere else?"
3. "Tell me about the last time something you'd put in here came due. What did you do in
   the next ten minutes?"
4. "Show me something you moved or dropped. What happened that day?"
5. "What's on Today right now that you skip past?"
6. "Tell me about the last time you *didn't* put something in here that you could have.
   What happened?"
7. "What did you stop doing since you installed it, if anything?"
8. "Last time you opened it, what made you open it?"

Code afterwards: the first kept commitment (yes/no, which day); the alternative it
replaced; whether a reminder led to an action; whether moving or dropping felt like relief
or failure (use their words).

## B. Non-activation interview (the tester stalled)

1. "Walk me through the first time you opened it. Where did you stop?" *(let them scroll
   back through it)*
2. "Tell me about the last thing you promised someone this week. Where did you keep it?"
3. "What did you do instead of putting it in here?"
4. "Was there a moment it asked for something you didn't want to give?" If needed, probe
   the steps they actually reached: the language choice, sign-in, the three consent
   questions, the routine questions, the setup chat, notifications.
5. "Did it ever send you a reminder? What happened?"
6. "Is it still on your phone? Why, or why not?"

Code afterwards: the exact step where they stopped; what they used instead; any trust or
effort objection in their own words.

## C. Trust & privacy

1. "What did you decide *not* to tell it?" "What made you decide that?"
2. "Who do you think can read what you put in here?" *(don't correct them until the end)*
3. "Show me where you'd look to see what it keeps about you." *(watch: do they find the
   Memory / Trust screens?)*
4. "When it asked about AI at the start, what did you pick? What made you pick that?"
5. At the very end, explain plainly what the privacy policy says about AI processing and
   where data is kept, then ask: "Does any of that change how you'll use it?" *(record
   the reaction; don't argue with it)*

Flag immediately if any tester describes something the app said about them as judgmental
or invasive. The adaptive labels are being removed (X5) for exactly this reason. If one
still appears, note which build.

## D. The 5-second positioning test

Tests the two open arms: A "No overdue pile." and B "Say it once. It lands in your day."

1. Show **one** arm's landing page (the `?v=a` or `?v=b` link) on your phone for 5
   seconds, then put it away. Alternate arms between people and log which one each saw.
2. Ask, in this order, without prompting:
   - "What does it do?"
   - "Who is it for?"
   - "What's different about it?"
3. Record the answers word for word.

Scoring, per arm, with its denominator:
- **Understood:** the answer to "what does it do" mentions planning, reminders,
  commitments or equivalent.
- **Mechanism recalled:** the answer to "what's different" names the arm's idea (no
  overdue pile / say it once and it's in your day).
- **Misread:** anything else. An arm where 40% or more misread fails.

**Day-7 recall (testers only):** "What's different about MaybeSitter?" with no page shown.
If under 30% of testers can say what's different, **neither line is working**: revise the
mechanism, not the audience (the tripwire in the positioning test spec).

## E. Language mining

Ask in the person's language, and don't translate for them.

- "When you tell a friend that something slipped, what exactly do you say?"
- "What do you call the place where you keep these things?"
- "The last time you looked for an app like this, what did you type into the store or Google?"
- Whenever someone code-switches between Arabic, Hebrew and English, note the exact words
  in each language.

Collected phrases go to the owner for the next revision of `.agents/product-marketing.md`
("Customer language"). Only consented, anonymised quotes may ever appear in public.

## Pricing: not yet

Pricing research (Van Westendorp, then a real "would you take a slot at ₪X" ask) is **out
of scope for this kit**. It waits for activation data (X11) and for the X9 ruling,
because pricing events are analytics.
