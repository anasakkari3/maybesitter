# 05 — Behavioral interview guide

Issue #54. 45 minutes. Print this and [the note template](08-interview-note-template.md) together.

The whole study rests on one distinction: **what a person did** versus **what a person says they
would do**. Only the first is evidence. A participant can be genuinely enthusiastic about the idea
and still have no recurring problem, and that combination is the single most common way a founder
talks themselves into building the wrong thing. This guide is built to make that failure visible
rather than comfortable.

Every question below asks about a past event. Nothing describes MaybeSitter until the interview is
over.

---

## Banned questions

Do not ask these, in any wording, at any point:

- "Would you use this?" / "Would you pay for this?"
- "Do you like this idea?" / "What do you think of this?"
- "Would it help if something reminded you?"
- "How useful would a tool that…?"
- "Does that sound like something you'd want?"
- "Do you struggle with ADHD?" or any question seeking a diagnosis.
- Anything containing "imagine", "suppose", "if there were", or "in the future".

If a participant asks what you're building, use the deflection in
[07-interviewer-instructions.md](07-interviewer-instructions.md) and answer properly at the end.

If you catch yourself having asked one, write it in the note. A leading question contaminates the
answers after it, and the coder needs to know.

## The four probes

Almost everything in this guide is one of these, repeated:

1. **"Tell me about the last time…"** — anchors to a real event.
2. **"What did you do?"** — behavior, not intention.
3. **"What happened then?"** — consequence, not feeling.
4. **"Why did you stop?"** — the abandonment story, where the real requirements are.

When a participant generalises — "I usually forget things" — bring them back: *"Take the most recent
one. What was it?"*

---

## Block 0 — Frame and consent (3 min)

Read [03-consent-script.md](03-consent-script.md) verbatim. Record the C8 answers before continuing.
There is no recording, so say so and warn about the typing pauses.

Then set expectations:

> I'll mostly ask about specific things that already happened. If a question feels oddly precise,
> that's deliberate — I'm trying to avoid asking you to predict yourself, because nobody is good at
> that. And I'll be typing, so if I go quiet it's me catching up.

## Block 1 — Ordinary week (3 min)

Warm-up. Establishes vocabulary and gives you the participant's own words to reuse later.

> **1.1** Walk me through last Tuesday. Not a typical day — last Tuesday specifically.
>
> **1.2** Where did the things you had to do that day come from? Who or what put them there?

Listen for where commitments arrive from: messages, verbal requests, email, their own head. Don't
code anything yet.

## Block 2 — The last slip (12 min) — the core of the interview

This block produces `past_behavior_example` and most of `concrete_cost`. Give it the time. If you
run out of interview, cut Block 5 or Block 6, never this one.

> **2.1** Tell me about the last important commitment that slipped — you forgot it, missed it, or
> knew about it and couldn't get started. When was it?
>
> **2.2** Walk me through what actually happened, from when you first knew about it.
>
> **2.3** Where was it written down, if anywhere? [If nowhere:] Where was it living?
>
> **2.4** What did you do when you realised?
>
> **2.5** What happened then? What did it cost you?
>
> **2.6** Who else was affected?
>
> **2.7** How did it get resolved, in the end? Or is it still open?

### Probing for concrete cost

You need at least one consequence that can be stated as a fact. Probe once, then accept the answer
you get:

| They say | You ask |
| --- | --- |
| "It was really stressful." | "And what happened because of that?" |
| "I felt terrible about it." | "What did you have to do afterwards?" |
| "It was fine in the end." | "What did making it fine cost you?" |
| "Nothing really happened." | Accept it. Code `concrete_cost=no`. This is a real data point. |

Do **not** keep pushing until they produce a cost. A manufactured cost is worse than a `no`.

### If they cannot recall any slip

> **2.8** Let's go back further. When was the last time something like that happened at all?

If the answer is "months ago" or "never", that is a clean negative. Finish the interview properly
— the workflow, tools, and privacy blocks are still valuable — and code
`recurring_weekly_pain=no`. Do not shorten the interview because the answer is inconvenient; the
participant gave you their time and the negative is evidence.

## Block 3 — Frequency and pattern (5 min)

This block produces `recurring_weekly_pain`.

> **3.1** In the last four weeks, how many other times did something like that happen?
>
> **3.2** Tell me about the one before the one we just discussed.
>
> **3.3** Are these the same kind of thing each time, or different kinds?
>
> **3.4** Is there a pattern to when it happens — certain days, certain kinds of task, certain
> times of day?

The threshold is **weekly**: roughly four or more occurrences in four weeks, or the participant
independently describing it as a weekly-or-more pattern. Three in four weeks with no second example
is not weekly. See [10-coding-rubric.md](10-coding-rubric.md) for the exact rule.

Ask 3.2 even if 3.1 gives you a number. A person who says "constantly" but cannot produce a second
concrete example has given you a feeling, not a frequency.

