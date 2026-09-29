import { describe, expect, it } from '@jest/globals';
import { meetingPrepResponseSchema } from '../../../api/schemas/meetings';
import { reminderSettingsResponseSchema } from '../../../api/schemas/reminders';
import type { Commitment } from '../../../api/schemas/common';
import { planFor } from '../../reminders/policy';
import { toEngineSettings, toReminderCommitments } from '../../reminders/reminderInputs';
import preparedFixture from '../../../api/__fixtures__/meetings.prepared.json';
import preparedGeminiFixture from '../../../api/__fixtures__/meetings.preparedGemini.json';
import preparedNoReminderFixture from '../../../api/__fixtures__/meetings.preparedNoReminder.json';
import settingsFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';
import commitmentFixture from '../../../api/__fixtures__/commitments.one.json';

/**
 * When the phone rings for a confirmed prep step (CL5a I-1).
 *
 * The phone's reminder engine rings a lead before a commitment's deadline
 * (`reminderInputs.ts`, `startOf`). The server's promise is "a reminder an hour
 * before the meeting", so the prep step it proposes is *due by* one lead after
 * that hour (`prep.dueAt`) and shown at that hour (post-UAT FX1): confirming
 * stores the Review time as `timeSpec.dueAt` and the deadline as `endAt` (the
 * server's pipeline test holds that half). This runs the engine the phone runs
 * on the step as the route recorded it, with the account's default settings.
 */
const MINUTE = 60_000;

function confirmedPrepStep(fixture: unknown): { commitment: Commitment; startAt: string } {
  const { prep, proposal } = meetingPrepResponseSchema.parse(fixture);
  const base = commitmentFixture as Commitment;
  const commitment: Commitment = {
    ...base,
    id: prep.itemId,
    status: 'active',
    postponedUntil: null,
    timeSpec: { ...base.timeSpec, kind: 'due_by', dueAt: proposal.items[0]!.resolvedTime!, remindAt: prep.remindAt, endAt: prep.dueAt, allDay: false },
  };
  return { commitment, startAt: prep.startAt };
}

describe('the prep step rings an hour before the meeting', () => {
  it.each([
    ['rules', preparedFixture],
    ['model', preparedGeminiFixture],
  ])('%s: the first local reminder is at the start minus 60 minutes', (_engine, fixture) => {
    const { commitment, startAt } = confirmedPrepStep(fixture);
    const dto = reminderSettingsResponseSchema.parse(settingsFixture).reminderSettings;
    const settings = toEngineSettings(dto, 'softAwareness');
    const [reminder] = toReminderCommitments([commitment]);
    const planned = planFor(reminder!, settings);
    expect(planned.length).toBeGreaterThan(0);
    const first = Math.min(...planned.map((stage) => stage.at));
    expect((Date.parse(startAt) - first) / MINUTE).toBe(60);
  });

  it('the recorded prep step is the first item, and is due at the meeting, not before it', () => {
    for (const fixture of [preparedFixture, preparedGeminiFixture]) {
      const { proposal, prep } = meetingPrepResponseSchema.parse(fixture);
      expect(prep.itemId).toBe(proposal.items[0]!.itemId);
      expect(Date.parse(prep.dueAt)).toBeLessThanOrEqual(Date.parse(prep.startAt));
      expect(prep.remindAt).not.toBeNull();
      expect(Date.parse(prep.dueAt)).toBeGreaterThan(Date.parse(prep.remindAt!));
    }
  });
});

describe('a prep step with reminders switched off (CL5a I-3; FX1 R1)', () => {
  it('the recorded response claims none, and the phone, run on it, schedules none', () => {
    const { commitment } = confirmedPrepStep(preparedNoReminderFixture);
    const { prep, proposal } = meetingPrepResponseSchema.parse(preparedNoReminderFixture);
    expect(prep.remindAt).toBeNull();
    expect(prep.silentBecause).toBe('reminders_off');
    // Due by the meeting's start, and shown — as everywhere — before it (FX1),
    // never at the start, inside the meeting it prepares for.
    expect(prep.dueAt).toBe(prep.startAt);
    expect(Date.parse(proposal.items[0]!.resolvedTime!)).toBeLessThan(Date.parse(prep.startAt));
    const dto = reminderSettingsResponseSchema.parse(settingsFixture).reminderSettings;
    const settings = toEngineSettings({ ...dto, softEnabled: false }, 'softAwareness');
    const [reminder] = toReminderCommitments([commitment]);
    expect(planFor(reminder!, settings)).toEqual([]);
  });

  it('twenty minutes out with reminders on, it rings at the time shown, whatever the lead (R1)', () => {
    const { commitment } = confirmedPrepStep(preparedNoReminderFixture);
    const { proposal } = meetingPrepResponseSchema.parse(preparedNoReminderFixture);
    const dto = reminderSettingsResponseSchema.parse(settingsFixture).reminderSettings;
    const [reminder] = toReminderCommitments([commitment]);
    for (const lead of [15, 30, 60]) {
      const planned = planFor(reminder!, toEngineSettings({ ...dto, softLeadMinutes: lead }, 'softAwareness'));
      expect(planned.map((stage) => stage.at)).toEqual([Date.parse(proposal.items[0]!.resolvedTime!)]);
    }
  });
});
