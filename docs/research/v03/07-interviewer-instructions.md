# 07 — Interviewer instructions

Issue #54. Read fully before your first interview. Reread section "Ten failure modes" weekly.

You are the founder interviewing people about a problem you want to exist. That is the central
methodological hazard of this study and no script fixes it on its own. Everything below exists to
put friction between what you hope to hear and what you write down.

---

## Your job in one line

Collect what happened, in enough detail that a second person could code it the same way you did,
without you having steered the participant toward the answer.

## Settled, and two things that are not

Compensation is **75 ILS per completed interview, unconditional**. There is **no recording** — audio
or video — only structured written notes. Retention and withdrawal follow the policy in
[README.md](README.md). Sampling defaults are approved. Diagnosis status is not collected.

Two gates remain, and neither can be closed by tooling:

- **`SECOND_CODER_NAME` — unassigned.** A named human. AI assistance does not count as independent
  double coding. Rehearsals may proceed without one; **the fifth sampled interview may not be
  completed without one.**
- **`CAMPUS_ETHICS_STATUS = unresolved`.** No recruitment through university or college channels
  until Anas determines whether approval or notification is required. Non-institutional routes and
  the commercial cohort are unaffected.

## Before the first interview

- [ ] Read [the interview guide](05-interview-guide.md) aloud once, alone, timing yourself.
- [ ] Confirm [the consent script](03-consent-script.md) and
      [the privacy explanation](04-privacy-explanation.md) still contain no participant-facing
      placeholders. A placeholder left in a consent document is a consent defect.
- [ ] Set up the research drive: two trackers, a notes folder, and the identity↔pseudonym map in a
      **separate** location with separate access. The map also holds contact details and the
      compensation log.
- [ ] Arrange how you will actually pay 75 ILS, before you owe it to anyone.
- [ ] Run two rehearsal interviews with people who will never be in the sample. Code them
      `sample_inclusion=rehearsal`. Fix your wording afterwards. Rehearsals do not count and are
      excluded from every denominator by the intake tool.
- [ ] Assign the second coder before the fifth sampled interview.

## Before each interview

- [ ] Allocate 45 minutes plus 20 minutes afterwards for coding. Do not book back-to-back.
- [ ] Have the guide and a fresh [note template](08-interview-note-template.md) open.
- [ ] Assign the next pseudonymous ID from the sequence; write it at the top of the note **before**
      the call. Never write their name on the note, not even temporarily.
- [ ] Check what cohort they were tagged as at screening. Do not revisit that decision now.
- [ ] Close everything showing MaybeSitter. A visible logo or mockup contaminates the interview.

## During the interview

**Ask, then stop talking.** Count three seconds after they seem finished. The most useful sentence
in an interview is usually the one that follows a silence you did not fill.

**Chase the specific.** Any generalisation gets one redirect: *"Take the most recent one. What was
it?"* If they generalise again, note that they could not produce a specific example — that is
itself a coding-relevant observation.

**Use their words, not yours.** If they say "stuff piles up", ask about "stuff piling up". Never
introduce "overwhelm", "executive function", "task initiation", "system", or "workflow" first. If
you introduce a word, note it — the coder needs to know the term was yours.

**Never confirm or reward an answer.** No "exactly", "that's so interesting", "that's what everyone
says", "yes, that's the problem". Neutral acknowledgement only: "mm", "got it", "and then?"

**Never explain the product mid-interview.** If asked:

> I'll tell you properly at the end — I'd rather not put ideas in your head first, because then I'd
> just be measuring my own pitch.

Then answer honestly at 8.3.

**Never correct their workflow.** Do not suggest a tool, a setting, or a technique, even if the fix
is obvious and you want to be kind. You would be intervening in the thing you're measuring. If they
directly ask for advice, offer it after the interview is over and note that you did.

**Do not ask about diagnosis.** If a participant volunteers one, acknowledge briefly and write
nothing. If they describe symptoms in clinical terms, record the behavior, not the label.

**If a participant becomes distressed.** This topic touches shame for many people. Stop the
questions. Say: *"Let's pause — we can stop entirely or skip ahead, whichever you prefer."* Do not
counsel, diagnose, reassure with claims about their situation, or continue because the interview is
nearly done. If they want to stop, stop and treat it as a withdrawal offer, not a data loss. Note
the pause in the note and nothing about the content of the distress. If someone raises self-harm or
a crisis, end the interview, say plainly that you are not a clinician and cannot help with this, and
offer to send local support-service information afterwards.