## Block 4 — Current workflow, demonstrated (7 min)

This block produces `current_workflows`, and part of the competitive baseline.

> **4.1** Show me where that commitment would have been recorded, if you'd recorded it. Share your
> screen or just describe it.
>
> **4.2** Walk me through what you actually do when something new arrives — from hearing it to it
> being somewhere.
>
> **4.3** How many different places does this stuff live right now?
>
> **4.4** When you sit down and don't know what to do first, what do you actually do?
>
> **4.5** What's the last thing you added? Show me.

Screen-sharing is far better than description here. People systematically over-describe their
systems: the calendar with three stale entries and the notes app with 200 unsorted lines is the
truth. Note what you observe, not what they claim.

## Block 5 — Abandoned tools and payment history (7 min)

This block produces `abandoned_tool`, `paid_for_related_tool`, and `switching_pain`. It is where the
commercial cohort proves itself.

> **5.1** What tools have you tried for this and stopped using?
>
> **5.2** Take the most recent one you dropped. How long did you use it?
>
> **5.3** What was happening in the week you stopped? What was the last straw?
>
> **5.4** Did you stop deliberately, or did it just fade?
>
> **5.5** What have you paid for — apps, subscriptions, a coach, a course, a planner? What did it
> cost and how long did you keep paying?
>
> **5.6** What made you cancel, if you cancelled?
>
> **5.7** When you moved from one tool to another, what did you have to redo by hand?
>
> **5.8** What stopped you from trying something new the last time you thought about it?

5.3 and 5.4 matter more than they look. "It just faded" is the normal death of a productivity tool
and describes exactly the failure mode this product would face. Write down the last straw verbatim
in substance, not in words.

For 5.5, an unremembered subscription still counts as paid behavior; a free tier does not.

## Block 6 — Competitive baseline (5 min)

Run [06-competitive-baseline-questions.md](06-competitive-baseline-questions.md) here in full. It
produces `preferred_baseline` and feeds the #57 competitive evidence.

## Block 7 — Privacy boundaries (4 min)

This block produces `privacy_boundary`. Still behavioral: ask about what they have refused, not what
they would refuse.

> **7.1** Tell me about the last time you decided not to give an app some kind of access. What was
> it asking for?
>
> **7.2** What did you do instead?
>
> **7.3** Which apps currently have access to your calendar? Do you know why you granted it?
>
> **7.4** Has an app ever told you something about yourself that felt wrong, intrusive, or
> judgmental? What was it, and what did you do?
>
> **7.5** Is there anything you would simply not put into an app, whatever it offered?

7.4 is the invasiveness signal that #57 later measures directly. Record the category — a
notification, a summary, a "you haven't done X in N days" nudge — not the wording.

## Block 8 — Close (3 min)

> **8.1** Is there anything about this that I should have asked and didn't?
>
> **8.2** [Pilot-contact consent — read the closing script in
> [03-consent-script.md](03-consent-script.md).]
>
> **8.3** [Only now, if they ask:] Here's what I'm working on. [One or two plain sentences. No
> pitch, no demo, no promises. It is fine to say "an early tool that turns things you type in into
> one next step, and it may not survive this research."]

Thank them. Confirm the withdrawal deadline and how to reach you.

---

## Timing card

| Block | Minutes | Cumulative | Produces |
| --- | ---: | ---: | --- |
| 0 Consent | 3 | 3 | `adult_confirmed`, `research_consent_recorded` |
| 1 Ordinary week | 3 | 6 | context |
| 2 Last slip | 12 | 18 | `past_behavior_example`, `concrete_cost` |
| 3 Frequency | 5 | 23 | `recurring_weekly_pain` |
| 4 Workflow | 7 | 30 | `current_workflows` |
| 5 Abandoned & paid | 7 | 37 | `abandoned_tool`, `paid_for_related_tool`, `switching_pain` |
| 6 Competitive | 5 | 42 | `preferred_baseline` |
| 7 Privacy | 4 | 46 | `privacy_boundary` |
| 8 Close | 3 | 49 | `pilot_contact_consent_recorded` |

Forty-nine minutes against a forty-five-minute booking is deliberate: blocks 1 and 8 compress
without loss. If you are behind at the 30-minute mark, cut Block 1 retrospectively and shorten
Block 5 to 5.1, 5.3, and 5.5.

## Before you close the call

Confirm you can answer these from your notes. If not, ask now:

- [ ] Do I have one specific past event with a date or rough date?
- [ ] Do I have a second, separate example, or an explicit frequency?
- [ ] Do I have at least one consequence I could state as a fact — or a clear "nothing happened"?
- [ ] Do I know what they use today, ideally from having seen it?
- [ ] Do I know what they abandoned and why?
- [ ] Do I know what they paid for, or that they paid for nothing?
- [ ] Do I have a baseline comparison?
- [ ] Did I ask the pilot-contact question separately, at the end?
