# Spec: what happens to a commitment when its time has passed, and the Gmail sender filter

Owner decisions of 2026-11-12. The fixes are deployed to staging as soon as each is ready, and the QA audit restarts on the new commit.

## Part 1. Commitments whose time has passed

### The defect, root-caused 2026-11-12

Any commitment that is still active stays on Today forever. The behaviour is the same in production (`ee82d011`) and on main (`de7fcb84`).

- **The lists ignore when an item ends.** They never read `endAt` or the event kind (`lib/services/mobile/commitmentService.ts:219, 235-242, 339`).
- **Nothing ever closes a commitment.** No job does it. The one exception is football's nightly `completeEndedFixtures`, and that job skips users who have football switched off.
- **Timed events turn into overdue work.** An event with `timeSpec.kind = scheduled_event` becomes an "overdue" next step (`nextStepBaseline.ts:86, 124`) and a floating 30-minute task in the morning plan (`buildDailyPlan.ts:463-466, 344-347`).

Rolling unfinished work into today was the owner's decision of 2026-09-15 (#383), and it is right for tasks. It was never meant for appointments and meetings.

### Owner's design

1. **Appointments and meetings disappear on their own once they are over.** They leave Today, the upcoming list, the next step, the plan and the widget. The commitment is not deleted: it stays in history.
2. **A place for the things nothing was done about** («ما اتصرّفت فيها»). It holds:
   - appointments and meetings that ended, until the person says what came of them;
   - deadlines that passed while the item was still open.
3. **The capture agent asks, gently.** The next time the person uses capture («احكيها»), the agent first finishes what the person came to say. Then it asks, briefly and with no pressure, about the items in that place. Two examples:
   - «اجتماعك مع … مبارح — طلع منه إشي لازم تعمله؟»
   - «تسليم … كان مبارح — سلّمته؟»

   The answers become normal proposals (new commitments, done, a new date, drop), which the person confirms as usual.
4. **A missed task that is neither a deadline nor an appointment** (for example, studying) goes to rescheduling. The way it is approached changes: the owner's example is «بدل واحد على خمسة، واحد على أربعة». The person is told what changed and can undo it.

### Rules for the build

- **"Ended"** means `endAt` when it is set; otherwise `dueAt` plus 60 minutes for a timed event; for an all-day event, the end of its local day.
- **What counts as an event:** `timeSpec.kind = scheduled_event`, an all-day event, a football fixture, or an item from a calendar feed that is a session and not a deadline.
- **Tasks keep #383.** They roll into Today until the person acts on them.
- **"No pressure"** is enforced in code:
  - at most one follow-up question per capture session;
  - at most 2 items in that question;
  - no item is asked about more than twice;
  - the person can skip, and «لا تسألني عنها» removes the item from the place.
- **Football:** close ended fixtures for every user, including those with football switched off. Close them on the per-minute watcher or the maintenance pass, not only in the nightly sync. Held fixtures whose kickoff has passed disappear (audit finding CA11.1).
- **Cost:** the follow-up question rides the capture chat call that is already being made. There is no extra model call.

### Owner answers of 2026-11-13

- **Event or task (lane E1).** The model decides at capture whether an item is an event (appointment, meeting, lecture) or a task, and stores it on the commitment. The title heuristic (`namesEvent`) is only the fallback when the model was not used, and the stored kind always wins over it. Before the switch, an eval on a labelled set decides the threshold; it costs about 10–20¢ and is approved.
- **Item 4 (lane E4).** «واحد على خمسة → واحد على أربعة» was an example, not a formula. The rule is: **when a piece of work is missed, the app proposes a real, workable new plan for it**, not just a new date. A proposal must:
  - place the work in actual free time, after reading busy time, the plan and the deadline if one exists;
  - change the approach when the old one failed. It may use smaller pieces, more or fewer sessions, a different time of day, or an earlier start before a deadline. Each change is chosen from the miss history, for example a second miss in the same slot means a different slot;
  - say in one line what changed and why;
  - be proposal-only, so nothing changes until the person accepts;
  - offer undo for at least 24 hours after acceptance.

  The proposal is computed deterministically from the free-slot and plan engines. A model may word it, but it never chooses the slots.

### Delivery order

1. **Lane E1:** ended events leave every active surface (server lists, next step, plan, week plan; mobile Today composer, card fallback, widget snapshot), plus the football closure for everyone. Tests use the dates from the root-cause scratch test: a lecture 3 weeks ago, yesterday's all-day doctor appointment, and this morning's 09–10 meeting.
2. **Lane E2:** the «ما اتصرّفت فيها» place. Server projection, an API route, and a screen reachable from Today.
3. **Lane E3:** the capture follow-up question, using the no-pressure rules above.
4. **Lane E4:** a real rescheduling proposal for missed work, following the owner's answer of 2026-11-13 above.

## Part 2. Gmail sender filter (owner idea, stricter variant chosen)

**The problem.** Many mails come from senders that never produce a commitment (for example, AliExpress order and shipping mail). Mail in the Updates category is kept by bulk rule 2, so this mail is read, and paid for, every time.

### Rules

- **A sender joins the person's skip list** after **5** mails from that exact address were fully read and produced no observation and no commitment. The list is per person.
- **A subject joins the skip list** when the same normalised subject arrives from the same sender **5** times with nothing produced. Normalising strips `Re:` and `Fwd:`, folds case, and replaces digits with `#`, so order numbers do not make subjects look different.
- **Mail from a skipped sender or subject is never read again** (outcome `skipped_sender`, cost 0) until the address changes, because a new address is a new key.
- **Never skipped:**
  - replies and forwards (triage rule 2);
  - mail from any address the person has ever replied to (SENT check);
  - starred mail.
- **Audit sample.** A deterministic 5% of skipped mail is read anyway. If an audited mail produces anything, the sender or subject leaves the list at once, and the miss is logged without content.
- **Visible and reversible.** Settings → Gmail lists «ما بنقرالهم» (the address and how many mails were skipped), and any entry can be removed.
- **Storage:**
  - `users/{uid}/gmailSenderStats/{hmac(address)}` holds the counts and the address for display;
  - subjects are stored only as an HMAC;
  - everything is deleted with the account;
  - the privacy page's Gmail section gains one sentence about this list.
- **Quality gate before enabling.** Replay the rule over the owner's golden set in `~/.config/maybesitter/golden-mail/`. None of the 9 commitments may come from a skipped sender or subject.
- **Flag:** `MAYBESITTER_GMAIL_SENDER_FILTER`, off by default; on in staging after the replay passes.