**Write while they talk, not from memory.** There is no recording to fall back on, which is the
point — it forces the note to be made in the room rather than reconstructed later, and memory
reconstructs toward the hypothesis within minutes. Tell participants at C4 that the pauses are you
typing. Slow the interview down rather than skipping the note; if you are consistently unable to
keep up, cut Block 1, not the note.

## Immediately after each interview

- [ ] **Pay the 75 ILS**, whatever happened. Someone who reported no problem, failed to qualify,
      declined pilot contact, or stopped halfway is paid exactly the same. Log the payment with the
      identity map, never in a tracker. Delaying payment for participants whose answers were
      unhelpful is the quiet version of paying for answers.
- [ ] Spend 10 minutes completing the note while it is fresh. Fill the coding block last.
- [ ] Code the row into the interview evidence tracker **within 24 hours**. Coding a week of
      interviews in one sitting produces drift, and drift is invisible to you.
- [ ] Update the candidate's recruitment-tracker row: `linked_interview_id`, and
      `pilot_contact_consent_recorded` from the closing question.
- [ ] Write one line in the note about anything that went wrong: a leading question you asked, a
      block you cut, a technical failure, an interruption.

## Weekly

- [ ] Run `npm run research:v03-intake`. Fix `blockers` before the next interview.
- [ ] Have `SECOND_CODER_NAME` independently code that week's double-coding sample — 20% of analysed
      interviews, never fewer than 6 in total (see [10-coding-rubric.md](10-coding-rubric.md)).
      Adjudicate disagreements the same week.
- [ ] Check the cohort balance and the `personal_network` share. Both are easier to correct at
      interview 12 than at interview 30.
- [ ] Reread the banned-question list.

## Ten failure modes, and what to do instead

| Failure | What it looks like | Instead |
| --- | --- | --- |
| Leading | "So that must have been frustrating?" | "What happened then?" |
| Hypothetical drift | "Would a reminder have helped?" | "What did you do when you realised?" |
| Pitching | Explaining the product to get a reaction | Deflect; explain at 8.3 |
| Accepting a feeling as a cost | "It was stressful" coded as concrete cost | Probe once, then code `no` |
| Accepting "constantly" as a frequency | No second example, coded weekly | Ask 3.2; no example, no weekly |
| Rescuing | Suggesting a tool that would fix it | Say nothing; offer after the interview |
| Cohort drift | Moving someone to `commercial` to hit the minimum | Cohort is fixed at screening |
| Batch coding | Coding ten interviews on Sunday | Code within 24 hours |
| Filling silence | Adding "…or maybe you just forgot?" | Count to three |
| Stopping early on a negative | Cutting the interview when they have no problem | Finish it; negatives are evidence |

## Stop conditions

Stop fieldwork and notify the owner (yourself, in writing, in the #54 thread) if any of these occur:

- A consent step was missed or a participant later says they did not understand it.
- Contact details, names, or a transcript reach a tracker cell or a Git-tracked file.
- The identity↔pseudonym map is exposed, shared, or copied to an uncontrolled location.
- A participant reports harm or distress attributable to the study.
- You realise you have been asking a leading question systematically — recode the affected
  interviews with the second coder before continuing.
- The intake tool reports a blocker you cannot explain.

Record the stop, the cause, and the resolution in the #54 thread with no participant detail.

## What you may never do

- Write a participant's name, contact details, employer, or diagnosis anywhere except the
  identity↔pseudonym map.
- Commit a tracker, a note, or the map to Git.
- Create, estimate, or "reconstruct" a row for an interview that did not happen, or for a
  participant who withdrew.
- Change a code after seeing how it affects the rate. If a recode is genuinely warranted, do it with
  the second coder and record it in the disagreement log.
- Interview anyone under 18, or anyone with a stake in MaybeSitter.
- Report a result outside the 30–40 window as a decision.
- Record audio or video, however convenient it would be.
- Ask for, or write down, a diagnosis.
- Make the payment conditional on anything, or delay it for an unhelpful participant.
- Recruit through institutional campus channels while `CAMPUS_ETHICS_STATUS = unresolved`.
- Complete a fifth sampled interview while `SECOND_CODER_NAME` is unassigned, or count your own
  second pass — or an AI's — as independent double coding.
